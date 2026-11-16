'use strict';
// 0.9.42 — tratamento automático das perdas do rosto (decisão do editor, 27/10/2026):
// - perda curta (até 0,5 s): ponte linear entre o último ponto antes e o primeiro depois;
// - perda longa: mantém o último enquadramento e, no fim da perda, faz uma transição
//   suave (até 0,5 s) até o ponto em que o rosto volta — sem salto na retomada;
// - antes da primeira e depois da última detecção do take: mantém o enquadramento.
// Nenhum quadro detectado é alterado. Toda linha criada é marcada (gap: bridge/hold/ease)
// e listada na evidência. Retomadas com tamanho de rosto muito diferente ficam marcadas
// para conferência (pode ser outra pessoa) e impedem a aplicação automática.
// Módulo puro: sem host, armazenamento ou interface.
const T=require('./trajectory.js'),I=require('./integrity.js'),RT=require('./tracking-reference.js'),R=require('./face-recovery.js');
const KIND='auto-gaps-v1';
const DEFAULTS=Object.freeze({bridgeSeconds:.5,easeSeconds:.5,sizeRatio:1.6});
const fail=message=>{throw Error(message);};
const smoothstep=u=>u<=0?0:u>=1?1:u*u*(3-2*u);
const lerp=(a,b,u)=>a+(b-a)*u;

function synthetic(from,to,u,frame,gap,id){
  const width=lerp(from.width,to.width,u),height=lerp(from.height,to.height,u);
  const row={frame,x:lerp(from.x,to.x,u),y:lerp(from.y,to.y,u),angle:0,width,height,area:width*height,
    confidence:Math.min(from.confidence,to.confidence),interpolated:true,gap,trackingSegment:id};
  if(from.headBounds||to.headBounds)row.headBounds=require('./head-reference.js').blend(from.headBounds,to.headBounds,u);
  if(from.faceTrackingPoint&&to.faceTrackingPoint)row.faceTrackingPoint={x:lerp(from.faceTrackingPoint.x,to.faceTrackingPoint.x,u),y:lerp(from.faceTrackingPoint.y,to.faceTrackingPoint.y,u)};
  if(from.trackingPoint&&to.trackingPoint)row.trackingPoint={x:lerp(from.trackingPoint.x,to.trackingPoint.x,u),y:lerp(from.trackingPoint.y,to.trackingPoint.y,u)};
  if(from.source!==undefined)row.source='gap';
  if(gap==='hold')row.held=true;
  return row;
}

