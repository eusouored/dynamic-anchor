"""Experimental VIDEO + centered-MM15 facial reference for Dynamic Anchor.

This module deliberately imports MediaPipe only when video15 is requested so
the legacy YuNet modes keep their existing runtime and import behavior.
"""
import hashlib
import importlib.metadata
import functools
import math
import os
import sys

METHOD = 'mediapipe-canthi-video-mm15-aligned-v1'
MODEL_NAME = 'face_landmarker-v1.task'
MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'
RUNTIME_VERSION = '1.1.1'
WINDOW = 15
ANCHOR_IDS = (133, 362)


def _model_candidates(module_dir=None):
    roots = [module_dir or os.path.dirname(os.path.abspath(__file__)),
             getattr(sys, '_MEIPASS', None), os.path.dirname(os.path.abspath(sys.executable))]
    seen = set()
    for root in roots:
        if root:
            path = os.path.abspath(os.path.join(root, MODEL_NAME))
            if path not in seen:
                seen.add(path)
                yield path


def model_path(module_dir=None):
    for path in _model_candidates(module_dir):
        if os.path.isfile(path):
            return path
    return None


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


@functools.lru_cache(maxsize=8)
def _capability_cached(path, size, mtime_ns):
    try:
        if file_sha256(path) != MODEL_SHA256:
            return {'available': False, 'reason': 'model-sha-mismatch'}
        import mediapipe as mp
        version = importlib.metadata.version('mediapipe')
        tasks = getattr(mp, 'tasks', None)
        vision = getattr(tasks, 'vision', None)
        if version != RUNTIME_VERSION:
            return {'available': False, 'reason': 'mediapipe-version-mismatch'}
        if vision is None or not hasattr(vision, 'FaceLandmarker'):
            return {'available': False, 'reason': 'face-landmarker-unavailable'}
        return {'available': True}
    except Exception as error:
        return {'available': False, 'reason': 'mediapipe-import-failed', 'detail': str(error)}


def capability_detail(module_dir=None):
    """Return true capability only when the pinned runtime imports and model verifies."""
    path = model_path(module_dir)
    if not path:
        return {'available': False, 'reason': 'model-missing'}
    try:
        stat = os.stat(path)
    except OSError:
        return {'available': False, 'reason': 'model-missing'}
    return dict(_capability_cached(path, stat.st_size, stat.st_mtime_ns))


def capability(module_dir=None):
    return capability_detail(module_dir).get('available') is True


def create_landmarker(model_asset_path=None, mp_module=None):
    """Create a CPU VIDEO landmarker. Import MediaPipe lazily for legacy safety."""
    path = model_asset_path or model_path()
    if not path or file_sha256(path) != MODEL_SHA256:
        raise RuntimeError('Modelo FaceLandmarker ausente ou SHA-256 incompatível para video15.')
    if mp_module is None:
        try:
            import mediapipe as mp_module
        except Exception as error:
            raise RuntimeError('MediaPipe %s indisponível para video15: %s' % (RUNTIME_VERSION, error))
    try:
        version = importlib.metadata.version('mediapipe')
    except Exception:
        version = getattr(mp_module, '__version__', None)
    if version != RUNTIME_VERSION:
        raise RuntimeError('video15 exige MediaPipe %s (encontrado %s).' % (RUNTIME_VERSION, version or 'desconhecido'))
    try:
        base = mp_module.tasks.BaseOptions
        options = mp_module.tasks.vision.FaceLandmarkerOptions(
            base_options=base(model_asset_path=path, delegate=base.Delegate.CPU),
            running_mode=mp_module.tasks.vision.RunningMode.VIDEO,
            num_faces=1,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=True)
        return mp_module.tasks.vision.FaceLandmarker.create_from_options(options), mp_module
    except Exception as error:
        raise RuntimeError('Não foi possível iniciar FaceLandmarker VIDEO para video15: %s' % error)


def create_video15_session(cv2_module, output_width, output_height, model_asset_path=None, mp_module=None):
    landmarker, mp = create_landmarker(model_asset_path, mp_module)
    return VideoLandmarker(landmarker, mp, cv2_module, output_width, output_height)


