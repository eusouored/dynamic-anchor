"""Reject isolated semantic extensions without smoothing real head translation."""
import numpy as np
METHOD='face-relative-temporal-shape-v1'
def reliable_measurements(rows,measurements):
 filtered=dict(measurements)
 for i,b in measurements.items():
  if b is not None and (not .7<=(b['bottom']-b['top'])/max(1e-8,b['right']-b['left'])<=2.5 or b['bottom']-b['top']<rows[i]['height']*.95):filtered[i]=None
 valid=sorted((i,b)for i,b in filtered.items()if b is not None)
 if len(valid)<5:return filtered
 times=np.array([rows[i]['time']for i,b in valid]);geometry=np.array([[(b[k]-rows[i]['x'if k in('left','right')else'y'])/max(1.,rows[i]['width'if k in('left','right')else'height'])for k in('left','top','right','bottom')]for i,b in valid])
 for j,(i,b)in enumerate(valid):
  lo,hi=np.searchsorted(times,[times[j]-.5-1e-8,times[j]+.5+1e-8]);local=geometry[lo:hi]
  if len(local)<5:continue
  median=np.median(local,axis=0);mad=np.median(np.abs(local-median),axis=0)*1.4826;limit=np.maximum(.35,4*mad)
  if np.any(np.abs(geometry[j]-median)>limit):filtered[i]=None
 return filtered
