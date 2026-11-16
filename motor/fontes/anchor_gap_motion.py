"""Recover short internal head losses only when forward/backward appearance tracking agrees."""
import copy,math,time
import cv2
import numpy as np

METHOD='bidirectional-csrt-head-gap-v1'

def agree(forward,backward):
 if len(forward)!=len(backward)or not forward:return False,999.
 worst=0.
 for a,b in zip(forward,backward):
  ac=np.array([a[0]+a[2]/2,a[1]+a[3]/2]);bc=np.array([b[0]+b[2]/2,b[1]+b[3]/2])
  error=float(np.linalg.norm(ac-bc)/max(1.,math.sqrt(a[2]*a[3])));worst=max(worst,error)
  if error>.3 or not(.67<=a[2]/max(1,b[2])<=1.5 and .67<=a[3]/max(1,b[3])<=1.5):return False,worst
 return True,worst

def _crowded(row):
 b=row['headBounds']
 for face in row.get('otherFaces',[]):
  if b['left']<=face['x']<=b['right']and b['top']<=face['y']<=b['bottom']:return True
 return False

def visible_rectangle(box,width,height):
 x,y,w,h=map(float,box);left,top=max(0.,x),max(0.,y);right,bottom=min(float(width),x+w),min(float(height),y+h)
 if right-left<8 or bottom-top<8 or (right-left)*(bottom-top)<w*h*.65:return None
 return np.array([left,top,right-left,bottom-top],float)

def restore_full_rectangle(tracked,visible,full):
 x,y,w,h=map(float,tracked);vx,vy,vw,vh=visible;fx,fy,fw,fh=full
 return (x+(fx-vx)*w/vw,y+(fy-vy)*h/vh,fw*w/vw,fh*h/vh)

def _tracker(frames,box,cancelled):
 params=cv2.TrackerCSRT_Params();params.template_size=100;params.number_of_scales=17;params.admm_iterations=2
 tracker=cv2.TrackerCSRT_create(params);tracker.init(frames[0][1],tuple(round(v)for v in box));boxes=[tuple(box)]
 for t,image in frames[1:]:
  if cancelled and cancelled():
   import anchor_rosto as R
   raise R.Cancelado('Análise cancelada.')
  ok,current=tracker.update(image)
  if not ok:return boxes
  boxes.append(current)
 return boxes

