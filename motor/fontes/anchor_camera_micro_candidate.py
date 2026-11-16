"""Tiny, bounded, zero-phase corrections on actual analyzed instants only.

An experimental camera refinement, not installed and not anatomical ground truth.
"""
import numpy as np

def apply_to_result(result,cancelled=None):
 """Adjust existing sample points; interpolate corrections, never create keys."""
 import time
 started=time.perf_counter();maximum=0.;groups=0
 samples=np.asarray([s['time'] for s in result['analysisSamples']],float)
 for rows in [result['rows']]+[s['rows'] for s in result.get('segments',[]) if not s.get('primary')]:
  if cancelled and cancelled():raise RuntimeError('Camera refinement cancelled')
  if len(rows)<3:continue
  times=np.asarray([r['time'] for r in rows],float)
  measured=samples[(samples>=times[0]-1e-7)&(samples<=times[-1]+1e-7)]
  indices=np.searchsorted(times,measured)
  if len(indices)<3:continue
  if (indices>=len(times)).any() or np.max(abs(times[indices]-measured))>=1e-6:raise ValueError('Measured sample missing from trajectory')
  indices=np.unique(indices)
  if len(indices)<3:continue
  points=np.asarray([[r['trackingPoint'][k] for k in ('x','y')] for r in rows],float)
  widths=np.asarray([r['headBounds']['right']-r['headBounds']['left'] for r in rows],float)
  delta=refine(times[indices],points[indices],widths[indices],cancelled=cancelled)-points[indices]
  correction=np.column_stack([np.interp(times,times[indices],delta[:,k]) for k in (0,1)])
  lengths=np.linalg.norm(correction,axis=1);limit=.015*widths
  correction*=np.minimum(1.,limit/np.maximum(lengths,1e-12))[:,None]
  maximum=max(maximum,float(np.max(np.linalg.norm(correction,axis=1))));groups+=1
  for row,point in zip(rows,points+correction):row['trackingPoint']={'x':float(point[0]),'y':float(point[1])}
 return {'groups':groups,'maxCorrectionSourcePixels':maximum,'seconds':time.perf_counter()-started,'method':'bounded-camera-quadratic-v1'}

def refine(times,points,widths,sigma=.08,max_fraction=.015,cancelled=None):
 times=np.asarray(times,float);points=np.asarray(points,float);widths=np.asarray(widths,float);out=points.copy()
 if len(times)<3:return out
 if not(np.isfinite(times).all()and np.isfinite(points).all()and np.isfinite(widths).all()and(np.diff(times)>0).all()and(widths>0).all()):raise ValueError('Invalid measured trajectory')
 dt=np.diff(times);valid_dt=dt[dt<=.5]
 if len(valid_dt):sigma=max(sigma,float(np.median(valid_dt)))
 speed=np.linalg.norm(np.diff(points,axis=0),axis=1)/dt;fast=speed>3*np.minimum(widths[:-1],widths[1:]);protected=np.zeros(len(times),bool)
 for i in np.flatnonzero(fast):protected|=(times>=times[i]-3*sigma)&(times<=times[i+1]+3*sigma)
 # Split temporal losses. Interpolated rows never become observations here.
 cuts=np.r_[0,np.flatnonzero(dt>.5)+1,len(times)]
 for a,b in zip(cuts,cuts[1:]):
  if b-a<3:continue
  for i in range(a,b):
   if i%32==0 and cancelled and cancelled():raise RuntimeError('Camera refinement cancelled')
   if protected[i]:continue
   lo=max(a,int(np.searchsorted(times,times[i]-3*sigma)));hi=min(b,int(np.searchsorted(times,times[i]+3*sigma,side='right')))
   if hi-lo<3:continue
   x=(times[lo:hi]-times[i])/sigma;X=np.column_stack([np.ones(len(x)),x,x*x]);y=points[lo:hi];base=np.exp(-.5*x*x);weights=base.copy();coef=None
   for _ in range(3):
    w=np.sqrt(weights);coef=np.linalg.lstsq(X*w[:,None],y*w[:,None],rcond=None)[0];res=np.linalg.norm(y-X@coef,axis=1);scale=max(.3,float(np.median(abs(res-np.median(res))))*1.4826);weights=base*np.minimum(1.,2.5*scale/np.maximum(res,1e-9))
   delta=coef[0]-points[i];norm=float(np.linalg.norm(delta));limit=max_fraction*widths[i]
   if norm<1e-10:continue
   if norm>limit:delta*=limit/norm
   distance=min(times[i]-times[a],times[b-1]-times[i]);phase=min(1.,max(0.,distance/(1.5*sigma)));fade=np.sin(np.pi*.5*phase)**2;out[i]=points[i]+delta*fade
 return out
