import unittest,sys,copy
from pathlib import Path
from unittest.mock import patch
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]));import anchor_head as H,anchor_rosto as R
class PipelineTests(unittest.TestCase):
 def test_sampled_head_pipeline_counts_actual_reads_and_finishes_progress_after_fusion(self):
  rows=[dict(time=i/8,x=300.,y=300.,width=100.,height=120.,confidence=.9,source='detected'if i in [0,2,4,6,7]else'interpolated',trackingPoint=dict(x=300.,y=300.))for i in range(8)]
  base=dict(rows=rows,segments=[dict(primary=True,rows=[])],fps=8,width=640,height=480,warnings=[],stats=dict(step=2,decodedFrames=8,faceMeasurements=5,framesPerSecond=8))
  def face(job,options,progress,cancel,inform,measure,_observations=None,**kwargs):
   _observations.extend(dict(time=r['time'],x=r['x'],y=r['y'],width=r['width'],height=r['height'],source='detected')for r in rows if r['source']=='detected');progress(1.,8,8);return copy.deepcopy(base)
  calls=[]
  class Parser:
   def detect(self,image,row):calls.append(row);return dict(left=220.,right=380.,top=140.,bottom=360.,source='segmented')
  class Cap:
   def release(self):pass
  def frames(cap,fps,start,end,needed):
   for i in range(8):
    t=i/8;yield t,np.zeros((480,640,3),np.uint8)if needed(t)else None
  progress=[]
  with patch.object(H,'HeadParser',Parser),patch.object(R,'executar',face),patch.object(R,'abrir_video',return_value=(Cap(),8,640,480)),patch.object(R,'quadros',frames):
   result=H.execute_head_two_pass(dict(mediaPath='x',inPoint=0,outPoint=1),dict(referencia='cabeca',passo=2,aceleracao=True,paralelo=True),lambda p,n,s:progress.append(p),None,None,True)
  self.assertEqual(len(calls),5);self.assertEqual(len(result['analysisSamples']),5);self.assertEqual(result['stats']['headMeasurements'],5);self.assertEqual(result['trackingReference']['method'],'selected-head-hybrid-v3');self.assertEqual(progress[-1],.99);self.assertEqual(progress,sorted(progress));self.assertIn('fusion',result['stats']['phaseSeconds'])
if __name__=='__main__':unittest.main()