def timestamp_milliseconds(source_time, previous=None):
    """Python round is half-even; reject missing, negative, or non-monotonic PTS."""
    if isinstance(source_time, bool) or not isinstance(source_time, (int, float)) or not math.isfinite(source_time) or source_time < 0:
        return None
    value = int(round(source_time * 1000.0))
    if previous is not None and value <= previous:
        return None
    return value


def _landmark_xy(landmark, width, height):
    x, y = getattr(landmark, 'x', None), getattr(landmark, 'y', None)
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    x, y = float(x), float(y)
    if not math.isfinite(x) or not math.isfinite(y):
        return None
    return {'x': x * width, 'y': y * height}


class VideoLandmarker:
    """Stateful, timestamp-ordered VIDEO adapter; all returned points are in output pixels."""
    def __init__(self, landmarker, mp_module, cv2_module, output_width, output_height):
        self.landmarker = landmarker
        self.mp = mp_module
        self.cv2 = cv2_module
        self.output_width = float(output_width)
        self.output_height = float(output_height)
        self.previous_ms = None
        self.target_crop_session = None
        self.target_crop_frames = 0

    def detect(self, bgr, source_time, selected=None):
        # A small selected face can be visible to YuNet while the full-frame
        # landmarker misses it. Calibrate on a crop only at the first sample;
        # keep that mode for the run to avoid switching coordinate references.
        if self.target_crop_session is not None:
            stamp = timestamp_milliseconds(source_time, self.previous_ms)
            if stamp is None:
                return None, 'invalid-timestamp'
            self.previous_ms = stamp
            return self._detect_target_crop(bgr, source_time, selected)
        first = self.previous_ms is None
        sample, reason = self._detect_frame(bgr, source_time)
        if first and reason != 'invalid-timestamp' and selected is not None and (
                sample is None or not inside_box(sample['left'], selected) or
                not inside_box(sample['right'], selected)):
            landmarker, mp = create_landmarker()
            self.target_crop_session = VideoLandmarker(
                landmarker, mp, self.cv2, self.output_width, self.output_height)
            return self._detect_target_crop(bgr, source_time, selected)
        return sample, reason

    def _detect_target_crop(self, bgr, source_time, selected):
        if selected is None:
            return None, 'yunet-not-selected'
        if any(isinstance(selected.get(k), bool) or not isinstance(selected.get(k), (int, float)) or
               not math.isfinite(selected[k]) for k in ('x', 'y', 'w', 'h')) or min(selected['w'], selected['h']) <= 0:
            return None, 'yunet-not-selected'
        height, width = bgr.shape[:2]
        sx, sy = width / self.output_width, height / self.output_height
        side = 3 * max(selected['w'] * sx, selected['h'] * sy)
        x0, y0 = max(0, math.floor(selected['x'] * sx - side / 2)), max(0, math.floor(selected['y'] * sy - side / 2))
        x1, y1 = min(width, math.ceil(selected['x'] * sx + side / 2)), min(height, math.ceil(selected['y'] * sy + side / 2))
        if x1 - x0 < 4 or y1 - y0 < 4:
            return None, 'mediapipe-missing'
        crop = self.cv2.resize(bgr[y0:y1, x0:x1], (256, 256))
        session = self.target_crop_session
        session.output_width, session.output_height = (x1 - x0) / sx, (y1 - y0) / sy
        sample, reason = session.detect(crop, source_time)
        self.target_crop_frames += 1
        if sample is not None:
            for key in ('left', 'right', 'midpoint'):
                sample[key]['x'] += x0 / sx
                sample[key]['y'] += y0 / sy
            if not inside_box(sample['left'], selected) or not inside_box(sample['right'], selected):
                return None, 'canthi-outside-box'
        return sample, reason

    def _detect_frame(self, bgr, source_time):
        stamp = timestamp_milliseconds(source_time, self.previous_ms)
        if stamp is None:
            return None, 'invalid-timestamp'
        height, width = bgr.shape[:2]
        try:
            rgb = self.cv2.cvtColor(bgr, self.cv2.COLOR_BGR2RGB)
            image = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb)
            result = self.landmarker.detect_for_video(image, stamp)
        except Exception as error:
            raise RuntimeError('Falha de inferência FaceLandmarker VIDEO: %s' % error)
        self.previous_ms = stamp
        faces = getattr(result, 'face_landmarks', None) or []
        if len(faces) != 1:
            return None, 'mediapipe-missing'
        landmarks = faces[0]
        if len(landmarks) <= max(ANCHOR_IDS):
            return None, 'mediapipe-missing'
        left = _landmark_xy(landmarks[ANCHOR_IDS[0]], width, height)
        right = _landmark_xy(landmarks[ANCHOR_IDS[1]], width, height)
        if left is None or right is None:
            return None, 'mediapipe-missing'
        sx, sy = self.output_width / width, self.output_height / height
        left = {'x': left['x'] * sx, 'y': left['y'] * sy}
        right = {'x': right['x'] * sx, 'y': right['y'] * sy}
        midpoint = {'x': (left['x'] + right['x']) / 2.0, 'y': (left['y'] + right['y']) / 2.0}
        return {'left': left, 'right': right, 'midpoint': midpoint, 'timestampMs': stamp}, None

    def close(self):
        try:
            close = getattr(self.landmarker, 'close', None)
            if callable(close):
                close()
        finally:
            if self.target_crop_session is not None:
                self.target_crop_session.close()