def bridge(runs,job,fps,mfps,step,plan,cancelled=None):
 import anchor_rosto as R
 started=time.perf_counter();report=dict(method=METHOD,attempted=0,accepted=0,rejected=[],measuredFrames=0,recoveredSequenceFrames=0,seconds=0.,details=[])
 if len(runs)<2:return runs,[],report
 ordered=sorted(runs,key=lambda g:g[0]['time']);result=[ordered[0]];extra=[]
 clocks=[(t,float(o['time']))for t,g,i,o in plan]
 for following in ordered[1:]:
  previous=result[-1];left,right=previous[-1],following[0];gap=right['time']-left['time']
  if gap>1.5 or gap<1.5/fps or _crowded(left)or _crowded(right):
   report['rejected'].append(dict(start=left['time'],end=right['time'],reason='long-or-crowded'));result.append(following);continue
  left_frames={round((r['time']-job['inPoint'])*fps):r for r in previous};right_frames={round((r['time']-job['inPoint'])*fps):r for r in following}
  left_clock=[(t,rt)for t,rt in clocks if round((rt-job['inPoint'])*fps)in left_frames]
  right_clock=[(t,rt)for t,rt in clocks if round((rt-job['inPoint'])*fps)in right_frames]
  if not left_clock or not right_clock:result.append(following);continue
  t0,lt=max(left_clock);t1,rt=min(right_clock);a=left_frames[round((lt-job['inPoint'])*fps)];z=right_frames[round((rt-job['inPoint'])*fps)]
  if not 0<t1-t0<=1.6:result.append(following);continue
  report['attempted']+=1;cap=None
  try:
   cap,rate,vw,vh=R.abrir_video(job['mediaPath'],True);frames=[];width=min(960,vw);height=round(vh*width/vw)
   def needed(t):return round((t-job['inPoint'])*mfps)%step==0 or abs(t-t0)<.5/mfps or abs(t-t1)<.5/mfps
   for t,image in R.quadros(cap,rate,t0,t1+1/mfps,needed):
    if cancelled and cancelled():raise R.Cancelado('Análise cancelada.')
    if image is not None and t<=t1+.45/mfps:frames.append((t,cv2.resize(image,(width,height))))
   if not frames or abs(frames[0][0]-t0)>.55/mfps or abs(frames[-1][0]-t1)>.55/mfps:
    report['rejected'].append(dict(start=t0,end=t1,reason='clock-mismatch'));result.append(following);continue
   sx,sy=width/job['width'],height/job['height']
   def rectangle(row):
    b=row['headBounds'];return np.array([b['left']*sx,b['top']*sy,(b['right']-b['left'])*sx,(b['bottom']-b['top'])*sy],float)
   ba,bz=rectangle(a),rectangle(z)
   va,vz=visible_rectangle(ba,width,height),visible_rectangle(bz,width,height)
   if va is None or vz is None:
    report['rejected'].append(dict(start=t0,end=t1,reason='insufficient-visible-head'));result.append(following);continue
   forward=[restore_full_rectangle(b,va,ba)for b in _tracker(frames,va,cancelled)]
   backward=list(reversed([restore_full_rectangle(b,vz,bz)for b in _tracker(frames[::-1],vz,cancelled)]))
   accepted,error=agree(forward,backward)
   if len(forward)!=len(frames)or not accepted:
    report['rejected'].append(dict(start=t0,end=t1,reason='bidirectional-disagreement',error=error));result.append(following);continue
   boxes=(np.array(forward,float)+np.array(backward,float))*.5;start_error=boxes[0]-ba;end_error=boxes[-1]-bz
   keys={};measured=[]
   def proportions(row):
    b=row['headBounds'];w=b['right']-b['left'];h=b['bottom']-b['top']
    return np.array([(row['x']-b['left'])/w,(row['y']-b['top'])/h,row['width']/w,row['height']/h,
     (row['trackingPoint']['x']-b['left'])/w,(row['trackingPoint']['y']-b['top'])/h,
     (row['faceTrackingPoint']['x']-b['left'])/w,(row['faceTrackingPoint']['y']-b['top'])/h])
   pa,pz=proportions(a),proportions(z)
   for index,(t,image)in enumerate(frames):
    u=(t-t0)/(t1-t0);b=boxes[index]-(1-u)*start_error-u*end_error;b=b/np.array([sx,sy,sx,sy]);geometry=pa*(1-u)+pz*u
    frame=round((t-job['inPoint'])*fps)
    if frame<=max(left_frames)or frame>=min(right_frames):continue
    x,y,w,h=map(float,b)
    row=dict(time=job['inPoint']+frame/fps,x=x+geometry[0]*w,y=y+geometry[1]*h,width=geometry[2]*w,height=geometry[3]*h,
     confidence=min(.75,a['confidence'],z['confidence']),source='tracked',interpolated=False,
     trackingPoint=dict(x=x+geometry[4]*w,y=y+geometry[5]*h),faceTrackingPoint=dict(x=x+geometry[6]*w,y=y+geometry[7]*h),
     headBounds=dict(left=x,top=y,right=x+w,bottom=y+h,source='face-propagated'),headVisibility=dict(occluded=True,groups=0),
     headGapMotion=METHOD)
    keys[frame]=row;measured.append(dict(time=row['time'],sourceTime=t,mediaFrame=round(t*mfps),source='tracked',method=METHOD))
   endpoint_left=max(left_frames);endpoint_right=min(right_frames);keys[endpoint_left]=left;keys[endpoint_right]=right;indices=sorted(keys);new=[]
   for frame in range(endpoint_left+1,endpoint_right):
    if frame in keys:new.append(keys[frame]);continue
    at=int(np.searchsorted(indices,frame));lo,hi=indices[at-1],indices[at];r0,r1=keys[lo],keys[hi];u=(frame-lo)/(hi-lo);row=copy.deepcopy(r0)
    row.update(time=job['inPoint']+frame/fps,source='interpolated',interpolated=True)
    for k in['x','y','width','height','confidence']:row[k]=float(r0[k]*(1-u)+r1[k]*u)
    for k in['trackingPoint','faceTrackingPoint']:row[k]={axis:float(r0[k][axis]*(1-u)+r1[k][axis]*u)for axis in['x','y']}
    row['headBounds']={k:float(r0['headBounds'][k]*(1-u)+r1['headBounds'][k]*u)for k in['left','top','right','bottom']};row['headBounds']['source']='face-propagated';row['headGapMotion']=METHOD;new.append(row)
   result[-1]=previous+new+following;extra.extend(measured);report['accepted']+=1;report['measuredFrames']+=len(measured);report['recoveredSequenceFrames']+=len(new);report['details'].append(dict(start=t0,end=t1,error=error,readFrames=len(frames),newSamples=len(measured)))
  except cv2.error as error:
   report['rejected'].append(dict(start=t0,end=t1,reason='tracker-error',error=str(error)[:200]));result.append(following)
  finally:
   if cap is not None:cap.release()
 report['seconds']=time.perf_counter()-started
 return result,extra,report
