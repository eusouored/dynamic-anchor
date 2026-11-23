"""Keep semantic head pixels associated with the explicitly selected face.

The parser labels facial parts, not person instances. An accessory region
connected to the crop edge can be sky/background; competing face detections
provide exclusion evidence when two people touch in the semantic component.
"""
import cv2
import numpy as np

def selected_labels(labels, crop, row, allow_border_rejection=True):
    """Use 1-D float32 axes and broadcasting instead of two dense index grids."""
    out=labels.copy();x0,y0,x1,y1=crop;mh,mw=out.shape;x,y,w,h=[row[k]for k in ('x','y','width','height')]
    # Match np.indices(dtype=float32) arithmetic order and dtype exactly. The
    # singleton dimensions broadcast over pixels without allocating yy and xx.
    px=x0+np.arange(mw,dtype=np.float32)[None,:]*(x1-x0)/mw
    py=y0+np.arange(mh,dtype=np.float32)[:,None]*(y1-y0)/mh
    hair_support=(out==17)&(np.abs(px-x)<w)&(py>y-h)&(py<y+h*.3)
    pixel_area=(x1-x0)*(y1-y0)/(mw*mh)
    if allow_border_rejection and np.count_nonzero(hair_support)*pixel_area>=w*h*.15:
     n,cc,stats,_=cv2.connectedComponentsWithStats((out==18).astype(np.uint8),8)
     # One pass over the pixels for all rejected components (same result as
     # clearing them one by one).
     remove=np.zeros(n,dtype=bool)
     for i in range(1,n):
      left,top,width,height,area=stats[i]
      boundary=left==0 or top==0 or left+width==mw or top+height==mh
      sparse_extension=area/(width*height)<.25 and area*pixel_area<w*h*.3 and y0+top*(y1-y0)/mh<y-h*.85
      if boundary or sparse_extension:remove[i]=True
     if remove.any():out[remove[cc]]=0
    others=row.get('otherFaces')or[]
    if others:
     selected=((px-x)/(.75*w))**2+((py-(y-.15*h))/(.85*h))**2
     protected=((px-x)/(.4*w))**2+((py-y)/(.4*h))**2<1
     for face in others:
      fx,fy,fw,fh=[face[k]for k in ('x','y','width','height')]
      if np.hypot((fx-x)/w,(fy-y)/h)<.4 and .6<fw/w<1.7:continue
      # Compare both seeds in one metric. Normalizing each person's distance
      # by their own box lets a larger foreground face absorb the smaller
      # person's hair, especially above both faces.
      rival=((px-fx)/(.75*w))**2+((py-(fy-.15*fh))/(.85*h))**2
      # Semantic labels can connect both people's hair outside the facial
      # ellipse. Assign the whole crop competitively, including that bridge.
      # Keep the selected facial core and the duplicate-detection exception.
      out[(rival+.15<selected)&~protected]=0
    return out
