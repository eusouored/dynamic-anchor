import unittest,sys,cv2,numpy as np
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from anchor_contour import ContourMotion
class ContourTests(unittest.TestCase):
 def fixture(self,dx=5,dy=2,camera=False,headwear=True):
  rng=np.random.default_rng(15);bg=rng.integers(30,100,(512,512),dtype=np.uint8);texture=rng.integers(90,230,(512,512),dtype=np.uint8);mask=np.zeros((512,512),np.uint8);cv2.ellipse(mask,(256,245),(95,125),0,0,360,1,-1);image=bg.copy();image[mask>0]=texture[mask>0];labels=mask*17
  if headwear:labels[(mask>0)&(np.indices(mask.shape)[0]<240)]=18
  m=np.float32([[1,0,dx],[0,1,dy]]);moved=cv2.warpAffine(mask,m,(512,512),flags=cv2.INTER_NEAREST);im1=cv2.warpAffine(bg,m,(512,512))if camera else bg.copy();tex1=cv2.warpAffine(texture,m,(512,512));im1[moved>0]=tex1[moved>0];l1=cv2.warpAffine(labels,m,(512,512),flags=cv2.INTER_NEAREST);l1[60+dy:150+dy,240+dx:270+dx]=18 if headwear else 17
  def box(l):
   y,x=np.where(l>0);return dict(left=float(x.min()),top=float(y.min()),right=float(x.max()+1),bottom=float(y.max()+1),source='segmented')
  row=dict(time=0.,x=256.,y=280.,width=150.,height=180.,visualPoint=dict(x=256.,y=280.));r1={**row,'time':1/15,'x':256.+dx,'y':280.+dy,'visualPoint':dict(x=256.+dx,y=280.+dy)}
  return image,labels,box(labels),row,im1,l1,box(l1),r1,120+dy
 def test_background_extension_does_not_become_headwear(self):
  im,l,b,r,im1,l1,b1,r1,top=self.fixture();t=ContourMotion();t.constrain(im,l,(0,0,512,512),r,b);actual=t.constrain(im1,l1,(0,0,512,512),r1,b1);self.assertGreater(actual['top'],top-30);self.assertLessEqual(actual['top'],top+1);self.assertEqual([actual[k]for k in ['left','right','bottom']],[b1[k]for k in ['left','right','bottom']])
 def test_camera_motion_is_not_evidence_that_background_is_head(self):
  im,l,b,r,im1,l1,b1,r1,top=self.fixture(camera=True);t=ContourMotion();t.constrain(im,l,(0,0,512,512),r,b);actual=t.constrain(im1,l1,(0,0,512,512),r1,b1);self.assertGreater(actual['top'],top-30)
 def test_no_headwear_preserves_current_silhouette(self):
  im,l,b,r,im1,l1,b1,r1,top=self.fixture(headwear=False);t=ContourMotion();self.assertEqual(t.constrain(im,l,(0,0,512,512),r,b),b);self.assertEqual(t.constrain(im1,l1,(0,0,512,512),r1,b1),b1)
 def test_new_run_does_not_inherit_previous_shape(self):
  im,l,b,r,im1,l1,b1,r1,top=self.fixture();t=ContourMotion();t.constrain(im,l,(0,0,512,512),r,b);t.reset();self.assertEqual(t.constrain(im1,l1,(0,0,512,512),r1,b1),b1)
if __name__=='__main__':unittest.main()
