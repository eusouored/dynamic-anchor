"""Selected whole-head reference. Face boxes remain original observations."""
import copy,hashlib,importlib.util,sys,time
from pathlib import Path
import cv2
import numpy as np
from anchor_head_runtime import create_session
MODEL_SHA='0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f'
MODEL_NAME='head_parsing_resnet18.onnx'
LABEL_MODEL_NAME='head_parsing_resnet18_labels.onnx'
LABEL_MODEL_SHA='4dcffd36ede4d4730f4587503a4273efc457eff95a29c98bb4ed19378342d088'
METHOD='selected-head-hybrid-v3'
OFFSET_SIGMA_SECONDS=.4
SELECTION='selected-face-overlap-v1'

NO_CROP=object()  # infer() found an empty crop: detect() returns None, as before

def model_path():return Path(getattr(sys,'_MEIPASS',Path(__file__).resolve().parent))/MODEL_NAME

def capability():
 try:return model_path().is_file() and importlib.util.find_spec('onnxruntime') is not None and hashlib.sha256(model_path().read_bytes()).hexdigest()==MODEL_SHA
 except (OSError,ValueError,ImportError):return False

class HeadParser:
 def __init__(self):
  if not capability():raise RuntimeError('Modelo de cabeça ausente ou incompatível. Prepare o motor novamente.')
  import onnxruntime as ort
  from anchor_contour import ContourMotion
  self.contour=ContourMotion()
  labels_path=model_path().with_name(LABEL_MODEL_NAME)
  self.labels_output=labels_path.is_file() and hashlib.sha256(labels_path.read_bytes()).hexdigest()==LABEL_MODEL_SHA
  self.runtime_fallback=None
  use_dml=self.labels_output and 'DmlExecutionProvider' in ort.get_available_providers()
  if not use_dml:self.runtime_fallback='dml-unavailable' if self.labels_output else 'labels-model-unavailable-or-incompatible'
  path=labels_path if self.labels_output else model_path()
  try:self.session=create_session(ort,path,dml=use_dml)
  except Exception as error:
   if not use_dml:raise
   self.runtime_fallback=type(error).__name__+': '+str(error)[:160]
   self.session=create_session(ort,path)
  self.provider=self.session.get_providers()[0]
  self.input=self.session.get_inputs()[0].name
  import threading
  self._local=threading.local();self._run_lock=threading.Lock()
  self._mean=np.array([.485,.456,.406],np.float32);self._std=np.array([.229,.224,.225],np.float32)
 def reset(self):self.contour.reset()
 def runtime_info(self):
  return dict(provider=self.provider,providers=self.session.get_providers(),labelsOutput=self.labels_output,graphSha256=LABEL_MODEL_SHA if self.labels_output else MODEL_SHA,fallback=self.runtime_fallback,inputShape=self.session.get_inputs()[0].shape,configuration='fixed-nospin' if self.provider=='DmlExecutionProvider' else 'cpu-default',cpuPartitionsAllowed=self.provider=='DmlExecutionProvider',nodePlacementVerified=False)
 def infer(self,image,row):
  """Model stage only (crop, resize, normalize, run). Holds no tracking state,
  so it can run one read ahead of detect() on another thread."""
  H,W=image.shape[:2];x,y,w,h=[row[k]for k in ('x','y','width','height')];side=max(w*2.7,h*2.5)
  x0,y0=max(0,int(x-side/2)),max(0,int(y-h*.35-side/2));x1,y1=min(W,int(x+side/2)),min(H,int(y-h*.35+side/2));crop=image[y0:y1,x0:x1]
  if crop.size==0:return None
  rgb8=cv2.cvtColor(cv2.resize(crop,(512,512),interpolation=cv2.INTER_LINEAR),cv2.COLOR_BGR2RGB)
  # One input buffer per thread; DirectML does not accept concurrent Run calls
  # on one session, so only the run itself is serialized.
  inp=getattr(self._local,'buffer',None)
  if inp is None:inp=self._local.buffer=np.empty((1,3,512,512),dtype=np.float32)
  for channel in range(3):
   plane=inp[0,channel];np.divide(rgb8[:,:,channel],np.float32(255),out=plane);np.subtract(plane,self._mean[channel],out=plane);np.divide(plane,self._std[channel],out=plane)
  with self._run_lock:
   try:output=self.session.run(None,{self.input:inp})[0][0]
   except Exception as error:
    if self.provider!='DmlExecutionProvider':raise
    import onnxruntime as ort
    self.runtime_fallback='runtime-'+type(error).__name__+': '+str(error)[:160]
    self.session=create_session(ort,model_path().with_name(LABEL_MODEL_NAME));self.provider=self.session.get_providers()[0];self.input=self.session.get_inputs()[0].name
    output=self.session.run(None,{self.input:inp})[0][0]
  labels=output if self.labels_output else output.argmax(axis=0).astype(np.uint8)
  return labels,(x0,y0,x1,y1),rgb8
 def prepare(self,image,row):
  """infer() plus the measurements that depend only on the labels.

  selected_labels() depends on the contour's headwear state, which only the
  ordered detect() owns. prepare() uses the state it sees now; detect()
  recomputes these measurements if the state differs when it runs."""
  inferred=self.infer(image,row)
  if inferred is None:return NO_CROP
  return self._measure(inferred,row,self.contour.headwear is not True)
 def _measure(self,inferred,row,allow):
  labels,crop,rgb8=inferred
  from anchor_instances import selected_labels
  labels=selected_labels(labels,crop,row,allow_border_rejection=allow)
  visibility=measure_visibility(labels,crop,row)
  component_out=[];bounds=extract_bounds(labels,crop,row,_clean=False,_component_out=component_out)
  gray=cv2.cvtColor(rgb8,cv2.COLOR_RGB2GRAY) if bounds is not None and 'time'in row else None
  return dict(inferred=inferred,allow=allow,labels=labels,hair=int(np.count_nonzero(labels==17)),visibility=visibility,bounds=bounds,component=component_out[0] if component_out else None,gray=gray)
 def detect(self,image,row,prepared=None):
  self.visual_hair_count=0
  allow=self.contour.headwear is not True
  if prepared is None:
   inferred=self.infer(image,row)
   if inferred is None:return None
   prepared=self._measure(inferred,row,allow)
  elif prepared is NO_CROP:return None
  elif prepared['allow']!=allow:prepared=self._measure(prepared['inferred'],row,allow)
  labels,(x0,y0,x1,y1)=prepared['labels'],prepared['inferred'][1]
  if getattr(self,'visual_enabled',False):self.visual_hair_count=prepared['hair']
  self.visibility=prepared['visibility']
  bounds=prepared['bounds']
  if bounds is not None and 'time'in row:
   bounds=self.contour.constrain(prepared['gray'],labels,(x0,y0,x1,y1),{**row,'headVisibility':self.visibility},bounds,raw_component=prepared['component'])
   if self.contour.motion is not None:bounds={**bounds,'_motion':copy.deepcopy(self.contour.motion)}
   bounds['_visibility']=self.visibility
  return bounds

