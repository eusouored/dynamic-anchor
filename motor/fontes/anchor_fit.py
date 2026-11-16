"""Bounded, batched robust local linear fits for head/face offsets."""
import numpy as np

def linear_offsets(times,offsets,queries,sigma,batch_size=1024):
 out=np.empty((len(queries),2),float);radius=3*sigma+1e-7
 for start in range(0,len(queries),batch_size):
  query=queries[start:start+batch_size];lo=np.searchsorted(times,query-radius-1e-8);hi=np.searchsorted(times,query+radius+1e-8);size=max(1,int(np.max(hi-lo)));indices=lo[:,None]+np.arange(size)[None,:];mask=indices<hi[:,None];indices=np.minimum(indices,len(times)-1);dt=times[indices]-query[:,None];mask&=np.abs(dt)<=radius
  empty=~mask.any(axis=1)
  if empty.any():
   q=query[empty];at=np.searchsorted(times,q);a=np.maximum(0,at-1);b=np.minimum(len(times)-1,at);nearest=np.where(np.abs(times[a]-q)<=np.abs(times[b]-q),a,b);indices[empty,0]=nearest;mask[empty,0]=True;dt=times[indices]-query[:,None]
  values=offsets[indices];base=np.exp(-.5*(dt/sigma)**2)*mask;weights=np.broadcast_to(base[:,:,None],values.shape).copy();single=mask.sum(axis=1)==1;first=mask.argmax(axis=1)
  for _ in range(3):
   s0=weights.sum(axis=1);s1=(weights*dt[:,:,None]).sum(axis=1);s2=(weights*dt[:,:,None]**2).sum(axis=1);y0=(weights*values).sum(axis=1);y1=(weights*values*dt[:,:,None]).sum(axis=1);det=s0*s2-s1*s1
   intercept=np.divide(y0*s2-y1*s1,det,out=np.zeros_like(y0),where=np.abs(det)>1e-24);slope=np.divide(y1*s0-y0*s1,det,out=np.zeros_like(y0),where=np.abs(det)>1e-24);intercept[single]=values[np.arange(len(query))[single],first[single]];slope[single]=0
   residual=values-intercept[:,None,:]-dt[:,:,None]*slope[:,None,:];median=np.nanmedian(np.where(mask[:,:,None],residual,np.nan),axis=1);scale=np.maximum(.5,np.nanmedian(np.where(mask[:,:,None],np.abs(residual-median[:,None,:]),np.nan),axis=1)*1.4826);weights=base[:,:,None]*np.minimum(1.,2.5*scale[:,None,:]/np.maximum(np.abs(residual),1e-6))
  # A local fit cannot establish unseen geometry outside its observations.
  # Bound extrapolation during silhouette loss, while retaining fits inside support.
  lower=np.min(np.where(mask[:,:,None],values,np.inf),axis=1);upper=np.max(np.where(mask[:,:,None],values,-np.inf),axis=1)
  out[start:start+len(query)]=np.clip(intercept,lower,upper)
 return out
