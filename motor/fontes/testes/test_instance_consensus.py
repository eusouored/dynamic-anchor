import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from anchor_head import competing_bounds,instance_consensus

class InstanceConsensusTests(unittest.TestCase):
 def setUp(self):
  self.row=dict(x=100.,y=100.,width=40.,height=60.,otherFaces=[dict(x=150.,y=100.,width=30.,height=40.)])
  self.wide={'bounds':dict(left=70.,top=40.,right=170.,bottom=130.)}
  self.tight={'bounds':dict(left=70.,top=40.,right=125.,bottom=130.)}
 def test_other_face_outside_does_not_need_verification(self):
  self.assertFalse(competing_bounds(self.tight['bounds'],self.row))
 def test_attached_rival_region_needs_verification(self):
  self.assertTrue(competing_bounds(self.wide['bounds'],self.row))
 def test_duplicate_detection_does_not_count_as_another_person(self):
  row={**self.row,'otherFaces':[dict(x=101.,y=99.,width=41.,height=59.)]}
  self.assertFalse(competing_bounds(self.wide['bounds'],row))
 def test_complete_tighter_crop_can_separate_the_rival(self):
  self.assertIs(instance_consensus(self.wide,self.tight,self.row),self.tight)
 def test_agreement_cannot_certify_two_overlapping_people_as_one_head(self):
  similar={'bounds':{**self.wide['bounds'],'right':168.}}
  self.assertIsNone(instance_consensus(self.wide,similar,self.row))
 def test_missing_independent_contour_refuses_ambiguous_measurement(self):
  self.assertIsNone(instance_consensus(self.wide,{'bounds':None},self.row))
  self.assertIsNone(instance_consensus(self.wide,None,self.row))
 def test_disagreement_that_still_includes_rival_is_not_published(self):
  other={'bounds':{**self.wide['bounds'],'top':10.}}
  self.assertIsNone(instance_consensus(self.wide,other,self.row))
 def test_same_decision_at_different_sequence_resolutions(self):
  for s in [.25,2.]:
   row={k:v*s if isinstance(v,float)else v for k,v in self.row.items()}
   row['otherFaces']=[{k:v*s for k,v in f.items()}for f in self.row['otherFaces']]
   a={'bounds':{k:v*s for k,v in self.wide['bounds'].items()}}
   b={'bounds':{k:v*s for k,v in self.tight['bounds'].items()}}
   self.assertIs(instance_consensus(a,b,row),b)

if __name__=='__main__':unittest.main()