def measure_visibility(labels,crop,row):
 x0,y0,x1,y1=crop;mh,mw=labels.shape;x,y,w,h=[row[k]for k in ('x','y','width','height')]
 left,top,right,bottom=[round(v)for v in ((x-w*.5-x0)*mw/(x1-x0),(y-h*.5-y0)*mh/(y1-y0),(x+w*.5-x0)*mw/(x1-x0),(y+h*.5-y0)*mh/(y1-y0))]
 roi=labels[max(0,top):min(mh,bottom),max(0,left):min(mw,right)];counts=np.bincount(roi.ravel(),minlength=19);area=max(1.,w*h*mw*mh/((x1-x0)*(y1-y0)))
 parts={name:float(sum(counts[k]for k in classes)/area)for name,classes in [('eyes',[4,5,6]),('nose',[10]),('mouth',[11,12,13])]}
 groups=sum(parts[name]>=threshold for name,threshold in [('eyes',.003),('nose',.006),('mouth',.003)])
 return dict(parts=parts,groups=groups,occluded=groups<2 or row.get('source')=='tracked')

def extract_bounds(labels,crop,row,_clean=True,_component_out=None):
 if _clean:
  from anchor_instances import selected_labels
  labels=selected_labels(labels,crop,row)
 x0,y0,x1,y1=crop;x,y,w,h=[row[k]for k in ('x','y','width','height')];mh,mw=labels.shape
 head=np.isin(labels,[1,2,3,4,5,6,7,8,10,11,12,13,17,18]).astype(np.uint8)
 # Hair below the jaw is hairstyle length, not the head's anatomical extent.
 head[np.arange(mh) > (y+.55*h-y0)*mh/(y1-y0),:] = 0
 n,components,_,_=cv2.connectedComponentsWithStats(head,8)
 fx0,fy0,fx1,fy1=[round(v)for v in ((x-w/2-x0)*mw/(x1-x0),(y-h/2-y0)*mh/(y1-y0),(x+w/2-x0)*mw/(x1-x0),(y+h/2-y0)*mh/(y1-y0))]
 inside=components[max(0,fy0):min(mh,fy1),max(0,fx0):min(mw,fx1)];scores=[int(np.sum(inside==i))for i in range(1,n)]
 if not inside.size or not scores or max(scores)<inside.size*.3:return None
 component=1+int(np.argmax(scores));mask=(components==component).astype(np.uint8);left,top,width,height=cv2.boundingRect(mask)
 # A contour touching the crop cannot establish the complete head.
 if top==0 or top+height==mh or left==0 or left+width==mw:return None
 box=dict(left=float(x0+left*(x1-x0)/mw),top=float(y0+top*(y1-y0)/mh),right=float(x0+(left+width)*(x1-x0)/mw),bottom=float(y0+(top+height)*(y1-y0)/mh),source='segmented')
 bh,bw=box['bottom']-box['top'],box['right']-box['left']
 if not(.65*h<=bh<=2.7*h and .5*w<=bw<=3*w):return None
 if _component_out is not None:_component_out.append(mask)
 return box

