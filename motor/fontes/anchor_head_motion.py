"""Correct contour/reference disagreement with already measured headwear motion."""
import numpy as np
METHOD='selected-headwear-flow-residual-v1'
TAU_SECONDS=.4

def stabilize(run,tau=TAU_SECONDS):
 observed=[(i,r)for i,r in enumerate(run)if r['headBounds']['source']=='segmented'];stats=dict(method=METHOD,edges=0,adjustedMeasurements=0,maxCorrectionPixels=0.,clampedRows=0)
 flagged=[j for j,(_,r)in enumerate(observed)if r.get('headVisibility',{}).get('occluded')is True]
 stats['occludedMeasurements']=len(flagged)
 if len(observed)<2 or not flagged or not any(r.get('headMotion')for _,r in observed):return stats
 points=np.array([[r.get('headMotionBasePoint',r['trackingPoint'])[a]for a in ('x','y')]for _,r in observed],float);weights=np.zeros(len(observed)-1);residuals=np.zeros((len(weights),2))
 for j in range(1,len(observed)):
  row=observed[j][1];before=observed[j-1][1];motion=row.get('headMotion');dt=row['time']-before['time'];grid=(run[1]['time']-run[0]['time'])if len(run)>1 else 1/60
  if 0<dt<=.251:weights[j-1]=(tau/dt)**2*.25
  if not motion or not 0<dt<=.251 or abs(motion['fromTime']-before['time'])>grid*.75+1e-6 or abs(motion['toTime']-row['time'])>grid*.75+1e-6:continue
  matrix=np.asarray(motion['matrix'],float)
  if matrix.shape!=(2,3)or not np.isfinite(matrix).all()or motion['features']<8 or motion['inliers']<max(8,motion['features']*.5):continue
  predicted=matrix[:,:2]@points[j-1]+matrix[:,2];residuals[j-1]=predicted-points[j];weights[j-1]=(tau/dt)**2*min(1.,motion['inliers']/motion['features']);stats['edges']+=1
 if not stats['edges']:return stats
 diagonal=np.ones(len(points));diagonal[:-1]+=weights;diagonal[1:]+=weights;off=-weights;rhs=np.zeros_like(points);rhs[:-1]-=weights[:,None]*residuals;rhs[1:]+=weights[:,None]*residuals
 for i in range(1,len(points)):
  factor=off[i-1]/diagonal[i-1];diagonal[i]-=factor*off[i-1];rhs[i]-=factor*rhs[i-1]
 correction=np.empty_like(points);correction[-1]=rhs[-1]/diagonal[-1]
 for i in range(len(points)-2,-1,-1):correction[i]=(rhs[i]-off[i]*correction[i+1])/diagonal[i]
 times=np.array([r['time']for _,r in observed]);gate=np.zeros(len(observed))
 for j in flagged:
  lo,hi=np.searchsorted(times,[times[j]-.15,times[j]+.15]);gate[lo:hi]=np.maximum(gate[lo:hi],np.maximum(0.,1.-np.abs(times[lo:hi]-times[j])/.15))
 for j,(_,row)in enumerate(observed):
  bounds=row['headBounds'];limit=np.array([bounds['right']-bounds['left'],bounds['bottom']-bounds['top']]) *.06;correction[j]=np.clip(correction[j],-limit,limit)*gate[j]
 stats['adjustedMeasurements']=int(np.count_nonzero(np.linalg.norm(correction,axis=1)>.1));stats['maxCorrectionPixels']=float(np.max(np.linalg.norm(correction,axis=1)))
 times=np.array([r['time']for _,r in observed]);all_times=np.array([r['time']for r in run]);interpolated=np.column_stack([np.interp(all_times,times,correction[:,a])for a in range(2)])
 for row,delta in zip(run,interpolated):
  base=dict(row.get('headMotionBasePoint',row['trackingPoint']));row['headMotionBasePoint']=base;bounds=row['headBounds'];point={}
  for j,axis in enumerate(('x','y')):
   lo,hi=(bounds['left'],bounds['right'])if j==0 else(bounds['top'],bounds['bottom']);wanted=base[axis]+float(delta[j]);point[axis]=float(np.clip(wanted,lo,hi))
   if point[axis]!=wanted:stats['clampedRows']+=1
  row['trackingPoint']=point
 return stats
