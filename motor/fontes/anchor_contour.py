"""Motion validation of selected headwear's upper contour.

Only observed images enter this tracker. A transported trusted mask validates
new semantic foreground against both the head and the background motion.
The uncertainty band is never accumulated as evidence in the next mask.
"""
import cv2,numpy as np,math
from anchor_corners import CornerMap
class ContourMotion:
 def __init__(self):
  self.gray=self.mask=self.crop=self.row=None;self.headwear=None;self._corners=None;self.motion=None;self.hat_mask=None;self._supported_hat_top=None;self._hat_contraction_since=None;self._headwear_candidate=None;self._headwear_candidate_since=None;self.stats={'tracked':0,'fallback':0,'reset':0,'novelAccepted':0,'novelRejected':0,'occlusionHeadwear':0,'occlusionRejectedMotion':0,'headwearChanges':0}
 def reset(self):
  self._recovery_anchor=None;self._recovery_since=None;self._occlusion_until=None
  self.gray=self.mask=self.crop=self.row=None;self.headwear=None;self._corners=None;self.motion=None;self.hat_mask=None;self._supported_hat_top=None;self._hat_contraction_since=None;self._headwear_candidate=None;self._headwear_candidate_since=None
 def _pick_hat(self,mask,reference=None,point=None):
  if mask is None or not np.any(mask):return np.zeros((512,512),np.uint8)
  n,components,stats,centers=cv2.connectedComponentsWithStats((mask>0).astype(np.uint8),8)
  if n<=1:return np.zeros((512,512),np.uint8)
  if reference is not None and np.any(reference):
   near=cv2.dilate((reference>0).astype(np.uint8),np.ones((7,7),np.uint8));scores=np.bincount(components[near>0],minlength=n)[1:]
   chosen=1+int(np.argmax(scores))
   if scores.max()>0:return (components==chosen).astype(np.uint8)
  if point is None:return (components==1+int(np.argmax(stats[1:,cv2.CC_STAT_AREA]))).astype(np.uint8)
  target=np.asarray([point['x'],point['y']] if isinstance(point,dict) else point,float)
  distances=[float(np.linalg.norm(centers[i]-target)) for i in range(1,n)]
  return (components==1+int(np.argmin(distances))).astype(np.uint8)
 def _constrain(self,gray,labels,crop,row,bounds,raw_component=None):
  self.motion=None
  raw=component(labels,crop,row) if raw_component is None else raw_component
  if raw is None:self.reset();return bounds
  row=dict(row);point=row.get('visualPoint')
  if not isinstance(point,dict) or not all(isinstance(point.get(k),(int,float)) and math.isfinite(point[k]) for k in ('x','y')):
   if not all(isinstance(row.get(k),(int,float)) and math.isfinite(row[k]) for k in ('x','y')):self.reset();return bounds
   row['visualPoint']={'x':float(row['x']),'y':float(row['y'])}
  now=row.get('time')
  if not isinstance(now,(int,float)) or not math.isfinite(now):self.reset();return bounds
  if self.row is not None:
   dt=float(now)-float(self.row.get('time',now))
   if dt<=0 or dt>.251:self.reset()
  fraction=np.count_nonzero((labels==18)&(raw>0))/max(1,np.count_nonzero(raw));now=float(row.get('time',0.))
  if self.headwear is None:self.headwear=fraction>=.08
  candidate=True if fraction>=.12 else False if fraction<.02 and row.get('headVisibility',{}).get('groups',0)>=2 else None
  if candidate is None or candidate==self.headwear:self._headwear_candidate=None;self._headwear_candidate_since=None
  elif candidate!=self._headwear_candidate:self._headwear_candidate=candidate;self._headwear_candidate_since=now
  elif now-self._headwear_candidate_since>=.2:
   self.gray=self.mask=self.crop=self.row=None;self._corners=self.hat_mask=self._supported_hat_top=self._hat_contraction_since=None;self.motion=None;self.headwear=candidate;self._headwear_candidate=None;self._headwear_candidate_since=None;self.stats['headwearChanges']+=1
  # Hair and facial geometry keep their established path. The extra temporal
  # test addresses newly grown headwear, which can absorb a nearby background.
  if not self.headwear:self._supported_hat_top=None;return bounds
  semantic_hat=((labels==18)&(raw>0)).astype(np.uint8)
  refined=self.refine(gray,raw,crop,row,headwear_mask=semantic_hat)
  if cv2.countNonZero(refined)<64:return bounds
  _,top_pixel,_,height_pixels=cv2.boundingRect(refined)
  scale=(crop[3]-crop[1])/labels.shape[0]
  top=crop[1]+float(top_pixel)*scale;height=float(height_pixels)*scale
  # Keep the measured sides and jaw. An uncertainty margin protects the full
  # cap while preventing an unsupported upper extension from moving the center.
  temporal_top=min(bounds['bottom']-1.,top-.08*height)
  # Override a contracted raw top only when current class-18 labels overlap
  # the transported trusted cap mask and that mask provides the missing top.
  # Ordinary frames retain the original bounds guard.
  if self._supported_hat_top is not None and bounds['top']>self._supported_hat_top+2.:
   return {**bounds,'top':min(bounds['bottom']-1.,self._supported_hat_top)}
  return {**bounds,'top':max(bounds['top'],temporal_top)}
 def constrain(self,gray,labels,crop,row,bounds,raw_component=None):
  result=self._constrain(gray,labels,crop,row,bounds,raw_component=raw_component)
  t=row['time'];v=row.get('headVisibility',{});anchor=getattr(self,'_recovery_anchor',None)
  if v.get('occluded'):self._occlusion_until=t+2.;self._recovery_since=None
  mask=(labels==18).astype(np.uint8)
  if not bool(self.headwear) or np.count_nonzero(mask)<64 or row.get('otherFaces'):
   self._recovery_since=None;return result
  px=(row['x']-crop[0])*512/(crop[2]-crop[0]);py=(row['y']-crop[1])*512/(crop[3]-crop[1])
  cap=self._pick_hat(mask,self.hat_mask,dict(x=px,y=py));x,y,w,h=cv2.boundingRect(cap)
  if x<=0 or y<=0 or x+w>=512 or y+h>=512:self._recovery_since=None;return result
  world=np.array([crop[0]+x*(crop[2]-crop[0])/512,crop[1]+y*(crop[3]-crop[1])/512,crop[0]+(x+w)*(crop[2]-crop[0])/512,crop[1]+(y+h)*(crop[3]-crop[1])/512])
  norm=(world-np.array([row['x'],row['y'],row['x'],row['y']]))/np.array([row['width'],row['height'],row['width'],row['height']])
  clean=v.get('groups',0)>=2 and not v.get('occluded')
  if anchor is None:
   substantial=(norm[2]-norm[0])>=.6 and (norm[3]-norm[1])>=.3
   if clean and substantial and abs(result['top']-bounds['top'])<row['height']*.04:self._recovery_anchor=norm
   return result
  until=getattr(self,'_occlusion_until',None)
  if until is None or t>until or not clean:self._recovery_since=None;return result
  # Require the known accessory envelope, not merely a persistent new blob.
  plausible=np.max(np.abs(norm-anchor))<.3 and (norm[2]-norm[0])<(anchor[2]-anchor[0])*1.25 and (norm[3]-norm[1])<(anchor[3]-anchor[1])*1.25
  if not plausible:self._recovery_since=None;return result
  if getattr(self,'_recovery_since',None)is None:self._recovery_since=t
  if t-self._recovery_since<.2:return result
  if result['top']>bounds['top']+row['height']*.06:
   self.mask=cv2.bitwise_or(self.mask,cap);self.hat_mask=cap.copy();self.stats['capReacquired']=self.stats.get('capReacquired',0)+1
   return {**result,'top':bounds['top']}
  return result
 def background(self,gray,crop):
  mask=1-cv2.dilate(self.mask,np.ones((41,41),np.uint8));points=self._corners.select(mask,80,.015,4)
  if points is None or len(points)<8:return None
  q,st,_=cv2.calcOpticalFlowPyrLK(self.gray,gray,points,None,winSize=(25,25),maxLevel=3)
  if q is None:return None
  back,bst,_=cv2.calcOpticalFlowPyrLK(gray,self.gray,q,None,winSize=(25,25),maxLevel=3)
  if back is None:return None
  p=points.reshape(-1,2);q=q.reshape(-1,2);valid=st.ravel().astype(bool)&bst.ravel().astype(bool)&(np.linalg.norm(back.reshape(-1,2)-p,axis=1)<1.)
  if valid.sum()<8:return None
  ps=np.array([self.crop[2]-self.crop[0],self.crop[3]-self.crop[1]])/512;cs=np.array([crop[2]-crop[0],crop[3]-crop[1]])/512;factor=160/self.row['width'];pg=(p[valid]*ps+np.array(self.crop[:2]))*factor;qg=(q[valid]*cs+np.array(crop[:2]))*factor;world,inliers=cv2.estimateAffinePartial2D(pg,qg,method=cv2.RANSAC,ransacReprojThreshold=1.5,maxIters=500,confidence=.99)
  if world is None or inliers is None or inliers.sum()<max(8,valid.sum()*.6):return None
  world[:,2]/=factor;return np.column_stack([np.diag(1/cs)@world[:,:2]@np.diag(ps),(world[:,:2]@np.array(self.crop[:2])+world[:,2]-np.array(crop[:2]))/cs])
 def refine(self,gray,raw,crop,row,headwear_mask=None):
  world_point=row.get('visualPoint',row)
  local_point={'x':(world_point['x']-crop[0])*512/(crop[2]-crop[0]),'y':(world_point['y']-crop[1])*512/(crop[3]-crop[1])}
  raw=raw.astype(np.uint8);now=float(row['time']);previous=self.row;matrix=None;tracked=False;current_corners=None
  if self.gray is not None and now-previous['time']<=.251 and now>previous['time']:
   points=self._corners.select(cv2.erode(self.mask,np.ones((3,3),np.uint8)),120,.01,4)
   if points is not None and len(points)>=8:
    q,st,_=cv2.calcOpticalFlowPyrLK(self.gray,gray,points,None,winSize=(25,25),maxLevel=3)
    if q is not None:
     back,bst,_=cv2.calcOpticalFlowPyrLK(gray,self.gray,q,None,winSize=(25,25),maxLevel=3)
     if back is not None:
      p=points.reshape(-1,2);qq=q.reshape(-1,2);valid=st.ravel().astype(bool)&bst.ravel().astype(bool)&np.isfinite(qq).all(axis=1)&(np.linalg.norm(back.reshape(-1,2)-p,axis=1)<1.)
      if valid.sum()>=8:
       psv=np.array([self.crop[2]-self.crop[0],self.crop[3]-self.crop[1]])/512;csv=np.array([crop[2]-crop[0],crop[3]-crop[1]])/512;factor=160/previous['width'];pg=(p[valid]*psv+np.array(self.crop[:2]))*factor;qg=(qq[valid]*csv+np.array(crop[:2]))*factor;world,inliers=cv2.estimateAffinePartial2D(pg,qg,method=cv2.RANSAC,ransacReprojThreshold=1.5,maxIters=500,confidence=.99);candidate=None
       if world is not None:
        world[:,2]/=factor;candidate=np.column_stack([np.diag(1/csv)@world[:,:2]@np.diag(psv),(world[:,:2]@np.array(self.crop[:2])+world[:,2]-np.array(crop[:2]))/csv])
       if candidate is not None and inliers is not None and inliers.sum()>=max(8,math.ceil(valid.sum()*.5)):
        worldScale=math.hypot(world[0,0],world[1,0]);selected=p[valid][inliers.ravel().astype(bool)];_,_,mask_width,mask_height=cv2.boundingRect(self.mask)
        if .75<=worldScale<=1.35 and np.ptp(selected[:,0])>=.3*(mask_width-1) and np.ptp(selected[:,1])>=.3*(mask_height-1):
         matrix=candidate;tracked=True;self.motion=dict(matrix=world.tolist(),fromTime=float(previous['time']),toTime=now,inliers=int(inliers.sum()),features=int(valid.sum()))
   if row.get('headVisibility',{}).get('occluded')or previous.get('headVisibility',{}).get('occluded'):
    from anchor_headwear import estimate as headwear_motion
    cap_motion=headwear_motion(self.gray,gray,self.hat_mask,self.crop,crop,previous,row,self._corners)
    if cap_motion is not None:
     matrix,self.motion=cap_motion;tracked=True;self.stats['occlusionHeadwear']+=1
    elif tracked and self.hat_mask is not None:
     xx=np.clip(np.rint(selected[:,0]).astype(int),0,511);yy=np.clip(np.rint(selected[:,1]).astype(int),0,511)
     if np.count_nonzero(self.hat_mask[yy,xx])<3:matrix=None;tracked=False;self.motion=None;self.stats['occlusionRejectedMotion']+=1
   if matrix is None:
    ps=np.array([self.crop[2]-self.crop[0],self.crop[3]-self.crop[1]])/512;cs=np.array([crop[2]-crop[0],crop[3]-crop[1]])/512;pr=previous.get('visualPoint',previous);rr=row.get('visualPoint',row);dx=rr['x']-pr['x'];dy=rr['y']-pr['y'];matrix=np.array([[ps[0]/cs[0],0,(self.crop[0]+dx-crop[0])/cs[0]],[0,ps[1]/cs[1],(self.crop[1]+dy-crop[1])/cs[1]]],float);self.stats['fallback']+=1
  predicted_hat=None;self._supported_hat_top=None
  if tracked and matrix is not None and self.hat_mask is not None:
   predicted_hat=cv2.warpAffine(self.hat_mask,matrix,(512,512),flags=cv2.INTER_NEAREST)
  if matrix is None:
   result=raw;self.stats['reset']+=1
  else:
   if tracked:self.stats['tracked']+=1
   predicted=cv2.warpAffine(self.mask,matrix,(512,512),flags=cv2.INTER_NEAREST);near=cv2.dilate(predicted,np.ones((7,7),np.uint8));result=(raw&near).astype(np.uint8);core=(predicted&cv2.dilate(raw,np.ones((7,7),np.uint8))).astype(np.uint8)
   novel=(raw&(1-near)).astype(np.uint8)
   if tracked and novel.any():
    background=self.background(gray,crop);backgroundInverse=cv2.invertAffineTransform(background)if background is not None else None
    n,components,stats,_=cv2.connectedComponentsWithStats(novel,8);inverse=cv2.invertAffineTransform(matrix);ps=np.array([self.crop[2]-self.crop[0],self.crop[3]-self.crop[1]])/512;cs=np.array([crop[2]-crop[0],crop[3]-crop[1]])/512
    for i in range(1,n):
     if stats[i,cv2.CC_STAT_AREA]<12:continue
     mask=(components==i).astype(np.uint8)
     if current_corners is None:current_corners=CornerMap(gray)
     q=current_corners.select(mask,24,.01,3);accepted=False
     if q is not None and len(q)>=3 and backgroundInverse is not None:
      p,st,_=cv2.calcOpticalFlowPyrLK(gray,self.gray,q,None,winSize=(25,25),maxLevel=3)
      if p is not None:
       back,bst,_=cv2.calcOpticalFlowPyrLK(self.gray,gray,p,None,winSize=(25,25),maxLevel=3)
       if back is not None:
        qq=q.reshape(-1,2);pp=p.reshape(-1,2);expected=qq@inverse[:,:2].T+inverse[:,2];static=qq@backgroundInverse[:,:2].T+backgroundInverse[:,2];valid=st.ravel().astype(bool)&bst.ravel().astype(bool)&(np.linalg.norm(back.reshape(-1,2)-qq,axis=1)<.75);eh=np.linalg.norm(pp-expected,axis=1);eb=np.linalg.norm(pp-static,axis=1);good=valid&(eh<1.5)&(eb>1.25)&(eh<eb*.6);accepted=good.sum()>=3 and good.sum()>=len(q)*.6
     if accepted:result[components==i]=1;core[components==i]=1;self.stats['novelAccepted']+=1
     else:self.stats['novelRejected']+=1
   # Display can use the current semantic edge within a small uncertainty band.
   # The band never becomes the next frame's trusted shape by itself.
   core_reset=np.count_nonzero(core)<max(64,np.count_nonzero(predicted)*.45)
   if core_reset:
    result=raw;self.mask=raw;self.stats['reset']+=1
    self.hat_mask=self._pick_hat(headwear_mask,predicted_hat,local_point)&raw if headwear_mask is not None else None
    self._hat_contraction_since=None
   else:
    self.mask=core
    # Reacquire the previously tracked cap silhouette only while the current
    # selected component still supplies substantial semantic class-18 support
    # over that transported mask. This can bridge a temporary label contraction
    # without accepting an unrelated person's cap or background expansion.
    if (tracked and predicted_hat is not None and headwear_mask is not None
        and np.count_nonzero(headwear_mask)>=64 and np.count_nonzero(predicted_hat)>=64):
     current_hat=self._pick_hat(headwear_mask,predicted_hat,local_point)
     overlap=cv2.bitwise_and(cv2.dilate(predicted_hat,np.ones((7,7),np.uint8)),current_hat)
     support=np.count_nonzero(overlap)/max(1,np.count_nonzero(predicted_hat))
     current_coverage=np.count_nonzero(overlap)/max(1,np.count_nonzero(current_hat))
     shrinking=support<.92 and current_coverage>=.9 and np.count_nonzero(current_hat)>=64
     if shrinking:
      if self._hat_contraction_since is None:self._hat_contraction_since=now
      if now-self._hat_contraction_since>=.20:
       self.hat_mask=cv2.bitwise_and(current_hat,self.mask);self._hat_contraction_since=None;self._supported_hat_top=None
      elif support>=.55:
       result=cv2.bitwise_or(result,predicted_hat);self.mask=cv2.bitwise_or(self.mask,predicted_hat);self.hat_mask=predicted_hat.copy()
       _,hat_top,_,hat_height=cv2.boundingRect(predicted_hat)
       if hat_height:self._supported_hat_top=float(crop[1]+hat_top*(crop[3]-crop[1])/512)
     else:
      self._hat_contraction_since=None
      if support>=.55:
       result=cv2.bitwise_or(result,predicted_hat);self.mask=cv2.bitwise_or(self.mask,predicted_hat);self.hat_mask=predicted_hat.copy()
       _,hat_top,_,hat_height=cv2.boundingRect(predicted_hat)
       if hat_height:self._supported_hat_top=float(crop[1]+hat_top*(crop[3]-crop[1])/512)
      else:self.hat_mask=cv2.bitwise_and(current_hat,self.mask)
    elif headwear_mask is not None:
     self._hat_contraction_since=None;self.hat_mask=cv2.bitwise_and(self._pick_hat(headwear_mask,None,local_point),self.mask)
  if matrix is None:
   self.mask=result.copy()
   if headwear_mask is not None:self.hat_mask=cv2.bitwise_and(self._pick_hat(headwear_mask,None,local_point),self.mask)
  self.gray=gray;self.crop=crop;self.row=dict(row);self._corners=current_corners if current_corners is not None else CornerMap(gray);return result

def component(labels,crop,row):
 x0,y0,x1,y1=crop;h,w=labels.shape;head=np.isin(labels,[1,2,3,4,5,6,7,8,10,11,12,13,17,18]).astype(np.uint8);head[np.arange(h)>(row['y']+.55*row['height']-y0)*h/(y1-y0),:]=0;n,cc,_,_=cv2.connectedComponentsWithStats(head,8);x,y,fw,fh=[row[k]for k in ('x','y','width','height')];xx0,yy0,xx1,yy1=[round(v)for v in ((x-fw/2-x0)*w/(x1-x0),(y-fh/2-y0)*h/(y1-y0),(x+fw/2-x0)*w/(x1-x0),(y+fh/2-y0)*h/(y1-y0))];inside=cc[max(0,yy0):min(h,yy1),max(0,xx0):min(w,xx1)];scores=[np.sum(inside==i)for i in range(1,n)]
 if not inside.size or not scores or max(scores)<inside.size*.3:return None
 return (cc==1+int(np.argmax(scores))).astype(np.uint8)
