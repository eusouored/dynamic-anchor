"""Conservative framing-point repair; never adds reads or changes face/head observations."""
import bisect,math,time

METHOD='bounded-contour-reference-v2'
MAX_INTERVAL_SECONDS=.5
TRIGGER_RESIDUAL_FRACTION=.10
TRUSTED_RESIDUAL_FRACTION=.12
MAX_CORRECTION_FRACTION=.5
MIN_LOCAL_IMPULSE_FRACTION=.10

def repair(rows,cancelled=None):
 started=time.perf_counter();report={'method':METHOD,'accepted':[],'rejected':[],'rejectedCount':0,'correctedRows':0};output=rows
 def reject(t,reason):
  report['rejectedCount']+=1
  if len(report['rejected'])<20:report['rejected'].append({'time':t,'reason':reason})
 def geometry(row):
  # 0.5.4: mesma referência vertical do trajeto (topo + metade da altura lenta), quando conhecida.
  b=row['headBounds'];h=row.get('_headReferenceHeight')
  y=min(max(b['top']+h/2,b['top']),b['bottom'])if isinstance(h,(int,float))and math.isfinite(h)and h>0 else(b['top']+b['bottom'])/2
  return b,(b['left']+b['right'])/2,y,max(1,min(b['right']-b['left'],b['bottom']-b['top']))
 def trusted(row):
  b,x,y,size=geometry(row);v=row.get('headVisibility')or{};p=row['trackingPoint']
  return row.get('source')!='interpolated'and b.get('source')=='segmented'and v.get('occluded')is False and v.get('groups',0)>=2 and math.hypot(p['x']-x,p['y']-y)<=size*TRUSTED_RESIDUAL_FRACTION
 anchors=[i for i,row in enumerate(rows)if trusted(row)];measured=[i for i,row in enumerate(rows)if row.get('source')in('detected','tracked')];seen=set()
 for i,row in enumerate(rows):
  if cancelled and i%256==0 and cancelled():
   import anchor_rosto as R
   raise R.Cancelado('Análise cancelada.')
  if(row.get('headVisibility')or{}).get('occluded')is not True:continue
  current,cx,cy,size=geometry(row);point=row['trackingPoint']
  if current.get('source')=='segmented'or math.hypot(point['x']-cx,point['y']-cy)<=size*TRIGGER_RESIDUAL_FRACTION:continue
  # A curved, continuously moving head is not an isolated detector error.
  # Check immediate real measurements, independently of the wider trusted-
  # contour interval. Reconstructed intermediate rows cannot vote as reads.
  m=bisect.bisect_left(measured,i)
  # 0.5.1: a row after the last real measurement (end of the take) has no neighbor
  # on the right; bisect returns len(measured) there and the old test indexed past the end.
  if not m or m>=len(measured)-1 or measured[m]!=i:continue
  before,after=rows[measured[m-1]],rows[measured[m+1]];span=after['time']-before['time']
  if not 0<span<=MAX_INTERVAL_SECONDS+1e-7:continue
  u=(row['time']-before['time'])/span;prediction={k:before['trackingPoint'][k]*(1-u)+after['trackingPoint'][k]*u for k in('x','y')}
  impulse=math.hypot(*(prediction[k]-point[k]for k in('x','y')))/size
  if impulse<=MIN_LOCAL_IMPULSE_FRACTION:continue
  at=bisect.bisect_left(anchors,i)
  if not at or at==len(anchors):reject(row['time'],'unbounded');continue
  lo,hi=anchors[at-1],anchors[at]
  if(lo,hi)in seen:continue
  seen.add((lo,hi));left,right=rows[lo],rows[hi];dt=right['time']-left['time']
  if not 0<dt<=MAX_INTERVAL_SECONDS+1e-7:reject(row['time'],'duration');continue
  ba,ax,ay,_=geometry(left);bz,zx,zy,_=geometry(right)
  if any(r.get('otherFaces')for r in rows[lo:hi+1]):reject(row['time'],'other-faces');continue
  if not all(.67<=(ba[b]-ba[a])/(bz[b]-bz[a])<=1.5 for a,b in[('left','right'),('top','bottom')]):reject(row['time'],'anchor-shape-disagreement');continue
  da={k:left['trackingPoint'][k]-v for k,v in[('x',ax),('y',ay)]};dz={k:right['trackingPoint'][k]-v for k,v in[('x',zx),('y',zy)]};candidates=[];residual=0.;failure=None
  for j in range(lo+1,hi):
   r=rows[j];b,x,y,s=geometry(r);u=(r['time']-left['time'])/dt;linear={k:left['trackingPoint'][k]*(1-u)+right['trackingPoint'][k]*u for k in['x','y']};residual=max(residual,math.hypot(*(linear[k]-r['trackingPoint'][k]for k in['x','y']))/s)
   # A bridge must not replace a confident internal observation merely because
   # its deliberate head/face offset kept it out of the endpoint anchor set.
   if b.get('source')=='segmented'and(r.get('headVisibility')or{}).get('occluded')is False:continue
   p={k:v+da[k]*(1-u)+dz[k]*u for k,v in[('x',x),('y',y)]};correction=math.hypot(*(p[k]-r['trackingPoint'][k]for k in['x','y']))
   if not all(math.isfinite(v)for v in p.values())or not(b['left']<=p['x']<=b['right']and b['top']<=p['y']<=b['bottom']):failure='outside-existing-bounds'
   if correction>s*MAX_CORRECTION_FRACTION:failure='correction-too-large'
   candidates.append((j,p,correction))
  if failure or residual<TRIGGER_RESIDUAL_FRACTION:reject(row['time'],failure or'no-outlier');continue
  candidates=[c for c in candidates if c[2]>1e-6]
  if not candidates:continue
  if output is rows:output=list(rows)
  for j,p,correction in candidates:output[j]={**rows[j],'trackingPoint':p}
  report['correctedRows']+=len(candidates);report['accepted'].append({'start':left['time'],'end':right['time'],'trigger':row['time'],'localImpulseFraction':impulse,'rows':len(candidates),'maxCorrectionPixels':max(c[2]for c in candidates),'reason':'isolated-measured-reference-error-during-occlusion'})
 report['seconds']=time.perf_counter()-started
 return output,report
