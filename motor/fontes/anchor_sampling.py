"""Auditable geometric association and bounded reconstruction; no identity claim."""
import math
import bisect
import anchor_dense as D

ASSOCIATION = 'selected-yunet-unique-canthi-contained-v2'


def correct_drift(points, boxes, fps, observed=None):
    """Correct slow face-center drift within ONE valid run, preserving eye detail.

    Prefix sums make the centered two-second estimate linear in run length.
    The caller must split runs at real losses; no values cross an occlusion.
    """
    if (isinstance(fps, bool) or not isinstance(fps, (int, float)) or
            not math.isfinite(fps) or fps <= 0 or len(points) != len(boxes) or not points):
        raise ValueError('Dados inválidos para correção de referência facial.')
    observed = [True] * len(points) if observed is None else observed
    if len(observed) != len(points) or any(type(v) is not bool for v in observed) or not any(observed):
        raise ValueError('Referência sem medições observadas válidas.')
    measured_indices = [i for i, value in enumerate(observed) if value]
    prefix = {'x': [0.0], 'y': [0.0]}
    counts = [0]
    for i, (point, box) in enumerate(zip(points, boxes)):
        counts.append(counts[-1] + int(observed[i]))
        for axis in ('x', 'y'):
            p, b = point.get(axis), box.get(axis)
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (p, b)):
                raise ValueError('Coordenada inválida na referência facial.')
            prefix[axis].append(prefix[axis][-1] + (b-p if observed[i] else 0))
    radius = round(fps)
    output = []
    for i, point in enumerate(points):
        lo, hi = max(0, i-radius), min(len(points), i+radius+1)
        if counts[hi] == counts[lo]:
            at = bisect.bisect_left(measured_indices, i)
            nearest = min(measured_indices[max(0, at-1):at+1], key=lambda j: abs(j-i))
            lo, hi = nearest, nearest+1
        output.append({axis: point[axis] + (prefix[axis][hi]-prefix[axis][lo])/(counts[hi]-counts[lo])
                       for axis in ('x', 'y')})
    return output


def coherent(a, b, frames=1):
    """Reject synthesis across motion/scale discontinuities; measured data stay intact."""
    aa, bb = a['box'], b['box']
    size = min(aa['w'], aa['h'], bb['w'], bb['h'])
    ratio = max(bb['w']/aa['w'], aa['w']/bb['w'], bb['h']/aa['h'], aa['h']/bb['h'])
    distance = math.hypot(a['point']['x']-b['point']['x'], a['point']['y']-b['point']['y'])
    return size > 0 and ratio <= 1.5 and distance <= size * .35 * max(1, frames)


def associate(detections, selected, mp_sample, previous, now, initial=False):
    if not detections:
        return 'yunet-missing', False
    if selected is None or not any(d is selected for d in detections):
        return 'yunet-not-selected', False
    if mp_sample is None:
        return 'mediapipe-missing', False
    contained = [d for d in detections if D.inside_box(mp_sample['left'], d) and D.inside_box(mp_sample['right'], d)]
    if len(contained) != 1:
        return ('yunet-multiple' if len(detections) > 1 else 'canthi-outside-box'), False
    if contained[0] is not selected:
        return 'yunet-not-selected', False
    if len(detections) > 1 and not initial:
        # Multiple candidates are only accepted during a continuous established
        # track. A long occlusion needs unambiguous reacquisition first.
        if previous is None or not 0 < now-previous['time'] <= .35:
            return 'association-discontinuity', False
        old = previous['box']; p = previous['rawPoint']; q = mp_sample['midpoint']
        relative = math.hypot((q['x']-selected['x'])-(p['x']-old['x']),
                              (q['y']-selected['y'])-(p['y']-old['y']))
        scale = min(old['w'], old['h'], selected['w'], selected['h'])
        ratio = max(selected['w']/old['w'], old['w']/selected['w'],
                    selected['h']/old['h'], old['h']/selected['h'])
        if ratio > 1.7 or relative > scale*.45:
            return 'association-discontinuity', False
    return None, len(detections) > 1


def reconstruct(samples, skipped, reasons, step):
    if isinstance(step, bool) or not isinstance(step, int) or step not in (1, 2, 3):
        raise ValueError('Passo video15 deve ser 1, 2 ou 3.')
    result = dict(samples); filled = []
    if step == 1:
        return result, filled
    indices = sorted(samples)
    for lo, hi in zip(indices, indices[1:]):
        gap = hi-lo
        if gap <= 1 or gap > step:
            continue
        middle = range(lo+1, hi)
        if any(i not in skipped or i in reasons for i in middle):
            continue
        a,b = samples[lo],samples[hi]
        if not coherent(a,b,gap):
            continue
        for i in middle:
            u = (i-lo)/gap
            mix = lambda x,y: x+(y-x)*u
            result[i] = {'point':{k:mix(a['point'][k],b['point'][k]) for k in ('x','y')},
                         'rawPoint':{k:mix(a['rawPoint'][k],b['rawPoint'][k]) for k in ('x','y')},
                         'box':{k:mix(a['box'][k],b['box'][k]) for k in ('x','y','w','h','score')},
                         'time':mix(a['time'],b['time']), 'sourceTime':mix(a['sourceTime'],b['sourceTime']),
                         'source':'sampled'}
            filled.append(i)
    return result, sorted(filled)
