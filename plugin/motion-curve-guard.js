'use strict';
const I=require('./integrity'),H=require('./host-values');
function createMotionCurveGuard(ppro,base=require('./motion-guard').createMotionGuard(ppro)){
 const valid=c=>!!c&&c.version===1&&c.layout==='point-quarter-samples-v1'&&/^[a-f0-9]{64}$/.test(c.fingerprint)&&Number.isInteger(c.samples)&&c.samples>=0&&
   (c.priorFingerprint===undefined||/^[a-f0-9]{64}$/.test(c.priorFingerprint));
 const bad=()=>{const e=Error('Recibo da curva de Movimento inválido. Nada foi alterado.');e.code='ANCHOR_MOTION_RECEIPT_INVALID';return e;};
 function requireReceipt(r){if(r.pointCurve!==undefined&&!valid(r.pointCurve))throw bad();}
 async function snapshot(ctx){
  const comp=ctx.motion.comp||ctx.motion,channels=[];let samples=0;
  for(const index of [0,5]){
   const param=await comp.getParam(index);if(!await param.isTimeVarying())continue;
   const times=(await H.keyTimes(param,'Movimento › curva espacial')).seconds.sort((a,b)=>a-b),reads=[];
   for(let i=1;i<times.length;i++)for(const u of [.25,.75])reads.push(times[i-1]+(times[i]-times[i-1])*u);
   const values=[];for(let at=0;at<reads.length;at+=16){
    const batch=await Promise.allSettled(reads.slice(at,at+16).map(async t=>{
     let v=await param.getValueAtTime(ppro.TickTime.createWithSeconds(t));while(v&&v.value!==undefined)v=v.value;
     const p=Array.isArray(v)?v:[v?.x,v?.y];if(p.length!==2||!p.every(Number.isFinite))throw H.hostError('Movimento › curva espacial','Ponto inválido');return p;
    }));const failure=batch.find(r=>r.status==='rejected');if(failure)throw failure.reason;values.push(...batch.map(r=>r.value));
   }
   channels.push({index,times:reads,values});samples+=reads.length;
  }
  return{version:1,layout:'point-quarter-samples-v1',fingerprint:I.digest(channels),samples};
 }
 function compare(r,curve,replaceEdited=false){
  requireReceipt(r);if(!r.pointCurve||r.pointCurve.fingerprint===curve.fingerprint)return false;
  if(replaceEdited===true)return true;
  const e=Error('A curva espacial do Movimento foi editada depois da aplicação do Dynamic Anchor. Para recalcular, desfaça a edição com Ctrl+Z ou redefina o Movimento do clipe e aplique de novo. Nada foi gravado.');e.code='ANCHOR_MOTION_EDITED';throw e;
 }
 return{...base,
  async capture(ctx,options={}){const receipt=await base.capture(ctx,options),curve=await snapshot(ctx);if(options.prior?.pointCurve){if(!valid(options.prior.pointCurve))throw bad();curve.priorFingerprint=options.prior.pointCurve.fingerprint;}return{...receipt,pointCurve:curve};},
  async captureAndValidate(ctx,options={}){if(options.managedReceipt)requireReceipt(options.managedReceipt);const receipt=await base.captureAndValidate(ctx,options),curve=await snapshot(ctx);if(options.managedReceipt)compare(options.managedReceipt,curve,options.replaceEdited);return{...receipt,pointCurve:curve};},
  async validate(ctx,receipt,options={}){requireReceipt(receipt);const result=await base.validate(ctx,receipt,options);if(!receipt.pointCurve)return result;return{...result,edited:compare(receipt,await snapshot(ctx),options.replaceEdited)||result.edited};},
  async validateMany(ctx,checks,options={}){for(const c of checks)requireReceipt(c.receipt);const results=await base.validateMany(ctx,checks,options);if(!checks.some(c=>c.receipt.pointCurve))return results;const curve=await snapshot(ctx);return results.map((r,i)=>({...r,edited:compare(checks[i].receipt,curve,checks[i].replaceEdited)||r.edited}));},
  async appliedCheck(ctx,receipt,expectedKeys){
   if(receipt?.pointCurve!==undefined&&!valid(receipt.pointCurve))return{present:null,reason:'receipt',keys:null};
   const result=await base.appliedCheck(ctx,receipt,expectedKeys);if(!receipt?.pointCurve||result.reason==='receipt'||result.reason==='order'||result.reason==='host')return result;
   const curve=await snapshot(ctx);
   if(result.present===true&&curve.fingerprint===receipt.pointCurve.fingerprint)return result;
   if(curve.fingerprint===receipt.pointCurve.priorFingerprint&&(result.present===true||result.reason==='undo'))return{present:false,reason:'undo',keys:null};
   return{present:null,reason:'spatial-curve',keys:null};
  }
 };
}
module.exports={createMotionCurveGuard};