def head_runs(rows,measurements,fps,step,face_fallback=False):
 """Reconstruct only between measured endpoints, never over a long loss."""
 if face_fallback:
  from anchor_head_shape import reliable_measurements
  measurements=reliable_measurements(rows,measurements)
 valid=sorted((i,b)for i,b in measurements.items()if b is not None);runs=[];current=[]
 if face_fallback:
  if not valid or len(rows)<2:return []
  # The enclosing facial run already establishes selected-target continuity.
  # Fill only loss of the silhouette; never bridge a missing facial run here.
  indices=np.array([i for i,b in valid]);run=[]
  for i,original in enumerate(rows):
   if original.get('trackingPoint') is None:raise ValueError('Selected face reference missing during head fallback')
   left=int(np.searchsorted(indices,i));prior=valid[left-1]if left else None;after=valid[left]if left<len(valid)else None
   if after and after[0]==i:b=dict(after[1])
   elif prior and after and rows[after[0]]['time']-rows[prior[0]]['time']<=max(.25,(step+.5)/fps)+1e-7:
    u=(original['time']-rows[prior[0]]['time'])/(rows[after[0]]['time']-rows[prior[0]]['time']);b={**{k:prior[1][k]+(after[1][k]-prior[1][k])*u for k in ('left','top','right','bottom')},'source':'interpolated'}
   else:
    fp=original['trackingPoint']
    def transported(entry):
     anchor,bounds=entry;ap=rows[anchor]['trackingPoint'];scale=float(np.clip(np.sqrt(original['width']*original['height']/max(1e-8,rows[anchor]['width']*rows[anchor]['height'])),.5,2.))
     return {k:fp['x'if k in ('left','right')else'y']+(bounds[k]-ap['x'if k in ('left','right')else'y'])*scale for k in ('left','top','right','bottom')}
    if prior and after:
     a,z=transported(prior),transported(after);u=(original['time']-rows[prior[0]]['time'])/(rows[after[0]]['time']-rows[prior[0]]['time']);b={k:a[k]*(1-u)+z[k]*u for k in a}
    else:b=transported(prior or after)
    b['source']='face-propagated'
   row=copy.deepcopy(original);row['faceTrackingPoint']=copy.deepcopy(original['trackingPoint']);motion=b.pop('_motion',None)
   if motion is not None:row['headMotion']=motion
   visibility=b.pop('_visibility',None)
   if visibility is not None:row['headVisibility']=visibility
   row['headBounds']=b;run.append(row)
  fuse_reference(run);return [run]

 for n,(index,bounds)in enumerate(valid):
  additions=[(index,dict(bounds))]
  if n:
   before,prior=valid[n-1];dt=rows[index]['time']-rows[before]['time']
   if dt<=max(.25,(step+.5)/fps)+1e-7:
    additions=[]
    for i in range(before+1,index):
     u=(rows[i]['time']-rows[before]['time'])/dt
     additions.append((i,{**{k:prior[k]+(bounds[k]-prior[k])*u for k in ('left','top','right','bottom')},'source':'interpolated'}))
    additions.append((index,dict(bounds)))
   else:
    if len(current)>=2:runs.append(current)
    current=[]
  for i,b in additions:
   row=copy.deepcopy(rows[i]);row['faceTrackingPoint']=copy.deepcopy(row.get('trackingPoint')or{k:row[k]for k in ('x','y')});motion=b.pop('_motion',None)
   if motion is not None:row['headMotion']=motion
   visibility=b.pop('_visibility',None)
   if visibility is not None:row['headVisibility']=visibility
   row['headBounds']=b;row['trackingPoint']={'x':(b['left']+b['right'])/2,'y':(b['top']+b['bottom'])/2};current.append(row)
 if len(current)>=2:runs.append(current)
 for run in runs:fuse_reference(run)
 return runs

