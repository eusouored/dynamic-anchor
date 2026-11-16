'use strict';
const I=require('./integrity.js'),R=require('./tracking-reference.js');
const normalize=p=>String(p||'').replace(/\\/g,'/').replace(/^\/\/\?\//,'').toLowerCase();
function checkSelection(s){
  if(!s||![s.projectGuid,s.projectItemId,s.sequenceId,s.projectPath].every(v=>typeof v==='string'&&v.length>0)||!Number.isInteger(s.trackIndex)||s.trackIndex<0||![s.start,s.end,s.inPoint,s.outPoint].every(Number.isFinite)||s.end<=s.start||s.outPoint<=s.inPoint)
    throw Error('Não é possível identificar o trecho com segurança. Leia a máscara pelo fluxo compatível.');
}
// Identidade = o que define o rosto a seguir: item do projeto e trecho da MÍDIA (entrada/saída).
// Onde o clipe está na timeline (ripple, outra trilha) e o caminho do projeto (Salvar como) mudam
// sem mudar o trajeto, então ficam em position() e entram só como conferência.
function identity(s){
  checkSelection(s);
  return {projectGuid:s.projectGuid,projectItemId:s.projectItemId,inPoint:s.inPoint,outPoint:s.outPoint};
}
function position(s){checkSelection(s);return {projectPath:normalize(s.projectPath),sequenceId:s.sequenceId,trackIndex:s.trackIndex,start:s.start,end:s.end};}
// Identidade das versões até 1.5.15 (inclui a posição na timeline); lida só para migrar dados antigos.
function legacyIdentity(s){
  checkSelection(s);
  return {projectGuid:s.projectGuid,projectPath:normalize(s.projectPath),sequenceId:s.sequenceId,projectItemId:s.projectItemId,trackIndex:s.trackIndex,start:s.start,end:s.end,inPoint:s.inPoint,outPoint:s.outPoint};
}
const key=s=>'take:'+I.digest(identity(s));
const legacyKey=s=>'take:'+I.digest(legacyIdentity(s));
// Copia trajeto, estado e escolha de pessoa gravados com a chave antiga para a chave nova (uma vez por take).
async function migrateLegacy(repository,selection){
  if(!repository)return false;
  let nk,lk;try{nk=key(selection);lk=legacyKey(selection);}catch(_){return false;}
  if(nk===lk)return false;let moved=false;
  for(const [from,to] of [[lk,nk],[lk+':state',nk+':state'],['face-info:'+lk,'face-info:'+nk]]){
    try{if(await repository.read(to))continue;const old=await repository.read(from);if(old&&old.payload){await repository.write(to,old.payload);moved=true;}}catch(_){}
  }
  return moved;
}
function validate(d){
  if(!d||![d.W,d.H,d.fps].every(n=>Number.isFinite(n)&&n>0)||!Array.isArray(d.rows)||d.rows.length<2||!Array.isArray(d.times)||d.times.length!==d.rows.length)throw Error('Trajeto incompatível ou incompleto.');
  if(!d.selection||![d.selection.inPoint,d.selection.outPoint].every(Number.isFinite))throw Error('Origem temporal ausente.');
  for(let i=0;i<d.rows.length;i++)if(!d.rows[i]||!Number.isInteger(d.rows[i].frame)||d.rows[i].frame<0||![d.rows[i].x,d.rows[i].y,d.rows[i].angle,d.times[i]].every(Number.isFinite)||d.times[i]<d.selection.inPoint-1e-7||d.times[i]>=d.selection.outPoint+1e-7||(i&&(d.times[i]<=d.times[i-1]||d.rows[i].frame<=d.rows[i-1].frame)))throw Error('Tempos ou coordenadas inválidos no trajeto.');
  R.validate(d);return d;
}
function record(selection,masks,evidence={}){
  const id=identity(selection);
  if(!Array.isArray(masks)||!masks.length)throw Error('Nenhum trajeto para preservar.');
  const data=masks.map((mask,index)=>{
    validate(mask);if(I.canonical(identity(mask.selection))!==I.canonical(id))throw Error('Trajeto pertence a outro trecho.');
    return {...I.clone(mask),maskKey:mask.maskKey||mask.maskId||String(index)+':'+mask.name};
  });
  const anchored=data.some(m=>R.has(m.rows));
  return {schema:anchored?2:1,algorithm:anchored?'face-reference-v1':'mask-centre-v1',identity:id,position:position(selection),selection:I.clone(selection),capturedAt:new Date().toISOString(),evidence:I.clone(evidence),masks:data};
}
function recover(payload,selection){
  const anchored=payload?.schema===2&&payload.algorithm==='face-reference-v1';
  if(!anchored&&(payload?.schema!==1||payload.algorithm!=='mask-centre-v1'))throw Error('Versão do trajeto incompatível.');
  const legacy=I.canonical(payload.identity)===I.canonical(legacyIdentity(selection)),idOf=legacy?legacyIdentity:identity;
  if(!legacy&&I.canonical(payload.identity)!==I.canonical(identity(selection)))throw Error('O trajeto pertence a outro take ou projeto. Atualize a leitura.');
  if(!Array.isArray(payload.masks)||!payload.masks.length)throw Error('Trajeto armazenado vazio.');
  if(payload.masks.some(m=>R.has(m.rows||[]))!==anchored)throw Error('Versão da referência facial incompatível.');
  return payload.masks.map(mask=>{if(I.canonical(idOf(mask.selection))!==I.canonical(payload.identity))throw Error('Origem interna do trajeto incompatível.');return {...I.clone(validate(mask)),selection:I.clone(selection)};});
}
module.exports={identity,position,legacyIdentity,key,legacyKey,migrateLegacy,validate,record,recover,normalize};
