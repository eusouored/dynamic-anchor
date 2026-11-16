"""Testable acceptance gates for an isolated visual continuity experiment."""
import numpy as np
def overlaps_other(box,others):
 x,y,w,h=box
 for o in others:
  if min(x+w,o['x']+o['width']/2)>max(x,o['x']-o['width']/2) and min(y+h,o['y']+o['height']/2)>max(y,o['y']-o['height']/2):return True
 return False
def evaluate(forward,backward,first_point,last_point,head_width,others=None):
 """Backward rows must already be sorted by increasing source time."""
 if len(forward)<2 or len(forward)!=len(backward):return None,{'accepted':False,'reason':'unsupported'}
 times=np.array([r['time']for r in forward]);dt=np.diff(times)
 if not np.isfinite(times).all()or not(dt>0).all()or(dt>.5).any()or list(times)!=[r['time']for r in backward]:return None,{'accepted':False,'reason':'gap-or-order'}
 if not all(r['ok']for r in forward+backward):return None,{'accepted':False,'reason':'tracker-lost'}
 center=lambda rr:np.array([[r['box'][0]+r['box'][2]/2,r['box'][1]+r['box'][3]/2]for r in rr],float)
 fp,bp=center(forward),center(backward)
 if not np.isfinite(fp).all()or not np.isfinite(bp).all()or not np.isfinite(head_width)or head_width<=0:return None,{'accepted':False,'reason':'invalid-geometry'}
 closure=max(np.linalg.norm(fp[-1]-bp[-1]),np.linalg.norm(bp[0]-fp[0]));u=(times-times[0])/(times[-1]-times[0]);close=lambda p:p+((np.asarray(first_point)-p[0])[None]*(1-u[:,None])+(np.asarray(last_point)-p[-1])[None]*u[:,None]);fc,bc=close(fp),close(bp);d=np.linalg.norm(fc-bc,axis=1)
 overlaps=False
 if others is not None:overlaps=any(overlaps_other(f['box'],o)or overlaps_other(b['box'],o)for f,b,o in zip(forward,backward,others))
 accepted=closure<=.12*head_width and d.max()<=.12*head_width and not overlaps
 return (fc+(bc-fc)*u[:,None]if accepted else None),dict(accepted=bool(accepted),reason='accepted'if accepted else'identity-overlap'if overlaps else'closure-or-disagreement',maxDisagreement=float(d.max()),medianDisagreement=float(np.median(d)),endpointClosure=float(closure),otherOverlap=overlaps)
