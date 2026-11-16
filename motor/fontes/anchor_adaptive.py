"""Selected face center with bounded, bidirectionally checked visual tracking."""
import math
import cv2
import numpy as np

METHOD = 'selected-face-center-v1'
MAX_FLOW_SECONDS = .25
SMOOTH_SECONDS = .14
DETECTOR_CORRECTION_SECONDS = .35


def smooth_reference(rows, fps):
    """Centered robust local fit: suppress detector chatter without phase lag.

    Real boxes stay untouched. Only the framing reference is filtered, and
    separate tracking runs never lend samples across a loss.
    """
    radius = max(2, round(fps*SMOOTH_SECONDS/2))
    references = [dict(r.get('trackingPoint') or {axis:r[axis] for axis in ('x','y')}) for r in rows]
    for i, row in enumerate(rows):
        lo, hi = max(0,i-radius),min(len(rows),i+radius+1)
        time = np.array([r['time']-row['time'] for r in rows[lo:hi]])
        degree = min(2,len(time)-1)
        design = np.column_stack([time**k for k in range(degree+1)])
        base = np.exp(-.5*(time/max(1/fps,radius/fps*.65))**2)
        point = {}
        for axis in ('x','y'):
            values = np.array([r[axis] for r in references[lo:hi]])
            weights = base.copy()
            for _ in range(3):
                fit = np.linalg.lstsq(design*weights[:,None]**.5,values*weights**.5,rcond=None)[0]
                residual = values-design@fit
                scale = max(.5,float(np.median(np.abs(residual-np.median(residual))))*1.4826)
                weights = base*np.minimum(1.,2.5*scale/np.maximum(np.abs(residual),1e-6))
            limit = row['width' if axis=='x' else 'height']*.25
            point[axis] = float(np.clip(fit[0],row[axis]-limit,row[axis]+limit))
        row['trackingPoint'] = point


def displacement(before, after, points, reference=None):
    if points is None or len(points) < 6:
        return None
    moved, ok, _ = cv2.calcOpticalFlowPyrLK(before, after, points, None,
        winSize=(21, 21), maxLevel=3)
    if moved is None or ok is None:
        return None
    back, good, _ = cv2.calcOpticalFlowPyrLK(after, before, moved, None,
        winSize=(21, 21), maxLevel=3)
    if back is None or good is None:
        return None
    p, q, b = points.reshape(-1, 2), moved.reshape(-1, 2), back.reshape(-1, 2)
    valid = ok.ravel().astype(bool) & good.ravel().astype(bool)
    valid &= np.isfinite(q).all(axis=1) & (np.linalg.norm(b-p, axis=1) <= 1.2)
    if valid.sum() < max(6, math.ceil(len(p)*.5)):
        return None
    if reference is not None and valid.sum() >= max(8, math.ceil(len(p)*.5)):
        reference = np.asarray(reference, dtype=float)
        if reference.shape != (2,) or not np.isfinite(reference).all():
            raise ValueError('Invalid visual reference point')
        matrix, inliers = cv2.estimateAffinePartial2D(p[valid], q[valid], method=cv2.RANSAC,
            ransacReprojThreshold=1.5, maxIters=500, confidence=.99)
        if matrix is not None and inliers is not None:
            count = int(inliers.sum())
            scale = math.hypot(matrix[0,0], matrix[1,0])
            angle = math.atan2(matrix[1,0], matrix[0,0])
            if count >= max(8, math.ceil(len(p)*.5)) and .85 <= scale <= 1.18 and abs(angle) <= .25:
                delta = matrix @ np.r_[reference, 1.] - reference
                selected = q[valid][inliers.ravel().astype(bool)]
                return delta, selected.reshape(-1,1,2).astype(np.float32)
        # Small or weak feature sets retain the established translation fallback.
        # The same forward/backward and spatial-consensus gates still apply.
    delta = np.median(q[valid]-p[valid], axis=0)
    valid &= np.linalg.norm((q-p)-delta, axis=1) <= 2.
    if valid.sum() < max(6, math.ceil(len(p)*.5)):
        return None
    return delta, q[valid].reshape(-1, 1, 2).astype(np.float32)


FEATURE_MARGIN = 8


def face_features(gray, x0, y0, x1, y1):
    """goodFeaturesToTrack restricted to the face rectangle.

    Same corners as running it on the whole image with a mask: the minimum
    eigenvalue uses a 3x3 Sobel and a 3x3 block, the local-maximum test a 3x3
    dilation, and the quality threshold comes from the maximum inside the mask.
    With a margin of FEATURE_MARGIN pixels around the rectangle every value
    inside it is computed from the same pixels; points keep row-major order.
    """
    H, W = gray.shape[:2]
    if x1 <= x0 or y1 <= y0:
        mask = np.zeros_like(gray)
        mask[y0:y1, x0:x1] = 255
        return cv2.goodFeaturesToTrack(gray, maxCorners=60, qualityLevel=.015,
            minDistance=2, mask=mask, blockSize=3)
    cx0, cy0 = max(0, x0-FEATURE_MARGIN), max(0, y0-FEATURE_MARGIN)
    cx1, cy1 = min(W, x1+FEATURE_MARGIN), min(H, y1+FEATURE_MARGIN)
    sub = np.ascontiguousarray(gray[cy0:cy1, cx0:cx1])
    mask = np.zeros_like(sub)
    mask[y0-cy0:y1-cy0, x0-cx0:x1-cx0] = 255
    points = cv2.goodFeaturesToTrack(sub, maxCorners=60, qualityLevel=.015,
        minDistance=2, mask=mask, blockSize=3)
    if points is not None:
        points += np.array([cx0, cy0], dtype=np.float32)
    return points


