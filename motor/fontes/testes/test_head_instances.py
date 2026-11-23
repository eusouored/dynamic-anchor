import unittest,sys,numpy as np
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]));import anchor_head as H
class InstanceTests(unittest.TestCase):
 def test_larger_selected_face_does_not_absorb_smaller_rival_hair(self):
  from anchor_instances import selected_labels
  labels=np.zeros((200,240),np.uint8);labels[35:150,60:200]=17;labels[70:140,70:130]=1;labels[90:135,140:170]=1
  row=dict(x=100.,y=100.,width=60.,height=90.,otherFaces=[dict(x=155.,y=110.,width=30.,height=45.)])
  isolated=selected_labels(labels,(0,0,240,200),row)
  self.assertEqual(isolated[35,170],0)
  self.assertEqual(isolated[100,100],1)
  self.assertEqual(isolated[35,80],17)
 def test_background_accessory_cannot_join_target_hair_to_second_face(self):
  labels=np.zeros((160,160),np.uint8);labels[52:125,58:92]=1;labels[25:100,35:64]=17;labels[38:55,54:85]=17;labels[0:55,84:160]=18;labels[35:65,105:125]=1
  row=dict(x=75.,y=88.,width=36.,height=72.,otherFaces=[dict(x=115.,y=50.,width=20.,height=30.)]);b=H.extract_bounds(labels,(0,0,160,160),row);self.assertIsNotNone(b);self.assertEqual(b['top'],25.);self.assertLess(b['right'],105.)
 def test_touching_other_face_is_excluded_while_selected_core_and_long_hair_survive(self):
  labels=np.zeros((160,160),np.uint8);labels[60:130,60:100]=1;labels[30:105,35:68]=17;labels[40:75,95:130]=1;labels[63:72,98:100]=1
  row=dict(x=80.,y=95.,width=40.,height=70.,otherFaces=[dict(x=113.,y=57.,width=35.,height=35.)]);b=H.extract_bounds(labels,(0,0,160,160),row);self.assertIsNotNone(b);self.assertEqual(b['top'],30.);self.assertEqual(b['left'],35.);self.assertLess(b['right'],110.)
 def test_thin_accessory_filament_cannot_extend_hair_far_upward(self):
  labels=np.zeros((160,160),np.uint8);labels[60:130,60:100]=1;labels[35:100,35:68]=17;labels[10:60,66:68]=18;labels[55:61,66:94]=18
  b=H.extract_bounds(labels,(0,0,160,160),dict(x=80.,y=95.,width=40.,height=70.));self.assertEqual(b['top'],35.)
 def test_real_cap_keeps_top_in_single_target_case(self):
  labels=np.zeros((160,160),np.uint8);labels[60:130,60:100]=1;labels[25:65,48:110]=18;row=dict(x=80.,y=95.,width=40.,height=70.);b=H.extract_bounds(labels,(0,0,160,160),row);self.assertEqual(b['top'],25.)
 def test_duplicate_detection_does_not_exclude_selected_face(self):
  labels=np.zeros((160,160),np.uint8);labels[60:130,60:100]=1;labels[30:100,35:68]=17;row=dict(x=80.,y=95.,width=40.,height=70.);expected=H.extract_bounds(labels,(0,0,160,160),row);row['otherFaces']=[dict(x=81.,y=94.,width=41.,height=69.)];self.assertEqual(H.extract_bounds(labels,(0,0,160,160),row),expected)
 def test_clipped_cap_without_independent_hair_evidence_is_still_rejected(self):
  labels=np.zeros((160,160),np.uint8);labels[60:130,60:100]=1;labels[0:65,48:110]=18;row=dict(x=80.,y=95.,width=40.,height=70.);self.assertIsNone(H.extract_bounds(labels,(0,0,160,160),row))
 def test_clipped_hair_still_refuses_to_claim_complete_head(self):
  labels=np.zeros((160,160),np.uint8);labels[0:105,35:68]=17;labels[60:130,60:100]=1;row=dict(x=80.,y=95.,width=40.,height=70.);self.assertIsNone(H.extract_bounds(labels,(0,0,160,160),row))
if __name__=='__main__':unittest.main()
