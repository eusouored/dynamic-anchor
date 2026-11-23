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
 def _run_without_head(self,reference,xs=None):
  xs=xs or [300.]*8
  rows=[dict(time=i/8,x=max(0.,x),y=300.,width=100.,height=120.,confidence=.9,source='detected',trackingPoint=dict(x=x,y=300.))for i,x in enumerate(xs)]
  base=dict(rows=rows,segments=[dict(primary=True,start=0.,end=7/8,samples=8,rows=[])],fps=8,inPoint=0.,outPoint=1.,width=640,height=480,warnings=[],coverage=1.,stats=dict(step=1,decodedFrames=8,faceMeasurements=8,framesPerSecond=8))
  if reference:base['trackingReference']=dict(method='selected-face-center-v1',offset=dict(x=0.,y=0.),sampling=dict(method='fixed-stride-v1',step=1))
  def face(job,options,progress,cancel,inform,measure,_observations=None,**kwargs):
   _observations.extend(dict(time=r['time'],x=r['x'],y=r['y'],width=r['width'],height=r['height'],source='detected')for r in rows);return copy.deepcopy(base)
  class Parser:
   def detect(self,image,row):return None
  class Cap:
   def release(self):pass
  def frames(cap,fps,start,end,needed):
   for i in range(8):
    t=i/8;yield t,np.zeros((480,640,3),np.uint8)if needed(t)else None
  with patch.object(H,'HeadParser',Parser),patch.object(R,'executar',face),patch.object(R,'abrir_video',return_value=(Cap(),8,640,480)),patch.object(R,'quadros',frames):
   return H.execute_head_two_pass(dict(mediaPath='x',inPoint=0,outPoint=1),dict(referencia='cabeca',passo=1,aceleracao=True,paralelo=False),None,None,None,True)
 def test_no_reliable_head_returns_marked_face_reference(self):
  # 0.5.3: sem nenhuma leitura de cabeça, o trajeto do rosto é entregue com marca e aviso.
  result=self._run_without_head(True)
  self.assertEqual(result['trackingReference']['method'],'selected-face-center-v1')
  self.assertEqual(result['trackingReference']['headFallback']['method'],H.FACE_FALLBACK_METHOD)
  self.assertEqual(result['stats']['headFallback']['headMeasurements'],0)
  self.assertEqual(len(result['rows']),8);self.assertIn(H.FACE_FALLBACK_WARNING,result['warnings']);self.assertIn('fusion',result['stats']['phaseSeconds'])
 def test_face_fallback_keeps_longest_run_inside_the_frame(self):
  # Pessoa saindo pela esquerda: os pontos fora da imagem saem do trajeto entregue.
  result=self._run_without_head(True,[90.,70.,50.,30.,10.,-10.,-30.,-50.])
  self.assertEqual([r['trackingPoint']['x']for r in result['rows']],[90.,70.,50.,30.,10.])
  self.assertEqual(result['coverage'],.625);self.assertEqual(result['segments'][0]['samples'],5)
  self.assertEqual(result['trackingReference']['headFallback']['outsideFrameRowsRemoved'],3)
 def test_no_head_and_no_face_reference_still_refuses(self):
  with self.assertRaises(R.ErroMotor):self._run_without_head(False)
if __name__=='__main__':unittest.main()