def fuse_reference(run):
 """Follow stabilized facial motion; only the measured head-to-face offset is low-pass.

 Offline symmetric local fits introduce no causal delay to facial translation.
 Interpolated silhouettes never vote as extra independent observations. Each
 tracking run is processed separately, so no offset is inherited across a loss.
 """
 observed=[r for r in run if r['headBounds']['source']=='segmented']
 times=np.array([r['time']for r in observed]);offsets=np.array([[(r['headBounds'][a]+r['headBounds'][b])/2-r['faceTrackingPoint'][axis]for a,b,axis in [('left','right','x'),('top','bottom','y')]]for r in observed])
 from anchor_fit import linear_offsets
 fitted=linear_offsets(times,offsets,np.array([r['time']for r in run]),OFFSET_SIGMA_SECONDS)
 for row,offset in zip(run,fitted):row['trackingPoint']={axis:float(row['faceTrackingPoint'][axis]+offset[j])for j,axis in enumerate(('x','y'))}


def read_plan(groups,observations,fps,in_point):
 """One analyzed source image per representable sequence frame; no synthetic reads."""
 frames={round((row['time']-in_point)*fps):(g,i,row)for g,group in enumerate(groups)for i,row in enumerate(group)};chosen={}
 for observation in observations:
  key=round((observation['time']-in_point)*fps)
  if key not in frames:continue
  g,i,row=frames[key];distance=abs(observation['time']-row['time'])
  if distance>.5/fps+1e-7:continue
  if key not in chosen or distance<chosen[key][0]-1e-9:chosen[key]=(distance,(observation['time'],g,i,observation))
 return sorted((value[1]for value in chosen.values()),key=lambda item:item[0])

def execute_head(job,options,progress,cancelled,inform,measure):
 from anchor_single_decode import execute
 from anchor_video_reader import execute_head as with_selective_reader
 return with_selective_reader(execute,job,options,progress,cancelled,inform,measure)

