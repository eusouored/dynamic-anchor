"""Small bounded-window tracker and guarded application, isolated candidate."""
import copy,hashlib,os
from bisect import bisect_left
import numpy as np
import cv2
from anchor_visual_guards import evaluate,overlaps_other

def contains_time(sorted_times, value, tolerance=1e-7):
 i=bisect_left(sorted_times,value)
 return ((i<len(sorted_times) and abs(value-sorted_times[i])<tolerance) or
         (i>0 and abs(value-sorted_times[i-1])<tolerance))

class StoredFrame:
 def __init__(self,spool,index,shape,dtype):
  self.spool=spool;self.index=index;self.shape=shape;self.dtype=dtype;self.nbytes=0
 def load(self):
  values=list(self.spool.get(self.index))
  if len(values)!=1:raise RuntimeError('Incomplete visual frame')
  return np.frombuffer(values[0],dtype=self.dtype).reshape(self.shape)

def image_array(image):return image.load() if isinstance(image,StoredFrame) else image

class Continuity:
 def __init__(self,width,height,cancelled=None):
  from anchor_visual_window import WindowCollector
  self.width=width;self.height=height;self.cancelled=cancelled or (lambda:False);self.windows=[];self.pending=[];self.pending_bytes=0;self.pending_limit=96*1024*1024;self.diagnostic=os.environ.get('ANCHOR_OFFICE_DIAGNOSTIC')=='1'
  from anchor_visual_spool import Spool
  self.spool=Spool(cancelled=self.cancelled)
  self.memory_bytes=0;self.memory_limit=128*1024*1024
  self.disabled_reason=None;self.collection_stopped_reason=None
  self.collector=WindowCollector(self._defer,cancelled=self.cancelled,spill=lambda image:self._store_frame(image,True))
 def disable(self,reason):
  self.disabled_reason=reason;self.windows=[];self.close()
 def _store_frame(self,image,force_disk=False):
  if isinstance(image,StoredFrame):return image
  if not force_disk and self.memory_bytes+image.nbytes<=self.memory_limit:
   self.memory_bytes+=image.nbytes;return image
  index=self.spool.put([memoryview(image).cast('B')])
  return StoredFrame(self.spool,index,image.shape,image.dtype)
 @staticmethod
 def reduce(image):
  """Gray analysis image of a frame. Stateless: may be computed ahead on another thread."""
  h,w=image.shape[:2]; outw=min(960,w); outh=max(1,round(h*outw/w))
  return cv2.resize(cv2.cvtColor(image,cv2.COLOR_BGR2GRAY),(outw,outh),interpolation=cv2.INTER_LINEAR)
 def add(self,time,image,bounds,visibility,hair_count,others,gray=None):
  if self.cancelled():raise RuntimeError('Visual continuity cancelled')
  if self.disabled_reason is not None or self.collection_stopped_reason is not None:return
  if gray is None:gray=self.reduce(image)
  self.collector.max_bytes=self.pending_limit
  from anchor_visual_spool import SpoolCapacityError
  try:
   self.collector.add(time,gray,bounds,visibility,hair_count,others)
  except (SpoolCapacityError,OSError) as error:
   # Refinement is optional. A full/unavailable temporary disk must not erase
   # a valid base trajectory or turn the whole analysis into a failure.
   self.collection_stopped_reason='storage-budget' if isinstance(error,SpoolCapacityError) else 'storage-unavailable'
   self.collector.discarded+=1;self.collector.abort()
 def _defer(self,records):
  meta=[]
  for r in records:
   item={k:v for k,v in r.items() if k!='image'};item['image']=self._store_frame(r['image']);meta.append(item)
  self.pending.append(meta)
 def close(self):
  self.collector.abort();self.pending=[];self.memory_bytes=0;self.spool.close()
 def finalize(self,result):
  if self.disabled_reason is not None:return
  samples=[float(s['sourceTime']) for s in result['analysisSamples']];sorted_samples=sorted(samples)
  try:
   for meta in self.pending:
    if self.cancelled():raise RuntimeError('Visual continuity cancelled')
    selected=[r for r in meta if contains_time(sorted_samples,r['time'])]
    if not selected or selected[0] is not meta[0] or selected[-1] is not meta[-1]:continue
    required=[t for t in samples if meta[0]['time']-1e-7<=t<=meta[-1]['time']+1e-7]
    if len(required)!=len(selected) or any(abs(t-r['time'])>=1e-7 for t,r in zip(required,selected)):
     self.collector.discarded+=1;continue
    self._track(selected)
  finally:self.close()
 def _track(self,records):
  # Pixel storage and each interval are already bounded. An arbitrary window
  # count must not abort a long clip after its 128th small correction.
  h,w=records[0]['image'].shape; sx=w/self.width;sy=h/self.height
  if any(r['image'].shape!=(h,w) for r in records):return
  class RejectWindow(Exception):pass
  def seed_box(record):
   seed=record['bounds']; hw=seed['right']-seed['left'];hc=(seed['left']+seed['right'])/2
   bw=max(8,round(hw*.85*sx/8)*8);bh=max(8,round(hw*.45*sy/8)*8)
   box=(round(hc*sx-bw/2),round(seed['top']*sy),bw,bh)
   return box if box[0]>=0 and box[1]>=0 and box[0]+bw<=w and box[1]+bh<=h else None
  def world_box(box):return [box[0]/sx,box[1]/sy,box[2]/sx,box[3]/sy]
  def check_identity(box,record):
   if overlaps_other(world_box(box),record['others']):raise RejectWindow('identity-overlap')
  width=float(np.median([r['bounds']['right']-r['bounds']['left'] for r in (records[0],records[-1])]))
  def follow(items,trial=False):
   box=seed_box(items[0]);bw,bh=box[2:]
   p=cv2.TrackerCSRT_Params();p.use_color_names=False;p.use_rgb=False;p.use_gray=True;p.number_of_scales=1;p.template_size=120;p.admm_iterations=4
   tracker=None
   if not trial:
    tracker=cv2.TrackerCSRT_create(p);tracker.init(cv2.cvtColor(image_array(items[0]['image']),cv2.COLOR_GRAY2BGR),box)
   rows=[{'time':items[0]['time'],'box':[box[0]/sx,box[1]/sy,box[2]/sx,box[3]/sy],'ok':True}]
   previous=image_array(items[0]['image']);hardbox=box;hardtime=items[0]['time'];bias=np.zeros(2);cheap=full=0
   for r in items[1:]:
    if self.cancelled():raise RuntimeError('Visual continuity cancelled')
    current=image_array(r['image']);x,y,bw,bh=map(int,box);radius=6;ncc=None
    if x-radius>=0 and y-radius>=0 and x+bw+radius<=w and y+bh+radius<=h and min(bw,bh)>8:
     template=previous[y:y+bh,x:x+bw];search=current[y-radius:y+bh+radius,x-radius:x+bw+radius]
     if template.std()>=8:
      corr=cv2.matchTemplate(search,template,cv2.TM_CCOEFF_NORMED);_,score,_,loc=cv2.minMaxLoc(corr);dx,dy=loc[0]-radius,loc[1]-radius
      if score>=.98 and 0<loc[0]<2*radius and 0<loc[1]<2*radius:
       new=current[y+dy:y+dy+bh,x+dx:x+dx+bw];backsearch=previous[y+dy-radius:y+dy+bh+radius,x+dx-radius:x+dx+bw+radius]
       if new.shape[:2]==(bh,bw) and backsearch.shape[:2]==(bh+2*radius,bw+2*radius):
        backcorr=cv2.matchTemplate(backsearch,new,cv2.TM_CCOEFF_NORMED);_,backscore,_,backloc=cv2.minMaxLoc(backcorr)
        if backscore>=.98 and abs(dx+backloc[0]-radius)<=1 and abs(dy+backloc[1]-radius)<=1:ncc=(x+dx,y+dy,bw,bh)
    budget=min(box[2:])*.1
    refresh=ncc is None or abs(r['time']-hardtime)>=.25 or np.linalg.norm(np.array(ncc[:2])-np.array(hardbox[:2]))>budget
    if refresh:
     # A failed cheap trial restarts the calibrated pass from its original
     # anchor. Never initialize CSRT midway through an occlusion.
     if trial:return None
     ok,raw=tracker.update(cv2.cvtColor(current,cv2.COLOR_GRAY2BGR));full+=1
     if not ok:raise RejectWindow('tracker-lost')
     if ncc is not None:box=ncc;bias=np.array(ncc[:2])-np.array(raw[:2]);method='ncc-refresh'
     else:box=(float(raw[0]+bias[0]),float(raw[1]+bias[1]),raw[2],raw[3]);method='csrt'
     hardbox=box;hardtime=r['time']
    else:ok=True;box=ncc;cheap+=1;method='ncc'
    check_identity(box,r)
    x,y,bw,bh=box;rows.append({'time':r['time'],'box':[x/sx,y/sy,bw/sx,bh/sy],'ok':bool(ok),'method':method});previous=current
   return rows
  try:
   for anchor in (records[0],records[-1]):
    box=seed_box(anchor)
    if box is None:raise RejectWindow('out-of-frame-anchor')
    check_identity(box,anchor)
   forward=follow(records,trial=True)
   if forward is None:forward=follow(records)
   # The backward seed is already known. A failed forward endpoint closure
   # cannot be rescued by computing the backward pass.
   final=forward[-1]['box'];back_seed=world_box(seed_box(records[-1]))
   end_center=np.asarray([final[0]+final[2]/2,final[1]+final[3]/2])
   seed_center=np.asarray([back_seed[0]+back_seed[2]/2,back_seed[1]+back_seed[3]/2])
   if np.linalg.norm(end_center-seed_center)>.12*width:raise RejectWindow('closure-or-disagreement')
   reverse_records=list(reversed(records));backward=follow(reverse_records,trial=True)
   if backward is None:backward=follow(reverse_records)
   backward=list(reversed(backward))
  except RejectWindow as error:
   self.windows.append({'rejected':str(error),'start':records[0]['time'],'end':records[-1]['time']})
   return
  except cv2.error:
   return
  if len(forward)==len(backward)==len(records):
   self.windows.append({'forward':forward,'backward':backward,'others':[r['others'] for r in records],
    'width':float(np.median([r['bounds']['right']-r['bounds']['left'] for r in (records[0],records[-1])])),
    'diagnostic':({'times':[float(r['time']) for r in records], 'imageSha256':[hashlib.sha256(memoryview(image_array(r['image'])).cast('B')).hexdigest() for r in records], 'imageShape':[int(h),int(w)],'anchorBounds':[copy.deepcopy(records[0]['bounds']),copy.deepcopy(records[-1]['bounds'])], 'anchorHairCount':[int(records[0]['hair_count']),int(records[-1]['hair_count'])]} if self.diagnostic else None)})
 def apply(self,result):
  if self.cancelled():raise RuntimeError('Visual continuity cancelled')
  if self.disabled_reason is not None:return [{'accepted':False,'reason':self.disabled_reason}]
  groups=[result['rows']]+[s['rows'] for s in result.get('segments',[]) if not s.get('primary')]
  report=[]
  if any(r.get('headMotion') for rows in groups for r in rows):return [{'accepted':False,'reason':'headwear-reference-protected'}]
  if any(x.get('accepted') for x in result.get('stats',{}).get('headReferenceRepair',[])):
   return [{'accepted':False,'reason':'existing-reference-repair-protected'}]
  # The decoder owns source PTS; output rows own sequence times. Reuse the
  # engine's actual sample mapping rather than assuming identical clocks.
  samples=sorted(result['analysisSamples'],key=lambda s:s['sourceTime'])
  source_times=[s['sourceTime'] for s in samples]
  def map_times(forward):
   mapped=[]
   for point in forward:
    lo=bisect_left(source_times,point['time']-1e-7)
    matches=[]
    while lo<len(samples) and source_times[lo]<point['time']+1e-7:
     if abs(source_times[lo]-point['time'])<1e-7:matches.append(samples[lo]['time'])
     lo+=1
    if len(matches)!=1:return None
    mapped.append(matches[0])
   mapped=np.asarray(mapped,float)
   return mapped if np.isfinite(mapped).all() and (np.diff(mapped)>0).all() else None
  group_times=[np.asarray([r['time'] for r in rows],float) for rows in groups]
  for win in self.windows:
   if self.cancelled():raise RuntimeError('Visual continuity cancelled')
   if 'rejected' in win:
    report.append({'accepted':False,'reason':win['rejected'],'earlyRejected':True,'start':win['start'],'end':win['end']});continue
   f=win['forward'];ft=map_times(f)
   if ft is None:report.append({'accepted':False,'reason':'ambiguous-sample-clock'});continue
   matches=[]
   for rows,times in zip(groups,group_times):
    a=np.flatnonzero(np.isclose(times,ft[0],rtol=0,atol=1e-7));b=np.flatnonzero(np.isclose(times,ft[-1],rtol=0,atol=1e-7))
    if len(a)==len(b)==1 and a[0]<b[0]:matches.append((rows,times,a[0],b[0]))
   if len(matches)!=1:report.append({'accepted':False,'reason':'missing-anchors'});continue
   rows,times,a,b=matches[0]
   base=lambda row:[row['trackingPoint']['x'],row['trackingPoint']['y']]
   visual,decision=evaluate(f,win['backward'],base(rows[a]),base(rows[b]),win['width'],win['others'])
   if self.diagnostic:decision.update({'start':float(f[0]['time']),'end':float(f[-1]['time']),'headWidth':win['width'],'forward':f,'backward':win['backward'],'inputs':win['diagnostic']})
   report.append(decision)
   if visual is None:continue
   indices=np.arange(a,b+1);pts=np.column_stack([np.interp(times[indices],ft,visual[:,k]) for k in (0,1)])
   for i,p in zip(indices,pts):rows[i]['trackingPoint']={'x':float(p[0]),'y':float(p[1])}
  return report
