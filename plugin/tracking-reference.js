'use strict';
// A movement reference never replaces the detector rectangle. Its constant
// offset aligns the first anatomical point to the initial rectangle centre.
const METHOD='yunet-mean5-aligned-v1';
const V=require('./video-reference.js'),Adaptive=require('./adaptive-reference.js');
function has(rows){return rows.some(r=>r&&r.trackingPoint!==undefined);}
function isVideo15(ref){return V.isVideo15(ref);}
function validate(d){
 const anchored=has(d.rows),ref=d.trackingReference;
 if(!anchored&&ref===undefined)return false;
  if(!anchored||d.type!=='external-face'||!ref||!ref.offset||![ref.offset.x,ref.offset.y].every(Number.isFinite)||Math.abs(ref.offset.x)>(d.SW||d.W)||Math.abs(ref.offset.y)>(d.SH||d.H))
  throw Error('Referência de movimento facial inválida ou incompatível.');
  if(d.referenceCoverage!==undefined&&!isVideo15(ref))throw Error('Cobertura video15 sem referência video15 correspondente.');
  if(isVideo15(ref))V.validateReference(ref,d.W,d.H);
  else if(Adaptive.isAdaptive(ref))Adaptive.validate(ref);
  else if(ref.method!==METHOD)throw Error('Referência de movimento facial inválida ou incompatível.');
 if(require('./head-reference.js').isSampled(ref))require('./head-reference.js').validateSamples(d.analysisSamples,d.times,d.selection,{fps:d.fps,mediaFps:d.mediaFps});
 // 0.9.42: perdas tratadas automaticamente (face-gaps.js). Pontos observados seguem
 // intactos; linhas criadas são marcadas e nunca se passam por observação.
 const auto=d.recoveryEvidence&&d.recoveryEvidence.kind==='auto-gaps-v1';
 // v2 (CONTRATO-0946): 'sampled' é reconstrução entre observações válidas; só vale com referência v2.
 const observed=source=>source==='detected'||source==='sampled'&&V.hasSampling(ref);
 const autoRow=r=>typeof r.trackingSegment==='string'&&(r.gap===undefined?
   (observed(r.source)&&r.interpolated!==true&&r.held===undefined):
   (['bridge','hold','ease'].includes(r.gap)&&r.source==='gap'&&r.interpolated===true&&(r.gap==='hold')===(r.held===true)));
 for(const r of d.rows){
  const p=r.trackingPoint;
  if(require('./head-reference.js').isHead(ref))require('./head-reference.js').validateRow(r,d.SW||d.W,d.SH||d.H,{recovered:!!d.recoveryEvidence,hybrid:require('./head-reference.js').isHybrid(ref)});
  // v3: o offset é só proveniência; o ponto em si precisa estar no quadro. v1/v2: olhos (ponto − offset).
  const ox=V.isV3(ref)?0:ref.offset.x,oy=V.isV3(ref)?0:ref.offset.y;
  if(!p||![p.x,p.y,r.width,r.height].every(Number.isFinite)||r.width<=0||r.height<=0||p.x-ox<0||p.x-ox>(d.SW||d.W)||p.y-oy<0||p.y-oy>(d.SH||d.H))
   throw Error('Referência facial ausente ou fora da área de origem.');
    if(isVideo15(ref)&&!(auto?autoRow(r):(observed(r.source)&&r.interpolated!==true&&r.held===undefined&&r.trackingSegment===undefined)))
      throw Error('A referência video15 só aceita pontos observados e não recuperados.');
 }
 return true;
}
module.exports={METHOD,VIDEO15_METHOD:V.METHOD,has,isVideo15,validate};
