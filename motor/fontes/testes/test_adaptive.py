import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import anchor_rosto as R
import anchor_adaptive as A
import numpy as np
import cv2


class AdaptiveTests(unittest.TestCase):
    def test_missing_frames_are_interpolated_from_fixed_endpoints(self):
        def detection(x):
            return dict(x=x,y=20.,w=40.,h=50.,score=.9)
        points=[dict(t=i/30,det=detection(10. if i==0 else 110.) if i in (0,4) else None) for i in range(5)]
        run=R.montar_segmentos(points,.5)[0]
        self.assertEqual([r['x'] for r in run],[10.,35.,60.,85.,110.])

    def test_resampling_preserves_interpolation_provenance(self):
        box=dict(x=10.,y=20.,w=40.,h=50.,score=.9)
        samples=[dict(t=i/30,det=dict(box,x=10.+i*5,trackingPoint=dict(x=10.+i*5,y=20.)) if i in (0,4) else None) for i in range(5)]
        run=R.montar_segmentos(samples,.5,referencia='adaptativo')[0]
        rows=R.reamostrar(run,0,5/30,30,30,referencia='adaptativo')
        self.assertEqual([r['source'] for r in rows],['detected','interpolated','interpolated','interpolated','detected'])

    def test_small_background_face_is_available_for_selection(self):
        detections=[dict(x=100.,y=100.,w=300.,h=400.,score=.9),dict(x=800.,y=100.,w=30.,h=40.,score=.9)]
        self.assertEqual(len(R.numerar_rostos(detections,1920,1080)),2)

    def test_bidirectional_flow_recovers_translation_but_rejects_blank_frame(self):
        image=np.random.default_rng(42).integers(0,256,(160,160),dtype=np.uint8)
        points=cv2.goodFeaturesToTrack(image,60,.02,5)
        moved=cv2.warpAffine(image,np.float32([[1,0,4],[0,1,3]]),(160,160))
        flow=A.displacement(image,moved,points)
        self.assertIsNotNone(flow)
        np.testing.assert_allclose(flow[0],[4,3],atol=.2)
        self.assertIsNone(A.displacement(image,np.zeros_like(image),points))

    def test_visual_fallback_expires_without_face_measurement(self):
        class Tracker:
            def __init__(self):self.calls=0
            def atualizar(self,ds,t):
                self.calls+=1
                return ds[0] if ds else None
            def aparencia(self,d):return 1.
        gray=np.random.default_rng(1).integers(0,256,(160,160),dtype=np.uint8)
        image=cv2.cvtColor(gray,cv2.COLOR_GRAY2BGR)
        track=A.SelectedVisualTrack(Tracker(),160,160)
        box=dict(x=80.,y=80.,w=60.,h=60.,score=.9)
        self.assertEqual(track.update([box],0.,image)['trackingMethod'],'face')
        moved=cv2.warpAffine(image,np.float32([[1,0,4],[0,1,3]]),(160,160))
        result=track.update([],1/30,moved)
        self.assertEqual(result['trackingMethod'],'flow')
        self.assertAlmostEqual(result['x'],84.,delta=.2)
        self.assertIsNone(track.update([],.3,moved))
        self.assertEqual(track.detector_samples,1)
        self.assertEqual(track.flow_samples,1)

    def test_reference_filter_reduces_jitter_without_delaying_linear_motion(self):
        rows=[dict(time=i/60,x=500+i*4+(-1)**i*5,y=300.,width=100.,height=120.) for i in range(60)]
        A.smooth_reference(rows,60)
        raw=np.array([r['x']-(500+i*4) for i,r in enumerate(rows)])
        filtered=np.array([r['trackingPoint']['x']-(500+i*4) for i,r in enumerate(rows)])
        self.assertLess(np.std(filtered[5:-5]),np.std(raw[5:-5])*.4)
        linear=[dict(time=i/60,x=500+i*4,y=300+i*2,width=100.,height=120.) for i in range(60)]
        A.smooth_reference(linear,60)
        for row in linear:
            self.assertAlmostEqual(row['trackingPoint']['x'],row['x'],places=6)
            self.assertAlmostEqual(row['trackingPoint']['y'],row['y'],places=6)

    def test_visual_reference_rejects_box_chatter_but_follows_real_translation(self):
        class Tracker:
            def atualizar(self,ds,t):return ds[0] if ds else None
            def aparencia(self,d):return 1.
        image=cv2.cvtColor(np.random.default_rng(15).integers(0,256,(220,220),dtype=np.uint8),cv2.COLOR_GRAY2BGR)
        track=A.SelectedVisualTrack(Tracker(),220,220)
        points=[]
        for i in range(20):
            moved=cv2.warpAffine(image,np.float32([[1,0,i*2],[0,1,i]]),(220,220))
            jitter=0 if i==0 else (-1)**i*6
            box=dict(x=90.+i*2+jitter,y=90.+i-jitter,w=60.,h=70.,score=.9)
            result=track.update([box],i/30,moved)
            points.append(result['trackingPoint'])
            self.assertEqual(result['x'],box['x'],'raw detector rectangle stays unchanged')
        residual=[p['x']-(90+i*2) for i,p in enumerate(points)]
        self.assertLess(np.std(residual),1.5)
        self.assertAlmostEqual(points[-1]['x'],128.,delta=1.5)
        self.assertIsNone(track.update([],1.,np.zeros_like(image)))
        reset=track.update([dict(x=160.,y=150.,w=60.,h=70.,score=.9)],1.1,image)
        self.assertEqual(reset['trackingPoint'],dict(x=160.,y=150.))

    def test_reference_smoothing_preserves_stabilized_input(self):
        rows=[dict(time=i/30,x=100.+(-1)**i*8,y=90.,width=80.,height=100.,trackingPoint=dict(x=100.,y=90.))for i in range(20)]
        A.smooth_reference(rows,30)
        for r in rows:self.assertAlmostEqual(r['trackingPoint']['x'],100.,places=6)


if __name__ == '__main__':
    unittest.main()