def execute_head_two_pass(job,options,progress,cancelled,inform,measure):
 import anchor_rosto as R
 started=time.perf_counter();cancelled=cancelled or (lambda:False)
 if cancelled():raise R.Cancelado('Análise cancelada.')
 parser=HeadParser();model_ready=time.perf_counter();old=dict(options,referencia='adaptativo',previa=None,usar_proxy=False);observations=[]
 base=R.executar(job,old,(lambda f,n,s:progress(f*.25,n,n/max(1e-6,time.perf_counter()-started)))if progress else None,cancelled,inform,measure,_observations=observations,_reference_motion="similarity");face_done=time.perf_counter()
 groups=[base['rows']]+[s['rows']for s in base['segments']if not s['primary']];step=base['stats']['step'];fps=base['fps'];plan=read_plan(groups,observations,fps,job['inPoint']);measurements=[{}for g in groups]
 plan.sort(key=lambda z:z[0]);cap,mfps,vw,vh=R.abrir_video(job['mediaPath'],options['aceleracao']);sx,sy=vw/base['width'],vh/base['height'];pointer=0;pending=[];head_seconds=0.;accepted=0;active_group=None
 def needed(t):
  nonlocal pointer
  pending.clear()
  while pointer<len(plan) and plan[pointer][0]<=t+.5/mfps+1e-7:
   target=plan[pointer];pointer+=1
   if abs(t-target[0])<=.55/mfps+1e-6:pending.append(target)
  return bool(pending)
 def decoded_heads():
  for t,image in R.quadros(cap,mfps,job['inPoint'],job['outPoint'],needed):
   if cancelled():raise R.Cancelado('Análise cancelada.')
   if image is not None:yield t,image,tuple(pending),pointer
 producer=R._Produtor(decoded_heads(),R.Cronometro(False),tamanho=2)if options.get('paralelo',False)else None
 try:
  for t,image,targets,consumed in (producer if producer is not None else decoded_heads()):
   if cancelled():raise R.Cancelado('Análise cancelada.')
   for target,group_index,i,observation in targets:
    if active_group!=group_index:
     if hasattr(parser,'reset'):parser.reset()
     active_group=group_index
    visual=groups[group_index][i]['trackingPoint']
    scaled={**observation,'otherFaces':[{**face,**{k:face[k]*(sx if k in ('x','width')else sy)for k in ('x','y','width','height')}}for face in observation.get('otherFaces',[])],'visualPoint':{'x':visual['x']*sx,'y':visual['y']*sy},'x':observation['x']*sx,'y':observation['y']*sy,'width':observation['width']*sx,'height':observation['height']*sy};begin=time.perf_counter();b=parser.detect(image,scaled);head_seconds+=time.perf_counter()-begin
    if b is not None:
     b={**b,**{k:b[k]/(sx if k in ('left','right')else sy)for k in ('left','top','right','bottom')}}
     if b.get('_motion'):
      matrix=np.array(b['_motion']['matrix'],float);matrix[0]*=1/sx;matrix[1]*=1/sy;matrix[:,:2]=matrix[:,:2]@np.diag([sx,sy]);b['_motion']={**b['_motion'],'matrix':matrix.tolist()}
     accepted+=1
    measurements[group_index][i]=b
    if getattr(parser,'visibility',None)is not None:groups[group_index][i]['headVisibility']=copy.deepcopy(parser.visibility)
    if observation.get('otherFaces'):groups[group_index][i]['otherFaces']=copy.deepcopy(observation['otherFaces'])
   if progress:progress(.25+.70*consumed/max(1,len(plan)),base['stats']['decodedFrames'],base['stats']['decodedFrames']/max(1e-6,time.perf_counter()-started))
 finally:
  if producer is not None:producer.fechar()
  cap.release()
 if cancelled():raise R.Cancelado('Análise cancelada.')
 return finish_head(job,options,progress,started,model_ready,face_done,base,groups,measurements,step,fps,plan,accepted,head_seconds,parser,mfps,cancelled)

