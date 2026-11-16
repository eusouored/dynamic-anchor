'use strict';
// Shared, pure geometry for Apply, Preview and the face composition tools.
// A snapshot contains Motion and effect values already read by the engine.
const C=require('./core.js');
const finitePoint=p=>!!p&&[p.x,p.y].every(Number.isFinite);
function validate(snapshot){
 if(!snapshot||snapshot.version!==1||![snapshot.W,snapshot.H,snapshot.basisScale,snapshot.activeScale].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)||!finitePoint(snapshot.activeAnchor)||!Array.isArray(snapshot.measuredRows)||snapshot.measuredRows.length<2||snapshot.measuredRows.some(r=>!r||![r.x,r.y,r.angle].every(Number.isFinite)))
  throw Error('Geometria de enquadramento inválida ou incompleta.');
 const motion=snapshot.sourceTransform;
 if(motion!==null&&motion!==undefined&&(!Array.isArray(motion)||motion.length!==snapshot.measuredRows.length||motion.some(m=>!m||!finitePoint(m.position)||!finitePoint(m.anchor)||!Number.isFinite(m.scale)||m.scale<=0||!Number.isFinite(m.rotation))))
  throw Error('Movimento da origem inválido para o enquadramento.');
 return snapshot;
}
function resolveOptions(snapshot,settings){
 validate(snapshot);
 if(!settings||!settings.opt)throw Error('Controles ausentes para medir o enquadramento.');
 if(settings.opt.zoomProtection===true&&(settings.opt.scaleMode!=='auto'||settings.resetScale===true||settings.opt.scaleOverride!==undefined))
  throw Error("zoomProtection só aceita scaleMode 'auto' e não aceita resetScale/scaleOverride.");
 return {...settings.opt,sourceTransform:snapshot.sourceTransform||null,source:sourceSize(snapshot,settings.opt),
  anchor:settings.opt.rotation?null:{x:snapshot.activeAnchor.x,y:snapshot.activeAnchor.y},
  scaleOverride:settings.resetScale===true?snapshot.basisScale:settings.opt.scaleMode==='none'?snapshot.activeScale/100*snapshot.basisScale:undefined};
}
// Quadro do vídeo (onde o rastreio está). Igual ao da sequência na mesma proporção.
function sourceSize(snapshot,opt){
 if(snapshot&&Number.isFinite(snapshot.SW)&&Number.isFinite(snapshot.SH))return {w:snapshot.SW,h:snapshot.SH};
 if(opt&&opt.source&&Number.isFinite(opt.source.w)&&Number.isFinite(opt.source.h))return {w:opt.source.w,h:opt.source.h};
 return {w:snapshot.W,h:snapshot.H};
}
function sourcePoint(snapshot,index,p){
 if(!finitePoint(p))throw Error('Ponto físico inválido no enquadramento.');
 const m=snapshot.sourceTransform&&snapshot.sourceTransform[index];if(!m)return {x:p.x,y:p.y};
 const v=C.rot({x:p.x-m.anchor.x,y:p.y-m.anchor.y},m.rotation);
 return {x:m.position.x+m.scale*v.x,y:m.position.y+m.scale*v.y};
}
function effectiveReferences(keys){
 const target=keys.meta&&keys.meta.target;if(!finitePoint(target))throw Error('Alvo de enquadramento ausente.');
 return keys.map(k=>{
  if(!k||!finitePoint(k.anchor)||![k.px,k.py,k.scale,k.rotation].every(Number.isFinite)||k.scale<=0)throw Error('Transformação inválida no enquadramento.');
  const v=C.rot({x:(k.px-target.x)/k.scale,y:(k.py-target.y)/k.scale},-k.rotation);
  return {ct:{x:k.anchor.x-v.x,y:k.anchor.y-v.y},r:k.rotation};
 });
}
function evaluateCoverage(snapshot,keys){
 validate(snapshot);
 if(!Array.isArray(keys)||keys.length!==snapshot.measuredRows.length)throw Error('Quadros incompatíveis na avaliação de cobertura.');
 const OW=snapshot.W,OH=snapshot.H,src=sourceSize(snapshot,null),W=src.w,H=src.h,corners=[{x:0,y:0},{x:OW,y:0},{x:OW,y:OH},{x:0,y:OH}],per=effectiveReferences(keys);
 const neededScale=C.requiredScale(per,keys.meta.target,{w:OW,h:OH},snapshot.sourceTransform,{w:W,h:H});
 let borderFrames=0;
 for(let i=0;i<keys.length;i++){
  const k=keys[i],m=snapshot.sourceTransform&&snapshot.sourceTransform[i],tolerance=.5/(k.scale*(m?m.scale:1));let border=false;
  for(const q of corners){
   const v=C.rot({x:q.x-k.px,y:q.y-k.py},-k.rotation);let p={x:k.anchor.x+v.x/k.scale,y:k.anchor.y+v.y/k.scale};
   if(m){const w=C.rot({x:p.x-m.position.x,y:p.y-m.position.y},-m.rotation);p={x:m.anchor.x+w.x/m.scale,y:m.anchor.y+w.y/m.scale};}
   if(p.x < -tolerance||p.x>W+tolerance||p.y < -tolerance||p.y>H+tolerance){border=true;break;}
  }
  if(border)borderFrames++;
 }
 return {borderFrames,borderFraction:borderFrames/keys.length,frames:keys.length,neededScale};
}
function autoLimitError(needed){
 const requiredZoom=Number.isFinite(needed)?Math.ceil(needed*1000)/10:null;
 const error=Error(requiredZoom===null?'No modo Auto, esse enquadramento não pode preencher o quadro sem bordas. Ajuste a posição do alvo. Nada foi aplicado.':'No modo Auto, o limite de zoom não cobre todo o movimento sem bordas. É necessário pelo menos '+String(requiredZoom).replace('.',',')+'%. Aumente o Limite de zoom ou ajuste o enquadramento. Nada foi aplicado.');
 error.code='ANCHOR_AUTO_ZOOM_LIMIT';error.requiredZoom=requiredZoom;return error;
}
function checkedKeys(rows,refIndex,opt,{guardAuto=true,guardFill=true}={}){
 const keys=C.anchorFraming(rows,refIndex,opt);
 if(opt.zoomProtection===true&&keys.meta.clamped)throw autoLimitError(keys.meta.requiredProtectedScale);
 if(guardAuto&&opt.scaleMode==='auto'&&keys.meta.scale+1e-9<keys.meta.needed)throw autoLimitError(keys.meta.needed);
 if((guardAuto&&opt.scaleMode==='auto')||(guardFill&&opt.guardFill===true)){
  if(!opt.frame||![opt.frame.w,opt.frame.h].every(n=>Number.isFinite(n)&&n>0))throw Error('Formato ausente na conferência de cobertura.');
  const src=opt.source&&Number.isFinite(opt.source.w)&&Number.isFinite(opt.source.h)?opt.source:opt.frame,snapshot={version:1,W:opt.frame.w,H:opt.frame.h,SW:src.w,SH:src.h,measuredRows:rows,sourceTransform:opt.sourceTransform||null,basisScale:1,activeScale:100,activeAnchor:{x:0,y:0}},coverage=evaluateCoverage(snapshot,keys);
  if(coverage.borderFrames||keys.meta.scale+1e-9<coverage.neededScale){
   if(opt.minimumCover)throw Error('Não foi possível confirmar cobertura sem bordas neste enquadramento. Ajuste a posição do alvo.');
   if(opt.scaleMode==='auto')throw autoLimitError(coverage.neededScale);
   const error=Error('Preencher quadro: os controles atuais não cobrem toda a imagem sem bordas. Confira o enquadramento e gere uma nova sugestão. Nada foi aplicado.');
   error.code='ANCHOR_FILL_COVERAGE';error.requiredZoom=Number.isFinite(coverage.neededScale)?Math.ceil(coverage.neededScale*1000)/10:null;throw error;
  }
 }
 return keys;
}
function calculate(snapshot,settings,guards){
 return checkedKeys(validate(snapshot).measuredRows,settings.refIndex,resolveOptions(snapshot,settings),guards);
}
module.exports={validate,resolveOptions,sourcePoint,effectiveReferences,evaluateCoverage,checkedKeys,calculate};
