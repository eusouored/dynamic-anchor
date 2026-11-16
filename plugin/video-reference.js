'use strict';
// Strict contract for the experimental MediaPipe VIDEO + centered MM15 point.
// It is intentionally separate from the legacy YuNet mean-five reference.
const METHOD='mediapipe-canthi-video-mm15-aligned-v1';
const EPOCH='0.3.8';
// 0.9.46 / CONTRATO-0946: referência v2 (motor 0.3.12) com amostragem auditável. Linhas 'sampled'
// são reconstruídas entre duas observações válidas; nunca contam como medição. v1 segue estrito.
const METHOD_V2='mediapipe-canthi-video-mm15-aligned-v2';
const EPOCH_V2='0.3.12';
// 0.9.47 / CONTRATO-0947: referência v3 (motor 0.3.13). Agendamento fixo (1 em 1, 2 ou 3) e correção
// lenta do desvio entre olhos e caixa (média centrada de 2 s, só com caixas observadas). O offset do
// quadro 0 fica como proveniência; o ponto rastreado não é mais olhos + offset constante.
const METHOD_V3='mediapipe-canthi-box-mm15-v3';
const EPOCH_V3='0.3.13';
const SAMPLING_STEPS=new Set([1,2,3]);
const MODEL_SHA256='64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
// Keep this enum aligned with the backend's emitted loss reasons. Unknown
// values still fail closed; don't collapse distinct detector/association gaps.
const REASONS=new Set(['yunet-missing','yunet-multiple','yunet-not-selected','mediapipe-missing','canthi-outside-box','invalid-timestamp','decoder-gap']);
const REASONS_V2=new Set([...REASONS,'sampling-gap','association-discontinuity']);
const versionAtLeast=(v,min)=>{const a=String(v||'').split('.').map(Number),b=min.split('.').map(Number);if(a.length!==3||a.some(n=>!Number.isInteger(n)||n<0))return false;for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];return true;};
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const point=p=>!!p&&finite(p.x)&&finite(p.y);
const sameNumber=(a,b)=>Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
const exactKeys=(value,keys)=>!!value&&Object.keys(value).sort().join('|')===[...keys].sort().join('|');
function isVideo15(ref){return !!ref&&(ref.method===METHOD||ref.method===METHOD_V2||ref.method===METHOD_V3);}
function isV2(ref){return !!ref&&ref.method===METHOD_V2;}
function isV3(ref){return !!ref&&ref.method===METHOD_V3;}
// Pacotes com amostragem auditável (linhas 'sampled', interpolatedFrames): v2 e v3.
function hasSampling(ref){return isV2(ref)||isV3(ref);}
function validateReference(ref,W,H){
  const bad=()=>{throw Error('Referência video15 inválida ou incompatível.');};
  const v2=isV2(ref),v3=isV3(ref),version=v3?3:v2?2:1;
  if(!exactKeys(ref,['schema','method','experimental','offset','anchorIds','mode','model','alignment','smoothing','association',...(v2||v3?['sampling']:[]),...(v3?['driftCorrection']:[])])||ref.schema!==version||ref.method!==[METHOD,METHOD_V2,METHOD_V3][version-1]||ref.experimental!==true||!exactKeys(ref.offset,['x','y'])||!point(ref.offset)||Math.abs(ref.offset.x)>W||Math.abs(ref.offset.y)>H)bad();
  if(!Array.isArray(ref.anchorIds)||ref.anchorIds.length!==2||ref.anchorIds[0]!==133||ref.anchorIds[1]!==362||ref.mode!=='VIDEO')bad();
  if(!exactKeys(ref.model,['name','sha256','runtime','runtimeVersion'])||ref.model.name!=='face_landmarker'||ref.model.sha256!==MODEL_SHA256||ref.model.runtime!=='mediapipe'||ref.model.runtimeVersion!=='1.1.1')bad();
  const a=ref.alignment;
  if(!exactKeys(a,['policy','anchor','boxCenter','sourceTime'])||a.policy!==(v3?'index0-with-box-drift':'index0-fixed')||!exactKeys(a.anchor,['x','y'])||!exactKeys(a.boxCenter,['x','y'])||!point(a.anchor)||!point(a.boxCenter)||!finite(a.sourceTime)||
     a.anchor.x<0||a.anchor.x>W||a.anchor.y<0||a.anchor.y>H||a.boxCenter.x<0||a.boxCenter.x>W||a.boxCenter.y<0||a.boxCenter.y>H||
     !sameNumber(ref.offset.x,a.boxCenter.x-a.anchor.x)||!sameNumber(ref.offset.y,a.boxCenter.y-a.anchor.y))bad();
  const sm=ref.smoothing;
  if(!exactKeys(sm,['method','window','applied','gapPolicy'])||sm.method!=='centered-mean'||sm.window!==15||sm.applied!==true||sm.gapPolicy!=='split')bad();
  const assoc=ref.association;
  if(!exactKeys(assoc,['method','identityVerified'])||assoc.method!==(v2||v3?'selected-yunet-unique-canthi-contained-v2':'single-yunet-selected-canthi-contained-v1')||assoc.identityVerified!==false)bad();
  if(v2||v3){const sa=ref.sampling;if(!exactKeys(sa,['method','step','interpolation','recoveryFrames'])||sa.method!==(v3?'fixed-stride-v1':'adaptive-stride-v1')||!SAMPLING_STEPS.has(sa.step)||sa.interpolation!=='valid-adjacent-endpoints'||sa.recoveryFrames!==(v3?0:15))bad();}
  if(v3){const dc=ref.driftCorrection;if(!exactKeys(dc,['method','windowSeconds'])||dc.method!=='centered-box-offset'||dc.windowSeconds!==2)bad();}
  return ref;
}
function expectedFrameCount(selection,fps){
  const n=(selection.outPoint-selection.inPoint)*fps;
  if(!Number.isFinite(n)||n<=0||n>Number.MAX_SAFE_INTEGER)throw Error('Intervalo video15 inválido.');
  return Math.ceil(n-1e-7);
}
function validateCoverage(cov,selection,fps,retainedFrames,{v2=false,sampledFrames=new Set()}={}){
  const bad=()=>{throw Error('Cobertura de referência video15 inválida ou incompleta.');};
  const expected=expectedFrameCount(selection,fps),reasons=v2?REASONS_V2:REASONS;
  if(!exactKeys(cov,['expectedFrames','measuredFrames','missing','unretainedFrames',...(v2?['interpolatedFrames']:[])])||cov.expectedFrames!==expected||!Number.isInteger(cov.measuredFrames)||cov.measuredFrames<0||cov.measuredFrames>expected||!Array.isArray(cov.missing)||!Array.isArray(cov.unretainedFrames))bad();
  const missing=new Map();
  for(const item of cov.missing){
    if(!exactKeys(item,['frame','time','reason'])||!Number.isInteger(item.frame)||item.frame<0||item.frame>=expected||!finite(item.time)||!reasons.has(item.reason)||missing.has(item.frame)||!sameNumber(item.time,selection.inPoint+item.frame/fps))bad();
    missing.set(item.frame,item.reason);
  }
  const unretained=new Set();
  for(const frame of cov.unretainedFrames){if(!Number.isInteger(frame)||frame<0||frame>=expected||unretained.has(frame)||missing.has(frame)||retainedFrames.has(frame))bad();unretained.add(frame);}
  // v2: interpolatedFrames lista exatamente as linhas 'sampled' (única, crescente, dentro da grade).
  const interpolated=v2?cov.interpolatedFrames:[];
  if(!Array.isArray(interpolated)||interpolated.length!==sampledFrames.size)bad();
  for(let i=0;i<interpolated.length;i++){const f=interpolated[i];if(!Number.isInteger(f)||f<0||f>=expected||(i&&f<=interpolated[i-1])||!sampledFrames.has(f)||!retainedFrames.has(f)||missing.has(f)||unretained.has(f))bad();}
  for(const frame of retainedFrames)if(missing.has(frame)||unretained.has(frame))bad();
  if(retainedFrames.size+unretained.size!==cov.measuredFrames+interpolated.length||cov.measuredFrames+interpolated.length+missing.size!==expected)bad();
  for(let frame=0;frame<expected;frame++)if(!retainedFrames.has(frame)&&!unretained.has(frame)&&!missing.has(frame))bad();
  return {expectedFrames:expected,measuredFrames:cov.measuredFrames,missing:[...cov.missing],unretainedFrames:[...cov.unretainedFrames],...(v2?{interpolatedFrames:[...interpolated]}:{})};
}
function gridIndex(time,selection,fps){
  const k=(time-selection.inPoint)*fps,index=Math.round(k);
  if(!finite(k)||!Number.isSafeInteger(index)||index<0||index>=expectedFrameCount(selection,fps)||!sameNumber(time,selection.inPoint+index/fps))
    throw Error('O trajeto video15 não está na grade da sequência.');
  return index;
}
function validatePackage(pkg,selection,format){
  const bad=()=>{throw Error('Trajeto video15 inválido ou incompleto.');};
  if(!pkg||pkg.version!==2||pkg.engine!=='face-yunet-v1'||!Array.isArray(pkg.rows)||pkg.rows.length<2||!Array.isArray(pkg.segments))bad();
  if(!selection||!format||![selection.inPoint,selection.outPoint,format.fps,format.width,format.height].every(finite)||!(selection.outPoint>selection.inPoint)||format.width<=0||format.height<=0||format.fps<=0||pkg.width!==format.width||pkg.height!==format.height||pkg.fps!==format.fps||pkg.inPoint!==selection.inPoint||pkg.outPoint!==selection.outPoint||pkg.selection?.inPoint!==selection.inPoint||pkg.selection?.outPoint!==selection.outPoint)bad();
  validateReference(pkg.trackingReference,format.width,format.height);
  const v3=isV3(pkg.trackingReference),v2=hasSampling(pkg.trackingReference),step=v2?pkg.trackingReference.sampling.step:1;
  if(v2&&(!versionAtLeast(pkg.engineVersion,v3?EPOCH_V3:EPOCH_V2)||!pkg.stats||pkg.stats.step!==step))bad();
  const expected=expectedFrameCount(selection,format.fps),runs=[],retained=new Set(),sampled=new Set();let frameZeroRow=null;
  const checkedRows=(rows,label)=>{
    if(!Array.isArray(rows)||rows.length<2)bad();
    const indices=[];
    for(const r of rows){
      const raw=r&&r.trackingPoint&&pkg.trackingReference?(v3?{x:r.trackingPoint.x,y:r.trackingPoint.y}:{x:r.trackingPoint.x-pkg.trackingReference.offset.x,y:r.trackingPoint.y-pkg.trackingReference.offset.y}):null;
      if(!exactKeys(r,['time','x','y','width','height','confidence','source','trackingPoint'])||!exactKeys(r.trackingPoint,['x','y'])||![r.time,r.x,r.y,r.width,r.height,r.confidence].every(finite)||r.width<=0||r.height<=0||r.confidence<.5||r.confidence>1||r.x<0||r.y<0||r.x>format.width||r.y>format.height||!(r.source==='detected'||v2&&r.source==='sampled')||!point(r.trackingPoint)||!point(raw)||raw.x<0||raw.y<0||raw.x>format.width||raw.y>format.height)bad();
      const index=gridIndex(r.time,selection,format.fps);
      if(indices.length&&index!==indices[indices.length-1]+1)bad();
      if(index===0)frameZeroRow=r;
      if(retained.has(index))bad();retained.add(index);indices.push(index);
      if(r.source==='sampled')sampled.add(index);
    }
    // Reconstrução só entre duas observações da mesma corrida, no máximo step quadros entre elas:
    // nunca na ponta (sem extrapolar) e nunca através de uma falta (a corrida é contígua).
    if(rows[0].source!=='detected'||rows[rows.length-1].source!=='detected')bad();
    let inside=0;for(const r of rows){inside=r.source==='sampled'?inside+1:0;if(inside>step-1)bad();}
    return {indices,start:rows[0].time,end:rows[rows.length-1].time,count:rows.length};
  };
  const primary=checkedRows(pkg.rows,'primary');
  let primaryCount=0,primaryRun=null,previous=-1;
  for(const segment of pkg.segments){
    if(!exactKeys(segment,['start','end','samples','primary','rows'])||typeof segment.primary!=='boolean'||!Number.isInteger(segment.samples)||!finite(segment.start)||!finite(segment.end))bad();
    let run;
    if(segment.primary){
      primaryCount++;if(!Array.isArray(segment.rows)||segment.rows.length!==0||segment.samples!==primary.count)bad();
      run=primary;
    }else{
      run=checkedRows(segment.rows,'auxiliary');
      if(segment.samples!==run.count)bad();
    }
    if(!sameNumber(segment.start,run.start)||!sameNumber(segment.end,run.end)||
       run.indices[0]<=previous||(previous>=0&&run.indices[0]===previous+1))bad();
    if(segment.primary)primaryRun=run;
    previous=run.indices[run.indices.length-1];runs.push(run);
  }
  if(primaryCount!==1||runs.length!==pkg.stats?.segments)bad();
  const longest=runs.reduce((best,run)=>run.count>best.count||run.count===best.count&&run.indices[0]<best.indices[0]?run:best,runs[0]);
  if(primaryRun!==longest)bad();
  const unretained=new Set();
  for(const frame of pkg.referenceCoverage?.unretainedFrames||[]){
    if(!Number.isInteger(frame)||frame<0||frame>=expected||unretained.has(frame)||retained.has(frame))bad();unretained.add(frame);
  }
  const coverage=validateCoverage(pkg.referenceCoverage,selection,format.fps,retained,{v2,sampledFrames:sampled});
  if(v2&&pkg.stats.interpolatedRows!==sampled.size)bad();
  for(const frame of unretained)if(retained.has(frame-1)||retained.has(frame+1)||unretained.has(frame-1)||unretained.has(frame+1))bad();
  // v3 (0.9.48): agendamento fixo ancorado no quadro 0. Observação (detected/unretained) só em índice
  // agendado; reconstrução só fora dele. Perdas em índice pulado mantêm o motivo real (decoder/timestamp).
  if(v3){for(const frame of retained)if((frame%step===0)===sampled.has(frame))bad();for(const frame of unretained)if(frame%step!==0)bad();}
  const sourceTime=pkg.trackingReference.alignment.sourceTime;
  // sourceTime is raw decoder PTS for row zero, not its rounded grid time.
  // quadros() intentionally admits the first PTS within half a media frame.
  if(coverage.expectedFrames!==expected||coverage.measuredFrames+sampled.size!==retained.size+unretained.size||frameZeroRow&&frameZeroRow.source!=='detected'||
     coverage.missing.some(item=>item.frame===0)||(!retained.has(0)&&!unretained.has(0))||
     frameZeroRow&&(!sameNumber(frameZeroRow.x,pkg.trackingReference.alignment.boxCenter.x)||
       !sameNumber(frameZeroRow.y,pkg.trackingReference.alignment.boxCenter.y))||
     sourceTime<selection.inPoint-0.5/format.fps-1e-6||sourceTime>selection.inPoint+0.5/format.fps+1e-6)bad();
  const expectedCoverage=primary.count/expected;
  if(!finite(pkg.coverage)||pkg.coverage<0||pkg.coverage>1||!sameNumber(pkg.coverage,expectedCoverage))bad();
  return {coverage,runs,retainedFrames:retained};
}
module.exports={METHOD,METHOD_V2,METHOD_V3,EPOCH,EPOCH_V2,EPOCH_V3,REASONS_V2,isV2,isV3,hasSampling,versionAtLeast,MODEL_SHA256,REASONS,isVideo15,validateReference,expectedFrameCount,validateCoverage,gridIndex,validatePackage};
