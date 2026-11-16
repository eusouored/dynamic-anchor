'use strict';
const METHOD='selected-face-center-v1';
const Head=require('./head-reference.js');
const isAdaptive=ref=>!!ref&&(ref.method===METHOD||Head.isHead(ref));
function validate(ref){
 if(Head.isHead(ref))return Head.validate(ref);
 if(!isAdaptive(ref)||!ref.offset||ref.offset.x!==0||ref.offset.y!==0||
   ref.sampling?.method!=='fixed-stride-v1'||![1,2,3].includes(ref.sampling.step)||
   ref.fallback?.method!=='bidirectional-lk'||ref.fallback.maxSeconds!==.25||
   (ref.smoothing!==undefined&&(ref.smoothing?.method!=='robust-local-quadratic-v1'||ref.smoothing.windowSeconds!==.14))||
   (ref.stabilization!==undefined&&(ref.stabilization?.method!=='visual-prediction-detector-correction-v1'||ref.stabilization.correctionSeconds!==.35||ref.stabilization.maxBoxFraction!==.25)))
  throw Error('Referência adaptativa inválida.');
 return ref;
}
function validateRow(row,ref){
 if(Head.isHead(ref))return Head.validateRow(row,Infinity,Infinity,{hybrid:Head.isHybrid(ref)});
 if(!row||!['detected','tracked','interpolated'].includes(row.source)||
   !row.trackingPoint||![row.x,row.y,row.trackingPoint.x,row.trackingPoint.y].every(Number.isFinite)||
   !Number.isFinite(row.width)||!Number.isFinite(row.height)||Math.abs(row.x-row.trackingPoint.x)>row.width*.25+1e-7||Math.abs(row.y-row.trackingPoint.y)>row.height*.25+1e-7)
  throw Error('Ponto adaptativo ou origem da medição inválidos.');
 return row;
}
module.exports={METHOD,isAdaptive,validate,validateRow};
