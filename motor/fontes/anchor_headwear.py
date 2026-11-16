"""Check headwear motion independently when a hand hides facial parts."""
import cv2,numpy as np,math

def estimate(previous,current,mask,previous_crop,crop,previous_row,row,corners):
 if mask is None or np.count_nonzero(mask)<64:return None
 points=corners.select(cv2.erode(mask,np.ones((3,3),np.uint8)),64,.01,3)
 if points is None or len(points)<8:return None
 moved,status,_=cv2.calcOpticalFlowPyrLK(previous,current,points,None,winSize=(25,25),maxLevel=3)
 if moved is None:return None
 back,back_status,_=cv2.calcOpticalFlowPyrLK(current,previous,moved,None,winSize=(25,25),maxLevel=3)
 if back is None:return None
 p=points.reshape(-1,2);q=moved.reshape(-1,2);valid=status.ravel().astype(bool)&back_status.ravel().astype(bool)&np.isfinite(q).all(axis=1)&(np.linalg.norm(back.reshape(-1,2)-p,axis=1)<.75)
 if valid.sum()<8:return None
 ps=np.array([previous_crop[2]-previous_crop[0],previous_crop[3]-previous_crop[1]])/512;cs=np.array([crop[2]-crop[0],crop[3]-crop[1]])/512;factor=160/previous_row['width'];pg=(p[valid]*ps+np.array(previous_crop[:2]))*factor;qg=(q[valid]*cs+np.array(crop[:2]))*factor
 world,inliers=cv2.estimateAffinePartial2D(pg,qg,method=cv2.RANSAC,ransacReprojThreshold=1.5,maxIters=500,confidence=.99)
 if world is None or inliers is None or inliers.sum()<max(8,math.ceil(valid.sum()*.65)):return None
 selected=p[valid][inliers.ravel().astype(bool)];all_valid=p[valid]
 if not .75<=math.hypot(world[0,0],world[1,0])<=1.35 or abs(math.atan2(world[1,0],world[0,0]))>.35:return None
 if np.ptp(selected[:,0])<max(8,np.ptp(all_valid[:,0])*.25)or np.ptp(selected[:,1])<max(4,np.ptp(all_valid[:,1])*.25):return None
 world[:,2]/=factor;matrix=np.column_stack([np.diag(1/cs)@world[:,:2]@np.diag(ps),(world[:,:2]@np.array(previous_crop[:2])+world[:,2]-np.array(crop[:2]))/cs])
 return matrix,dict(matrix=world.tolist(),fromTime=float(previous_row['time']),toTime=float(row['time']),inliers=int(inliers.sum()),features=int(valid.sum()),kind='headwear')
