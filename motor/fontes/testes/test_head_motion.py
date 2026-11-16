import unittest,sys,math,copy
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]));from anchor_head_motion import stabilize
class HeadMotionTests(unittest.TestCase):
 def fixture(self,fps=30,noise=True):
  rows=[]
  for i in range(round(fps*8)):
   t=i/fps;x=300+120*math.sin(5*t);y=300+70*math.sin(4*t);error=22. if noise and 2.5<t<2.9 else 0.;row=dict(time=t,trackingPoint=dict(x=x,y=y+error),headVisibility=dict(occluded=bool(error)),headBounds=dict(left=x-100,right=x+100,top=y-150,bottom=y+100,source='segmented'))
   if i:
    pt=(i-1)/fps;px=300+120*math.sin(5*pt);py=300+70*math.sin(4*pt);row['headMotion']=dict(matrix=[[1.,0.,x-px],[0.,1.,y-py]],fromTime=pt,toTime=t,inliers=40,features=45)
   rows.append(row)
  return rows
 def test_false_reference_jump_during_occlusion_is_reduced_without_new_inference(self):
  run=self.fixture();before=np.sqrt(np.mean([(r['trackingPoint']['y']-(300+70*math.sin(4*r['time'])))**2 for r in run]));stats=stabilize(run);after=np.sqrt(np.mean([(r['trackingPoint']['y']-(300+70*math.sin(4*r['time'])))**2 for r in run]));self.assertLess(after,before*.55);self.assertGreater(stats['edges'],100)
 def test_correct_rapid_motion_is_not_delayed_at_any_supported_cadence(self):
  for fps in [24,30000/1001,30,60000/1001,60,120]:
   run=self.fixture(fps,False);before=copy.deepcopy(run);stabilize(run);np.testing.assert_allclose([[r['trackingPoint'][a]for a in ['x','y']]for r in run],[[r['trackingPoint'][a]for a in ['x','y']]for r in before],atol=1e-9,rtol=0)
 def test_no_trusted_motion_preserves_the_existing_reference(self):
  run=self.fixture();[r.pop('headMotion',None)for r in run];before=copy.deepcopy(run);self.assertEqual(stabilize(run)['edges'],0);self.assertEqual(run,before)
 def test_a_motion_link_from_another_run_is_not_used(self):
  run=self.fixture();[r['headMotion'].update(fromTime=-20.)for r in run if r.get('headMotion')];before=copy.deepcopy(run);self.assertEqual(stabilize(run)['edges'],0);self.assertEqual(run,before)
 def test_repeating_the_fusion_does_not_accumulate_correction(self):
  run=self.fixture();stabilize(run);before=copy.deepcopy(run);stabilize(run);np.testing.assert_array_equal([[r['trackingPoint'][a]for a in ['x','y']]for r in run],[[r['trackingPoint'][a]for a in ['x','y']]for r in before])

 def test_clear_face_preserves_the_existing_head_center(self):
  run=self.fixture();[r['headVisibility'].update(occluded=False)for r in run];before=copy.deepcopy(run);self.assertEqual(stabilize(run)['edges'],0);self.assertEqual(run,before)

 def test_a_brief_motion_failure_does_not_create_a_release_jump(self):
  run=self.fixture();run[87].pop('headMotion',None);before=copy.deepcopy(run);stabilize(run);truth=np.array([[300+120*math.sin(5*r['time']),300+70*math.sin(4*r['time'])]for r in run]);a=np.array([[r['trackingPoint'][k]for k in ['x','y']]for r in run]);b=np.array([[r['trackingPoint'][k]for k in ['x','y']]for r in before]);self.assertLess(np.max(np.linalg.norm(np.diff(a-truth,axis=0),axis=1)),np.max(np.linalg.norm(np.diff(b-truth,axis=0),axis=1)))
  for a,b in zip(run,before):
   if a['time']<2.2 or a['time']>3.2:self.assertEqual(a['trackingPoint'],b['trackingPoint'])