def finish_head(job,options,progress,started,model_ready,face_done,base,groups,measurements,step,fps,plan,accepted,head_seconds,parser,mfps,cancelled):
 import anchor_rosto as R
 head_done=time.perf_counter();runs=[]
 for group,m in zip(groups,measurements):runs.extend(head_runs(group,m,fps,step,face_fallback=True))
 if not runs:raise R.ErroMotor('Não foi possível reconhecer a cabeça inteira deste alvo com segurança. Nenhum rastreamento foi aplicado.')
 from anchor_head_motion import stabilize as stabilize_occlusion,METHOD as OCCLUSION_METHOD
 occlusion_reports=[stabilize_occlusion(run)for run in runs]
 from anchor_gap_motion import bridge
 runs,gap_samples,gap_report=bridge(runs,job,fps,mfps,step,plan,cancelled)
 from anchor_reference_occlusion import repair as repair_reference
 repaired=[repair_reference(run,cancelled)for run in runs];runs=[r for r,report in repaired];reference_reports=[report for r,report in repaired]
 primary=max(runs,key=len);base['rows']=primary;base['segments']=[dict(start=run[0]['time'],end=run[-1]['time'],samples=len(run),primary=run is primary,rows=[]if run is primary else run)for run in runs]
 expected=int(np.ceil((job['outPoint']-job['inPoint'])*fps-1e-7));base['coverage']=round(min(1.,len(primary)/expected),4)
 base['trackingReference']=dict(method=METHOD,offset=dict(x=0,y=0),sampling=dict(method='fixed-stride-v1',step=step),model=dict(name='bisenet-resnet18-head',sha256=MODEL_SHA,runtime='onnxruntime'),applicationSampling=dict(method='analyzed-source-frames-v1',frameMapping='nearest-sequence-frame-v1'),smoothing=dict(method='robust-local-quadratic-v1',windowSeconds=.14),stabilization=dict(method='face-motion-head-offset-v1',offsetSigmaSeconds=OFFSET_SIGMA_SECONDS,measuredOffsetsOnly=True,maxHeadFraction=.5,headLossFallback='selected-face-scale-bidirectional-shape-v2',visualMotion='similarity-reference-v1',contourMotion='selected-headwear-top-motion-v3',headwearAdaptation=dict(method='visible-accessory-hysteresis-v1',seconds=.2,presentFraction=.12,absentFraction=.02,minimumVisibleParts=2),occlusionMotion=OCCLUSION_METHOD,shapeValidation='face-relative-temporal-shape-v1',offsetSupport='bounded-observed-envelope-v1',gapRecovery='bidirectional-csrt-head-gap-v1',occlusionMaxFraction=.06,occlusionBlendSeconds=.15,occlusionSigmaSeconds=.4),association=dict(method=SELECTION,identityVerified=False,instanceSeparation='face-seeded-competitive-v1'))
 available={round((row['time']-job['inPoint'])*fps)for run in runs for row in run};base['analysisSamples']=[dict(time=groups[g][i]['time'],sourceTime=float(t),mediaFrame=round(t*mfps),source=o['source'])for t,g,i,o in plan if round((groups[g][i]['time']-job['inPoint'])*fps)in available];base['analysisSamples'].extend(gap_samples);base['analysisSamples'].sort(key=lambda item:item['time'])
 fusion_done=time.perf_counter();stats=base['stats'];stats['headReferenceRepair']=reference_reports;stats['headGapMotion']=gap_report;stats.update(segments=len(runs),headMeasurements=accepted,headMissingMeasurements=len(plan)-accepted,headReconstructedRows=sum(r['headBounds']['source']=='interpolated'for run in runs for r in run),headUnavailableFrames=expected-sum(map(len,runs)),headPropagatedRows=sum(r['headBounds']['source']=='face-propagated'for run in runs for r in run),headSeconds=round(head_seconds,3),headScheduledReads=len(plan),headOcclusionMotion=dict(method=OCCLUSION_METHOD,edges=sum(x['edges']for x in occlusion_reports),occludedMeasurements=sum(x.get('occludedMeasurements',0)for x in occlusion_reports),adjustedMeasurements=sum(x['adjustedMeasurements']for x in occlusion_reports),maxCorrectionPixels=max([x['maxCorrectionPixels']for x in occlusion_reports]or[0.]),clampedRows=sum(x['clampedRows']for x in occlusion_reports)),headPipeline='bounded-decode-prefetch-v1'if options.get('paralelo',False)else'sequential-v1',headRuntime=dict(provider=getattr(parser,'provider','unknown'),labelsOutput=getattr(parser,'labels_output',False),graphSha256=LABEL_MODEL_SHA if getattr(parser,'labels_output',False)else MODEL_SHA,fallback=getattr(parser,'runtime_fallback',None)),contourMotion=copy.deepcopy(getattr(getattr(parser,'contour',None),'stats',{})),phaseSeconds=dict(model=round(model_ready-started,3),face=round(face_done-model_ready,3),head=round(head_done-face_done,3),fusion=round(fusion_done-head_done,3)),referenceStrategy=METHOD,seconds=round(time.perf_counter()-started,3))
 if hasattr(parser,'runtime_info'):stats['headRuntime']=parser.runtime_info()
 base['trackingReference']['stabilization']['occlusionReferenceRepair']=dict(method='bounded-contour-reference-v2',maxIntervalSeconds=.5,maxCorrectionFraction=.5,triggerResidualFraction=.10,trustedResidualFraction=.12,minLocalImpulseFraction=.10)
 base['quality']=R.medir_qualidade(primary,fps,[])
 base['trackingReference']['stabilization']['contourMotion']='selected-headwear-top-motion-v4-supported'
 if stats['headMissingMeasurements']:base['warnings'].append('Algumas leituras do contorno foram perdidas. O rosto selecionado mantém o movimento nesses intervalos; contornos propagados ficam identificados.')
 if progress:progress(.99,stats['decodedFrames'],stats['decodedFrames']/max(1e-6,time.perf_counter()-started))
 return base
