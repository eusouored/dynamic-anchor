import copy,time,os
import numpy as np
import anchor_rosto as R
import anchor_head as H

def execute(job,options,progress=None,cancelled=None,inform=None,measure=True):
 started=time.perf_counter()
 if cancelled and cancelled():raise R.Cancelado('Análise cancelada.')
 parser=H.HeadParser()
 visual=None
 if os.environ.get('ANCHOR_OFFICE_CANDIDATE','1')=='1':
  from anchor_visual_candidate import Continuity
  def visual_cancelled():
   if cancelled and cancelled():raise R.Cancelado('Análise cancelada.')
   return False
  visual=Continuity(job['width'],job['height'],visual_cancelled)
 parser.visual_enabled=visual is not None;model_ready=time.perf_counter();records={};observations=[];head_seconds=0.;infer_seconds=0.;previous=None
 def scale(o,image,visual_point):
  sx,sy=image.shape[1]/job['width'],image.shape[0]/job['height']
  return {**o,'x':o['x']*sx,'y':o['y']*sy,'width':o['width']*sx,'height':o['height']*sy,
   'visualPoint':{'x':visual_point['x']*sx,'y':visual_point['y']*sy},
   'otherFaces':[{k:f[k]*(sx if k in('x','width')else sy)for k in('x','y','width','height')}for f in o.get('otherFaces',[])]}
 def observe(o,image,visual_point,scaled=None,inferred=None,gray=None):
  nonlocal head_seconds,previous
  if cancelled and cancelled():raise R.Cancelado('Análise cancelada.')
  if o.get('_visual_missing'):
   if visual is not None:visual.add(o['time'],image,None,None,0,o['otherFaces'],gray=gray)
   return
  sx,sy=image.shape[1]/job['width'],image.shape[0]/job['height']
  if previous is not None and o['time']-previous>max(.4,((options['passo']if isinstance(options['passo'],int)else 1)+.5)/job['fps']):parser.reset()
  previous=o['time']
  if scaled is None:scaled=scale(o,image,visual_point)
  at=time.perf_counter();b=parser.detect(image,scaled,inferred);head_seconds+=time.perf_counter()-at
  if b is not None:
   b={**b,**{k:b[k]/(sx if k in('left','right')else sy)for k in('left','top','right','bottom')}}
   if b.get('_motion'):
    matrix=np.array(b['_motion']['matrix'],float);matrix[0]*=1/sx;matrix[1]*=1/sy;matrix[:,:2]=matrix[:,:2]@np.diag([sx,sy]);b['_motion']={**b['_motion'],'matrix':matrix.tolist()}
  records[o['time']]=(b,copy.deepcopy(getattr(parser,'visibility',None)))
  if visual is not None:
   # This whole-result protection already exists in apply(). Stop collecting
   # images as soon as its cause is known, without changing any head reading.
   if b is not None and b.get('_motion'):
    visual.disable('headwear-reference-protected');parser.visual_enabled=False
   visual.add(o['time'],image,b,getattr(parser,'visibility',None),getattr(parser,'visual_hair_count',0),o.get('otherFaces',[]),gray=gray)
 old=dict(options,referencia='adaptativo',previa=None,usar_proxy=False)
 from anchor_ordered_observer import PreparedOrderedObserver
 import threading
 worker=None;infer_lock=threading.Lock()
 def prepare(o,image,visual_point):
  # Stateless part of a read (head model, label measurements, gray image), run
  # ahead on the preparation workers; observe() keeps every stateful step
  # (contour, visibility, records, visual collection) in the original order.
  nonlocal infer_seconds
  # Only a precomputation: if collection stops meanwhile, add() ignores it;
  # if it was skipped, add() computes the same image itself.
  gray=visual.reduce(image) if visual is not None and visual.disabled_reason is None and visual.collection_stopped_reason is None else None
  if o.get('_visual_missing'):return None,None,gray
  scaled=scale(o,image,visual_point)
  at=time.perf_counter();prepared=parser.prepare(image,scaled);spent=time.perf_counter()-at
  with infer_lock:infer_seconds+=spent
  return scaled,prepared,gray
 try:
  if options.get('paralelo',False):
   worker=PreparedOrderedObserver(prepare,observe,2 if (os.cpu_count() or 1)>=12 else 1,cancelled,lambda:R.Cancelado('Análise cancelada.'))
  entry=worker if worker is not None else observe
  try:
   base=R.executar(job,old,(lambda f,n,s:progress(.95*f,n,s))if progress else None,cancelled,inform,measure,_observations=observations,_reference_motion='similarity',_image_observer=entry,_visual_missing_observer=entry if visual is not None else None)
   if worker is not None:worker.finish()
  finally:
   if worker is not None:worker.abort()
   if visual is not None:visual.collector.abort()
  head_seconds+=infer_seconds
  face_done=time.perf_counter();groups=[base['rows']]+[s['rows']for s in base['segments']if not s['primary']];plan=H.read_plan(groups,observations,base['fps'],job['inPoint']);measurements=[{}for _ in groups];accepted=0
  for t,g,i,o in plan:
   b,visibility=records[t];measurements[g][i]=b;accepted+=b is not None
   if visibility is not None:groups[g][i]['headVisibility']=visibility
   if o.get('otherFaces'):groups[g][i]['otherFaces']=o['otherFaces']
  result=H.finish_head(job,options,progress,started,model_ready,face_done,base,groups,measurements,base['stats']['step'],base['fps'],plan,accepted,head_seconds,parser,base['mediaFps'],cancelled)
  visual_started=time.perf_counter();visual_seconds=0.
  # 0.5.3: o trajeto do rosto (sem cabeça) não passa pela continuidade visual, que corrige contornos de cabeça.
  if visual is not None and 'headFallback' not in result['trackingReference']:
   if any(row.get('headMotion') for group in [result['rows']]+[s['rows'] for s in result.get('segments',[]) if not s.get('primary')] for row in group):visual.disable('headwear-reference-protected')
   elif any(item.get('accepted') for item in result['stats'].get('headReferenceRepair',[])):visual.disable('existing-reference-repair-protected')
   visual.finalize(result)
   intervals=visual.apply(result)
   result['stats']['visualContinuityCandidate']={'intervals':intervals,'discarded':visual.collector.discarded,'processed':visual.collector.processed,'collectionStoppedReason':visual.collection_stopped_reason}
   if any(interval.get('accepted') for interval in intervals):
    from anchor_camera_micro_candidate import apply_to_result
    result['stats']['visualContinuityCandidate']['cameraRefinement']=apply_to_result(result,visual_cancelled)
   visual_seconds=time.perf_counter()-visual_started
  result['stats']['headPipeline']='single-decode-ordered-head-worker-v1'if worker is not None else'single-decode-inline-v1';result['stats']['headWorker']=dict(submitted=worker.submitted,completed=worker.completed,queueHighWater=worker.high_water)if worker is not None else None;result['stats']['phaseSeconds']={'model':round(model_ready-started,3),'pipeline':round(face_done-model_ready,3),'fusion':result['stats']['phaseSeconds']['fusion']};result['stats']['headInlineReads']=len(records)
  result['stats']['phaseSeconds']['visualContinuity']=round(visual_seconds,3)
  result['stats']['headInferSeconds']=round(infer_seconds,3)
  result['stats']['seconds']=round(time.perf_counter()-started,3)
  return result
 finally:
  if visual is not None:visual.close()