def centered_mean(points, radius=7):
    """Centered arithmetic mean, clipped to the current contiguous valid run."""
    if not isinstance(points, (list, tuple)) or not points:
        raise ValueError('A corrida MM15 precisa conter medições.')
    if radius < 0 or radius != 7:
        raise ValueError('video15 fixa a janela central em 15 amostras (raio 7).')
    result = []
    for i in range(len(points)):
        lo, hi = max(0, i - radius), min(len(points), i + radius + 1)
        result.append({'x': sum(points[j]['x'] for j in range(lo, hi)) / (hi - lo),
                       'y': sum(points[j]['y'] for j in range(lo, hi)) / (hi - lo)})
    return result


def inside_box(point, detection):
    """Check a point against the physical YuNet box; this is geometric association only."""
    values = (point.get('x'), point.get('y'), detection.get('x'), detection.get('y'), detection.get('w'), detection.get('h'))
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
        return False
    x, y, cx, cy, width, height = values
    return cx - width / 2.0 <= x <= cx + width / 2.0 and cy - height / 2.0 <= y <= cy + height / 2.0


METHOD_V2 = 'mediapipe-canthi-video-mm15-aligned-v2'
METHOD_V3 = 'mediapipe-canthi-box-mm15-v3'


def reference(offset, anchor, box_center, source_time, step=None):
    result = {'schema': 1, 'method': METHOD, 'experimental': True,
            'offset': {'x': float(offset['x']), 'y': float(offset['y'])},
            'anchorIds': [133, 362], 'mode': 'VIDEO',
            'model': {'name': 'face_landmarker', 'sha256': MODEL_SHA256,
                      'runtime': 'mediapipe', 'runtimeVersion': RUNTIME_VERSION},
            'alignment': {'policy': 'index0-fixed', 'anchor': {'x': float(anchor['x']), 'y': float(anchor['y'])},
                          'boxCenter': {'x': float(box_center['x']), 'y': float(box_center['y'])},
                          'sourceTime': float(source_time)},
            'smoothing': {'method': 'centered-mean', 'window': WINDOW, 'applied': True, 'gapPolicy': 'split'},
            'association': {'method': 'single-yunet-selected-canthi-contained-v1', 'identityVerified': False}}

    if step is not None:
        if isinstance(step, bool) or step not in (1, 2, 3):
            raise ValueError('Passo video15 inválido.')
        result.update(schema=3, method=METHOD_V3)
        result['alignment']['policy'] = 'index0-with-box-drift'
        result['driftCorrection'] = {'method': 'centered-box-offset', 'windowSeconds': 2}
        result['association']['method'] = 'selected-yunet-unique-canthi-contained-v2'
        result['sampling'] = {'method': 'fixed-stride-v1', 'step': step,
                              'interpolation': 'valid-adjacent-endpoints', 'recoveryFrames': 0}
    return result
