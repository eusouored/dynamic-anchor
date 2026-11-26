import unittest,sys
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]));import anchor_head as H

def run_rows(tops,bottoms,faces,fps=30.):
 return [dict(time=i/fps,x=1000.,y=f,width=300.,height=330.,source='detected',trackingPoint=dict(x=1000.,y=f),faceTrackingPoint=dict(x=1000.,y=f),
  headBounds=dict(left=830.,right=1170.,top=t,bottom=b,source='segmented'))for i,(t,b,f)in enumerate(zip(tops,bottoms,faces))]

class VerticalReferenceTests(unittest.TestCase):
 def test_head_pitch_down_keeps_reference_near_the_head_top(self):
  # 1,5 s parado e 0,6 s abaixando a cabeça: o topo quase não mexe, o queixo desce 100 px e o rosto 70 px.
  n,k=63,18;tops=[440.]*(n-k)+list(np.linspace(440,447,k));bottoms=[860.]*(n-k)+list(np.linspace(860,960,k));faces=[675.]*(n-k)+list(np.linspace(675,745,k))
  run=run_rows(tops,bottoms,faces);H.fuse_reference(run)
  distance=[r['trackingPoint']['y']-r['headBounds']['top']for r in run]
  centre=[(b-t)/2 for t,b in zip(tops,bottoms)]          # distância do centro do contorno ao topo (referência antiga)
  self.assertLess(max(distance)-min(distance),.5*(max(centre)-min(centre)))
  self.assertTrue(all(H.REFERENCE_HEIGHT_KEY in r for r in run))
 def test_steady_head_reference_is_the_contour_centre(self):
  run=run_rows([400.]*40,[820.]*40,[640.]*40);H.fuse_reference(run)
  for r in run:self.assertAlmostEqual(r['trackingPoint']['y'],610.,delta=1e-6)
 def test_slow_change_of_size_is_followed(self):
  # Aproximando da câmera em 4 s: a altura cresce devagar e o ponto acompanha o centro.
  n=120;tops=list(np.linspace(400,300,n));bottoms=list(np.linspace(820,920,n));faces=[(t+b)/2+20 for t,b in zip(tops,bottoms)]
  run=run_rows(tops,bottoms,faces);H.fuse_reference(run)
  middle=run[n//2];self.assertAlmostEqual(middle['trackingPoint']['y'],(middle['headBounds']['top']+middle['headBounds']['bottom'])/2,delta=6)
 def test_reference_stays_inside_the_contour(self):
  run=run_rows([400.]*30,[500.]*15+[820.]*15,[640.]*30);H.fuse_reference(run)
  for r in run:self.assertTrue(r['headBounds']['top']<=r['trackingPoint']['y']<=r['headBounds']['bottom'])
 def test_slow_heights_window(self):
  t=np.arange(0,4,1/30)
  nod=np.where(t<3.5,420.,520.);self.assertEqual(H.slow_heights(t,nod,t)[-1],420.)    # 0,5 s de cabeça baixa no fim não muda a altura
  held=np.where(t<1.5,420.,520.);self.assertEqual(H.slow_heights(t,held,t)[-1],520.)  # mudança que dura mais que a janela é seguida
if __name__=='__main__':unittest.main()
