"""Reuse image-only corner responses across masks, preserving OpenCV selection."""
import cv2,numpy as np,math

class CornerMap:
 def __init__(self,gray):
  self.response=cv2.cornerMinEigenVal(gray,blockSize=3,ksize=3)
  self.local_max=cv2.dilate(self.response,None)
 def select(self, mask, maxCorners, qualityLevel, minDistance):
     response = self.response
     full_height,width=response.shape
     x0=y0=0;roi=response;local_max=self.local_max;roi_mask=mask
     if mask is not None:
         x0,y0,roi_width,roi_height=cv2.boundingRect(mask)
         if not roi_width or not roi_height:return None
         roi=response[y0:y0+roi_height,x0:x0+roi_width]
         local_max=self.local_max[y0:y0+roi_height,x0:x0+roi_width]
         roi_mask=mask[y0:y0+roi_height,x0:x0+roi_width]
     maximum = cv2.minMaxLoc(roi, mask=roi_mask)[1]
     eligible = (roi > np.float32(maximum * qualityLevel)) & (roi == local_max)
     if roi_mask is not None:eligible &= roi_mask != 0
     # OpenCV excludes the image border, not the boundary of this ROI.
     if y0==0:eligible[0,:]=False
     if y0+roi.shape[0]==full_height:eligible[-1,:]=False
     if x0==0:eligible[:,0]=False
     if x0+roi.shape[1]==width:eligible[:,-1]=False
     local_indices=np.flatnonzero(eligible)[::-1]
     indices=(local_indices//roi.shape[1]+y0)*width+local_indices%roi.shape[1]+x0
     if not len(indices):
         return None
     values = response.ravel()[indices]
     indices = indices[np.argsort(-values, kind='stable')]
     chosen = []
     distance = minDistance * minDistance
     cells = {}
     for index in indices:
         y, x = divmod(int(index), width)
         if minDistance >= 1:
             cx, cy = math.floor(x / minDistance), math.floor(y / minDistance)
             if any((x-px)**2 + (y-py)**2 < distance
                    for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                    for px, py in cells.get((cx+dx, cy+dy), ())):
                 continue
             cells.setdefault((cx, cy), []).append((x, y))
         chosen.append((x, y))
         if maxCorners > 0 and len(chosen) >= maxCorners:
             break
     return np.asarray(chosen, np.float32).reshape(-1, 1, 2)