class SelectedVisualTrack:
    def __init__(self, tracker, width, height, reference_motion="translation"):
        if reference_motion not in ("translation", "similarity"):
            raise ValueError("Unknown reference motion strategy")
        self.reference_motion = reference_motion
        self.tracker, self.width, self.height = tracker, width, height
        self.gray = self.points = self.box = None
        self.last_face_time = None
        self.flow_samples = 0
        self.detector_samples = 0
        self.rejected_flow = 0
        self.reference = self.reference_time = None

    def update(self, detections, time, image):
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        sx, sy = image.shape[1]/self.width, image.shape[0]/self.height
        prediction = None
        reference_prediction = None
        if self.gray is not None and self.box is not None:
            reference = self.reference or {axis:self.box[axis] for axis in ('x','y')}
            flow = displacement(self.gray, gray, self.points,
                reference=np.array([reference['x']*sx,reference['y']*sy])) if self.reference_motion == 'similarity' else displacement(self.gray, gray, self.points)
            if flow is not None:
                delta, points = flow
                x, y = self.box['x']+float(delta[0])/sx, self.box['y']+float(delta[1])/sy
                if (math.hypot(float(delta[0])/sx,float(delta[1])/sy) <= max(self.box['w'],self.box['h'])*.65
                        and 0 <= x <= self.width and 0 <= y <= self.height):
                    prediction = dict(self.box, x=x, y=y)
                    if self.reference is not None:
                        reference_prediction = {axis:self.reference[axis]+float(delta[n])/(sx if n==0 else sy)
                                                for n,axis in enumerate(('x','y'))}
                    self.points = points
                else:
                    self.rejected_flow += 1
        selected = self.tracker.atualizar(detections, time)
        # A short visual prediction can recover a rapid movement rejected by
        # velocity gating, but only with similar appearance and a unique match.
        if selected is None and prediction is not None and self.last_face_time is not None and time-self.last_face_time <= MAX_FLOW_SECONDS:
            size = max(prediction['w'], prediction['h'])
            matches = sorted([(math.hypot(d['x']-prediction['x'],d['y']-prediction['y'])/size,d)
                for d in detections if self.tracker.aparencia(d) >= .65], key=lambda p:p[0])
            if matches and matches[0][0] < .45 and (len(matches)==1 or matches[1][0]-matches[0][0] > .3):
                selected = matches[0][1]
                self.tracker.c = (selected['x'], selected['y'])
                self.tracker.s = math.sqrt(selected['w']*selected['h'])
                self.tracker.t = time
                self.tracker.v = (0., 0.)
        if selected is not None:
            self.box = dict(selected)
            self.last_face_time = time
            self.detector_samples += 1
            x, y, w, h = selected['x']*sx,selected['y']*sy,selected['w']*sx,selected['h']*sy
            x0,y0=max(0,round(x-w*.6)),max(0,round(y-h*.6))
            x1,y1=min(gray.shape[1],round(x+w*.6)),min(gray.shape[0],round(y+h*.6))
            self.points = face_features(gray, x0, y0, x1, y1)
            result = dict(selected, trackingMethod='face')
        elif (prediction is not None and self.last_face_time is not None
                and time-self.last_face_time <= MAX_FLOW_SECONDS):
            self.box = prediction
            self.flow_samples += 1
            result = dict(prediction, trackingMethod='flow', score=min(.8,prediction['score']))
        else:
            self.points = self.box = None
            result = None
        if result is not None:
            dt=time-self.reference_time if self.reference_time is not None else 0.
            if reference_prediction is not None:self.handoff_episode=None
            elif getattr(self,'handoff_episode',None) is None:
                self.handoff_episode=bool(self.reference is not None and getattr(self,'recent_detector_speed',float('inf'))<1.)
            previous=getattr(self,'previous_detection',None)
            if selected is not None and previous is not None and dt>0:
                self.recent_detector_speed=math.hypot(selected['x']-previous['x'],selected['y']-previous['y'])/max(previous['w'],previous['h'])/dt
            self.previous_detection=dict(selected) if selected is not None else None
            # Optical flow measures movement of the selected head's texture.
            # The detector corrects slow drift without injecting every box wobble.
            # Never move the raw rectangle or inherit a reference across a loss.
            weight = 1.-math.exp(-max(0.,time-self.reference_time)/DETECTOR_CORRECTION_SECONDS) if self.reference_time is not None else 1.
            point = {}
            for axis,size in (('x','w'),('y','h')):
                value = result[axis] if reference_prediction is None else reference_prediction[axis]
                # Keep the existing detector correction rate during short flow failures.
                if (reference_prediction is None and self.reference is not None
                        and selected is not None and self.reference_time is not None
                        and 0 < time-self.reference_time <= MAX_FLOW_SECONDS
                        and self.handoff_episode):
                    value = self.reference[axis]+(result[axis]-self.reference[axis])*weight
                if reference_prediction is not None and selected is not None:
                    value += (result[axis]-value)*weight
                limit = result[size]*.25
                point[axis] = float(np.clip(value,result[axis]-limit,result[axis]+limit))
            result['trackingPoint'] = point
            self.reference,self.reference_time = point,time
        else:
            self.reference = self.reference_time = None
            self.handoff_episode=None;self.previous_detection=None;self.recent_detector_speed=float('inf')
        self.gray = gray
        return result
