'use strict';
const I=require('./integrity'),H=require('./host-values');
function createTransformCurveGuard(ppro,base=require('./effect-guard').createGuard(ppro)){
 const valid=c=>c&&c.version===1&&c.layout==='transform-point-quarter-samples-v1'&&/^[a-f0-9]{64}$/.test(c.fingerprint)&&Number.isInteger(c.samples)&&c.samples>=0&&
  (c.priorFingerprint===undefined||/^[a-f0-9]{64}$/.test(c.priorFingerprint))&&(c.priorEffectFingerprint===undefined||/^[a-f0-9]{64}$/.test(c.priorEffectFingerprint));
 function check(r){if(r?.pointCurve!==undefined&&!valid(r.pointCurve)){const e=Error('Recibo da curva de Transformar inválido. Nada foi alterado.');e.code='ANCHOR_EFFECT_RECEIPT_INVALID';throw e;}}
 const stack=ctx=>ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2');
 const component=(ctx,r)=>{const list=stack(ctx),entry=r?list[r.index]:ctx.effect;if(!entry||entry.match!=='AE.ADBE Geometry2')throw Error('Transformar gerenciado indisponível.');return entry.comp;};
 async function snapshot(comp){
  const channels=[];let samples=0;
  for(const index of [0,1]){const param=await comp.getParam(index);if(!await param.isTimeVarying())continue;
   const times=(await H.keyTimes(param,'Transformar › curva espacial')).seconds.sort((a,b)=>a-b),reads=[];
   for(let i=1;i<times.length;i++)for(const u of [.25,.75])reads.push(times[i-1]+(times[i]-times[i-1])*u);
   const values=[];for(let at=0;at<reads.length;at+=16){const results=await Promise.allSettled(reads.slice(at,at+16).map(async time=>{
    let v=await param.getValueAtTime(ppro.TickTime.createWithSeconds(time));while(v&&v.value!==undefined)v=v.value;const p=Array.isArray(v)?v:[v?.x,v?.y];if(p.length!==2||!p.every(Number.isFinite))throw H.hostError('Transformar › curva espacial','Ponto inválido');return p;
   }));const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;values.push(...results.map(r=>r.value));}
   channels.push({index,times:reads,values});samples+=reads.length;
  }
  return{version:1,layout:'transform-point-quarter-samples-v1',fingerprint:I.digest(channels),samples};
 }
 return{...base,
  async capture(ctx,note=null,prior=null){const receipt=await base.capture(ctx,note),curve=await snapshot(component(ctx));if(prior?.pointCurve){check(prior);curve.priorFingerprint=prior.pointCurve.fingerprint;curve.priorEffectFingerprint=prior.fingerprint;}return{...receipt,pointCurve:curve};},
  async validate(ctx,receipt,options={}){
   check(receipt);const result=await base.validate(ctx,receipt,options);if(!receipt.pointCurve)return result;
   const curve=await snapshot(component(ctx,receipt)),changed=curve.fingerprint!==receipt.pointCurve.fingerprint;
   if(changed&&options.replaceEdited!==true){const e=Error('A curva espacial do Transformar foi editada depois da aplicação do Dynamic Anchor. Para recalcular, desfaça a edição com Ctrl+Z ou apague esse Transformar e aplique de novo. Nada foi gravado.');e.code='ANCHOR_EFFECT_EDITED';throw e;}
   return{...result,edited:result.edited||changed,receipt:result.receipt?{...result.receipt,pointCurve:receipt.pointCurve}:null};
  },
  async appliedCheck(ctx,receipt){
   try{check(receipt);}catch(_){return{present:null,reason:'receipt',keys:null};}
   if(!receipt?.pointCurve)return null;
   const comp=component(ctx,receipt),start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe'),curve=await snapshot(comp),fingerprint=await base.fingerprint(comp,start,receipt.fingerprintVersion===2);
   if(curve.fingerprint===receipt.pointCurve.fingerprint&&fingerprint===receipt.fingerprint)return{present:true,reason:null,keys:null};
   if(curve.fingerprint===receipt.pointCurve.priorFingerprint&&fingerprint===receipt.pointCurve.priorEffectFingerprint)return{present:false,reason:'undo',keys:null};
   return{present:null,reason:'changed',keys:null};
  }
 };
}
module.exports={createTransformCurveGuard};
