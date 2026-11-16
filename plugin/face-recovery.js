'use strict';
// Pure, explicit review of separately detected facial trajectories. No host,
// storage, UI or automatic application belongs in this module.
const X=require('./external-track.js'),T=require('./trajectory.js'),I=require('./integrity.js'),R=require('./tracking-reference.js'),V2=require('./video-reference.js');
const KIND='reviewed-segments-hold-v1';
const same=(a,b)=>I.canonical(a)===I.canonical(b);
const fail=message=>{throw Error(message);};
function formatIdentity(format){
  if(!format||![format.width,format.height,format.fps].every(n=>Number.isFinite(n)&&n>0))fail('Formato da revisão de rosto inválido.');
  return {width:format.width,height:format.height,fps:format.fps};
}
function gridIndex(time,selection,fps){
  const k=(time-selection.inPoint)*fps,frame=Math.round(k);
  if(!Number.isFinite(k)||!Number.isSafeInteger(frame)||frame<0||Math.abs(k-frame)>.01||time>=selection.outPoint)fail('Trecho de rosto fora da grade ou dos limites do take.');
  return frame;
}
// A segment digest covers every sample and all metadata, not its display name.
// Identity path normalization matches the existing trajectory repository.
function maskDigest(mask){const {maskKey,...body}=mask;return I.digest({...body,selection:T.identity(mask.selection)});}
function recordDigest(record){const {digest,...body}=record;return I.digest(body);}
function seal(record){return {...record,digest:recordDigest(record)};}
function checkedMask(mask,selection,format){
  T.validate(mask);
  if(mask.type!=='external-face'||mask.rotationSupported!==false||!same(T.identity(mask.selection),T.identity(selection))||mask.W!==format.width||mask.H!==format.height||mask.fps!==format.fps)fail('Trajeto da revisão pertence a outro take ou formato.');
  let previous=-1;
  for(let i=0;i<mask.rows.length;i++){
    const row=mask.rows[i],frame=gridIndex(mask.times[i],selection,format.fps);
    if(i&&frame!==previous+1)fail('Trecho de rosto tem lacunas internas ou quadros repetidos.');
    if(row.frame!==i||![row.width,row.height,row.area,row.confidence].every(Number.isFinite)||row.width<=0||row.height<=0||row.area!==row.width*row.height||row.confidence<X.FACE_MIN_CONFIDENCE||row.confidence>1||row.x<0||row.y<0||row.x>format.width||row.y>format.height||row.angle!==0||typeof row.interpolated!=='boolean'||row.held!==undefined||row.trackingSegment!==undefined||R.isVideo15(mask.trackingReference)&&(row.interpolated||!(row.source==='detected'||row.source==='sampled'&&V2.hasSampling(mask.trackingReference))))fail('Amostra da revisão de rosto inválida ou já recuperada.');
    previous=frame;
  }
  if(mask.firstTrackedTime!==mask.times[0]||mask.lastTrackedTime!==mask.times.at(-1)||mask.coveredStart!==mask.times[0]||mask.coveredEnd!==mask.times.at(-1)+1/format.fps)fail('Limites internos do trajeto foram alterados.');
  return mask;
}
function validate(record,selection){
  if(!record||![1,2].includes(record.schema)||!Array.isArray(record.segments)||!record.segments.length||!Array.isArray(record.reviewedIds))fail('Registro de revisão do rosto inválido.');
  const identity=T.identity(selection),format=formatIdentity(record.format);
  if(!same(T.identity(record.selection),identity))fail('A revisão pertence a outro take ou corte.');
  if(typeof record.digest!=='string'||record.digest!==recordDigest(record))fail('O registro de revisão foi alterado. Refaça a revisão dos trechos.');
  const ids=new Set();let primary=null,previousEnd=-1;
  for(const segment of record.segments){
    if(!segment||typeof segment.primary!=='boolean'||typeof segment.id!=='string'||ids.has(segment.id))fail('ID de trecho ausente ou duplicado.');
    checkedMask(segment.mask,selection,format);
    const digest=maskDigest(segment.mask);
    if(segment.id!=='face-segment:'+digest)fail('Os dados do trecho revisado foram alterados.');
    ids.add(segment.id);
    if(segment.primary){if(primary)fail('Mais de um trajeto principal no registro.');primary=segment;}
    const start=gridIndex(segment.mask.times[0],selection,format.fps),end=gridIndex(segment.mask.times.at(-1),selection,format.fps);
    if(start<=previousEnd)fail('Trechos de rosto sobrepostos, duplicados ou fora de ordem.');
    previousEnd=end;
  }
  if(!primary||record.primaryDigest!==maskDigest(primary.mask))fail('O trajeto principal da revisão não confere.');
  const reference=primary.mask.trackingReference;
  if((record.schema===2)!==(reference!==undefined)||record.segments.some(s=>!same(s.mask.trackingReference||null,reference||null)))fail('Versão ou referência facial diferente entre os trechos.');
  const reviewed=new Set();
  for(const id of record.reviewedIds){if(typeof id!=='string'||!ids.has(id)||id===primary.id||reviewed.has(id))fail('A lista de trechos revisados é inválida.');reviewed.add(id);}
  return record;
}
function build(result,selection,format){
  T.identity(selection);format=formatIdentity(format);
  // X.decode only consumes this segment's rows. Serializing all other segments
  // on every conversion duplicates the long result without adding evidence.
  const decode=rows=>{
    // 'sampled' (reconstruído entre observações) só existe em pacote video15 v2 já validado.
    const sources=require('./adaptive-reference.js').isAdaptive(result&&result.trackingReference)?['detected','interpolated','tracked']:V2.hasSampling(result&&result.trackingReference)?['detected','interpolated','sampled']:['detected','interpolated'];
    if(Array.isArray(rows)&&rows.some(r=>r&&(r.held!==undefined||r.trackingSegment!==undefined||(r.source!==undefined&&!sources.includes(r.source)))))fail('Trecho bruto do motor contém amostra mantida ou de origem desconhecida. Refaça a análise.');
    if(R.isVideo15(result&&result.trackingReference))return checkedMask(X.decodeFaceSegment(result,rows,selection,format),selection,format);
    return checkedMask(X.decode(JSON.stringify({...result,segments:undefined,rows}),selection,format,{confirmed:true}),selection,format);
  };
  const primaryMask=decode(result&&result.rows),primaryDigest=maskDigest(primaryMask);
  const segments=[{id:'face-segment:'+primaryDigest,primary:true,mask:primaryMask}];
  if(result.segments!==undefined&&!Array.isArray(result.segments))fail('Lista dos trechos do motor inválida.');
  let primaryDeclarations=0;
  for(const segment of result.segments||[]){
    if(!segment||typeof segment.primary!=='boolean')fail('Trecho auxiliar do motor inválido.');
    if(segment.primary){
      if(++primaryDeclarations>1)fail('Mais de um trajeto principal declarado pelo motor.');
      if(segment.rows!==undefined&&!Array.isArray(segment.rows))fail('Trajeto principal do motor inválido.');
      if(segment.rows&&segment.rows.length&&maskDigest(decode(segment.rows))!==primaryDigest)fail('Os dados do trajeto principal não conferem.');
    }else{
      if(!Array.isArray(segment.rows))fail('Trecho auxiliar do motor inválido.');
      const mask=decode(segment.rows),digest=maskDigest(mask);
      segments.push({id:'face-segment:'+digest,primary:false,mask});
    }
  }
  if(Number.isInteger(result.stats&&result.stats.segments)&&result.stats.segments!==segments.length)fail('A lista de trechos está incompleta ou não confere com o resultado do motor.');
  segments.sort((a,b)=>a.mask.times[0]-b.mask.times[0]);
  const record=seal({schema:primaryMask.trackingReference?2:1,selection:I.clone(selection),format,primaryDigest,segments,reviewedIds:[]});
  validate(record,selection);return record;
}
function reviewed(record,id){
  validate(record,record.selection);
  const segment=record.segments.find(s=>s.id===id);
  if(!segment||segment.primary)fail('Escolha um trecho auxiliar válido para confirmar a revisão.');
  const clone=I.clone(record);
  if(!clone.reviewedIds.includes(id))clone.reviewedIds.push(id);
  return seal(clone);
}
function combine(record,selection){
  validate(record,selection);
  const auxiliaries=record.segments.filter(s=>!s.primary);
  if(auxiliaries.some(s=>!record.reviewedIds.includes(s.id)))fail('Confira e confirme todos os trechos auxiliares antes de recuperar o take.');
  const ordered=[...record.segments].sort((a,b)=>a.mask.times[0]-b.mask.times[0]);
  if(ordered.some((segment,i)=>i>0&&R.isVideo15(segment.mask.trackingReference)&&gridIndex(segment.mask.times[0],selection,record.format.fps)>gridIndex(ordered[i-1].mask.times.at(-1),selection,record.format.fps)+1))
    fail('A recuperação video15 não preenche lacunas com quadros mantidos. Aplique manualmente o trecho contínuo disponível.');
  const primary=record.segments.find(s=>s.primary),mask=I.clone(primary.mask),video15=R.isVideo15(primary.mask.trackingReference),rows=[],times=[],fps=record.format.fps;
  let heldFrames=0,storedFrames=0,interpolatedFrames=0,availableSeconds=0,detectedSeconds=0,previousSegment=null,coveredEnd=selection.inPoint;
  const missingRanges=[],heldRanges=[],duration=selection.outPoint-selection.inPoint;
  for(const segment of record.segments){
    const first=gridIndex(segment.mask.times[0],selection,fps);
    const segmentStart=selection.inPoint+first/fps;
    if(segmentStart-coveredEnd>1e-7)missingRanges.push([coveredEnd,segmentStart]);
    if(rows.length){
      const previous=rows[rows.length-1],holdId='held:'+previousSegment.id+'->'+segment.id;
      if(previous.frame+1<first)heldRanges.push([selection.inPoint+(previous.frame+1)/fps,segmentStart]);
      for(let frame=previous.frame+1;frame<first;frame++){
        rows.push({...previous,frame,held:true,interpolated:true,trackingSegment:holdId});
        times.push(selection.inPoint+frame/fps);heldFrames++;
      }
    }
    for(let i=0;i<segment.mask.rows.length;i++){
      const row=I.clone(segment.mask.rows[i]),frame=gridIndex(segment.mask.times[i],selection,fps);
      const time=selection.inPoint+frame/fps,seconds=Math.min(1/fps,selection.outPoint-time);
      rows.push({...row,frame,...(video15?{}:{trackingSegment:segment.id})});times.push(time);storedFrames++;availableSeconds+=seconds;
      if(row.interpolated)interpolatedFrames++;else detectedSeconds+=seconds;
    }
    coveredEnd=Math.min(selection.outPoint,selection.inPoint+(rows[rows.length-1].frame+1)/fps);
    previousSegment=segment;
  }
  if(selection.outPoint-coveredEnd>1e-7)missingRanges.push([coveredEnd,selection.outPoint]);
  const expectedFrames=Math.ceil((selection.outPoint-selection.inPoint)*fps-1e-7);
  const partial=heldFrames>0||rows[0].frame!==0||rows[rows.length-1].frame!==expectedFrames-1;
  const measuredCoverage=partial?Math.min(1,availableSeconds/duration):1;
  Object.assign(mask,{selection:I.clone(selection),rows,times,firstTrackedTime:times[0],lastTrackedTime:times[times.length-1],coveredStart:times[0],coveredEnd:Math.min(selection.outPoint,times[times.length-1]+1/fps),
    partial,
    recoveryEvidence:{kind:KIND,reviewDigest:record.digest,selected:primary.id,reviewedIds:[...record.reviewedIds],heldFrames,heldSeconds:heldFrames/fps,segmentCount:record.segments.length,storedFrames,interpolatedFrames,missingRanges,heldRanges,
      measuredCoverage,availableCoverage:measuredCoverage,detectedCoverage:!partial&&!interpolatedFrames?1:Math.min(1,detectedSeconds/duration)}});
  T.validate(mask);return mask;
}
module.exports={build,validate,reviewed,combine,maskDigest};