function autoFill(result,selection,format,options={}){
  const o={...DEFAULTS,...options};
  if(!(o.bridgeSeconds>=0)||!(o.easeSeconds>=0)||!(o.sizeRatio>1))fail('Parâmetros do tratamento de perdas inválidos.');
  const record=R.build(result,selection,format),fps=record.format.fps;
  const segments=[...record.segments].sort((a,b)=>a.mask.times[0]-b.mask.times[0]);
  const primary=segments.find(s=>s.primary),video15=RT.isVideo15(primary.mask.trackingReference);
  const expected=Math.ceil((selection.outPoint-selection.inPoint)*fps-1e-7);
  const index=t=>Math.round((t-selection.inPoint)*fps);
  const bridgeMax=Math.round(o.bridgeSeconds*fps),easeMax=Math.round(o.easeSeconds*fps);
  const samplingGaps=new Set((result.referenceCoverage?.missing||[]).filter(r=>r.reason==='sampling-gap').map(r=>r.frame));
  // Fixed sparse reads cannot establish the path across a failed scheduled
  // measurement. Require review even for a short bridge (a rapid reversal can
  // hide there). Planned skips alone, including the last skipped frame, are fine.
  const fixedSparse=result.trackingReference?.sampling?.method==='fixed-stride-v1'&&result.trackingReference.sampling.step>1;
  const failedMeasurements=new Set(fixedSparse?(result.referenceCoverage?.missing||[]).filter(r=>r.reason!=='sampling-gap').map(r=>r.frame):[]);
  const rows=[],gaps=[];let detected=0,visual=0,sampledRows=0,bridged=0,held=0,eased=0,suspect=failedMeasurements.size>0;
  const push=row=>rows.push(row);
  const gapInfo=(a,b,mode,extra={})=>{
    let sparseFailure=false;for(let f=a;f<=b;f++)if(failedMeasurements.has(f)){sparseFailure=true;break;}
    return {start:selection.inPoint+a/fps,end:selection.inPoint+(b+1)/fps,frames:b-a+1,mode,...extra,...(sparseFailure?{sparseFailure:true,suspect:true}:{})};
  };

  // Antes da primeira detecção: mantém o primeiro enquadramento.
  const first=segments[0].mask.rows[0],firstFrame=index(segments[0].mask.times[0]);
  for(let f=0;f<firstFrame;f++){push(synthetic(first,first,0,f,'hold','gap:inicio'));held++;}
  if(firstFrame>0)gaps.push(gapInfo(0,firstFrame-1,'hold',{edge:'start'}));

  segments.forEach((segment,k)=>{
    const startFrame=index(segment.mask.times[0]);
    if(rows.length){
      const prev=rows[rows.length-1],gapFrames=startFrame-prev.frame-1,next=segment.mask.rows[0],id='gap:'+k;
      if(gapFrames<0)fail('Trechos de rosto sobrepostos.');
      if(gapFrames>0){
        const ratio=Math.max(next.height/prev.height,prev.height/next.height),sizeSuspect=!(ratio<=o.sizeRatio);
        // An internal split can also mean reconstruction was rejected despite
        // valid endpoint measurements (for example, a rapid direction change).
        let uncertain=0,sparseFailure=fixedSparse;for(let f=prev.frame+1;f<startFrame;f++){if(samplingGaps.has(f))uncertain++;}
        // Sparse analysis can expand a gap across the bridge/hold threshold.
        // Keep the conservative hold, but require review instead of applying it silently.
        const samplingBoundary=gapFrames>bridgeMax&&uncertain>0&&gapFrames-uncertain<=bridgeMax;
        const suspicious=sizeSuspect||samplingBoundary||sparseFailure;
        if(suspicious)suspect=true;
        if(gapFrames<=bridgeMax){
          for(let j=1;j<=gapFrames;j++){push(synthetic(prev,next,j/(gapFrames+1),prev.frame+j,'bridge',id));bridged++;}
          gaps.push(gapInfo(prev.frame+1,startFrame-1,'bridge',{suspect:suspicious,...(sparseFailure?{sparseFailure:true,sizeSuspect}:{})}));
        }else{
          const easeN=Math.min(easeMax,gapFrames),holdN=gapFrames-easeN;
          for(let j=1;j<=holdN;j++){push(synthetic(prev,prev,0,prev.frame+j,'hold',id));held++;}
          for(let j=1;j<=easeN;j++){push(synthetic(prev,next,smoothstep(j/(easeN+1)),prev.frame+holdN+j,'ease',id));eased++;}
          gaps.push(gapInfo(prev.frame+1,startFrame-1,'hold',{suspect:suspicious,easeFrames:easeN,...(samplingBoundary?{samplingBoundary:true,sizeSuspect}:{}),...(sparseFailure?{sparseFailure:true,sizeSuspect}:{})}));
        }
      }
    }
    for(let i=0;i<segment.mask.rows.length;i++){
      const row=I.clone(segment.mask.rows[i]),frame=index(segment.mask.times[i]);
      // Só detecção real conta como medida; 'sampled' (v2) é reconstrução e fica contada à parte.
      push({...row,frame,trackingSegment:segment.id});if(row.source==='tracked')visual++;else if(row.source==='sampled')sampledRows++;else if(!row.interpolated)detected++;
    }
  });

  // Depois da última detecção: mantém o último enquadramento.
  const last=rows[rows.length-1],lastFrame=last.frame;
  for(let f=lastFrame+1;f<expected;f++){push(synthetic(last,last,0,f,'hold','gap:fim'));held++;}
  if(lastFrame+1<expected)gaps.push(gapInfo(lastFrame+1,expected-1,'hold',{edge:'end'}));

  if(rows.length!==expected||rows.some((r,i)=>r.frame!==i))fail('O trajeto completo não cobre o take quadro a quadro.');
  const times=rows.map(r=>selection.inPoint+r.frame/fps);
  const mask=I.clone(primary.mask);
  Object.assign(mask,{selection:I.clone(selection),rows,times,firstTrackedTime:times[0],lastTrackedTime:times[times.length-1],coveredStart:times[0],
    coveredEnd:Math.min(selection.outPoint,times[times.length-1]+1/fps),partial:false,name:'Rosto — perdas tratadas automaticamente',
    recoveryEvidence:{kind:KIND,recordDigest:record.digest,segmentCount:segments.length,bridgeSeconds:o.bridgeSeconds,easeSeconds:o.easeSeconds,
      detectedFrames:detected,availableFrames:segments.reduce((n,s)=>n+s.mask.rows.length,0),availableCoverage:Math.min(1,segments.reduce((n,s)=>n+s.mask.rows.length,0)/expected),primaryCoverage:primary.mask.rows.length/expected,...(visual?{visualFrames:visual}:{}),...(sampledRows?{sampledFrames:sampledRows}:{}),bridgedFrames:bridged,heldFrames:held,easedFrames:eased,heldSeconds:(held+eased)/fps,
      measuredCoverage:Math.min(1,detected/expected),gaps,suspect}});
  if(video15)mask.recoveryEvidence.video15=true;
  if(require('./head-reference.js').isSampled(result.trackingReference)){mask.recoveryEvidence.keyframeInterpolation='between-analyzed-instants-v1';mask.analysisSamples=I.clone(result.analysisSamples);mask.mediaFps=result.mediaFps;
    // Na referência de cabeça as linhas vêm na grade da sequência e são todas marcadas como
    // interpoladas; o que foi medido de fato são os instantes analisados (analysisSamples).
    const measured=new Set((result.analysisSamples||[]).filter(s=>s&&(s.source==='detected'||s.source==='tracked')&&Number.isFinite(s.time)).map(s=>Math.round((s.time-selection.inPoint)*fps)).filter(f=>f>=0&&f<expected));
    mask.recoveryEvidence.detectedFrames=measured.size;mask.recoveryEvidence.measuredCoverage=Math.min(1,measured.size/expected);}
  T.validate(mask);
  return mask;
}
// Sem nada a tratar (um trecho, take inteiro, sem perdas): não cria trajeto novo.
function needed(result,mask){
  return !!result&&(result.coverage!==1||!!mask?.partial||(Array.isArray(result.segments)&&result.segments.some(s=>s&&s.primary===false)));
}
function summary(e){
  if(!e||e.kind!==KIND)return '';
  const s=n=>(n<.1?(Math.round(n*100)/100).toFixed(2):(Math.round(n*10)/10).toFixed(1)).replace('.',',')+' s';
  const bridges=e.gaps.filter(g=>g.mode==='bridge'),holds=e.gaps.filter(g=>g.mode==='hold'&&!g.edge),edges=e.gaps.filter(g=>g.edge);
  if(e.keyframeInterpolation==='between-analyzed-instants-v1'){const n=e.gaps.length;return n+' intervalo'+(n===1?'':'s')+' sem medição ('+s(e.gaps.reduce((n,g)=>n+Math.max(0,g.end-g.start),0))+'). O Premiere interpola entre os instantes analisados.';}
  const parts=[];
  if(bridges.length)parts.push(bridges.length+' falha'+(bridges.length>1?'s':'')+' curta'+(bridges.length>1?'s':'')+' emendada'+(bridges.length>1?'s':''));
  if(holds.length)parts.push(holds.length+' perda'+(holds.length>1?'s':'')+' longa'+(holds.length>1?'s':'')+' com enquadramento mantido ('+s(holds.reduce((n,g)=>n+g.end-g.start,0))+')');
  if(edges.length)parts.push('enquadramento mantido '+edges.map(g=>(g.edge==='start'?'no início':'no fim')+' ('+s(g.end-g.start)+')').join(' e ')+', antes do rosto aparecer ou depois de sumir');
  const boundary=e.gaps.filter(g=>g.samplingBoundary&&!g.sparseFailure);
  if(boundary.length)parts.push('CONFIRA '+boundary.length+' retomada'+(boundary.length>1?'s':'')+': a amostragem pode ter ampliado a perda');
  const sparse=e.gaps.filter(g=>g.sparseFailure);
  if(sparse.length)parts.push('CONFIRA '+sparse.length+' trecho'+(sparse.length>1?'s':'')+' no Fast/Ultra: perda de medição ou movimento brusco demais para reconstruir; o caminho foi preenchido');
  const flagged=e.gaps.filter(g=>g.suspect&&(!(g.samplingBoundary||g.sparseFailure)||g.sizeSuspect));
  if(flagged.length)parts.push('CONFIRA '+flagged.length+' retomada'+(flagged.length>1?'s':'')+' com rosto de tamanho bem diferente (pode ser outra pessoa)');
  return parts.join(' · ');
}
module.exports={autoFill,needed,summary,KIND,DEFAULTS};
