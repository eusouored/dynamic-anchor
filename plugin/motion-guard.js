'use strict';
const I=require('./integrity.js'),H=require('./host-values.js');

const isMotion=receipt=>!!receipt&&receipt.version===2&&receipt.destination==='motion'&&
  receipt.layout==='native-motion-v1'&&receipt.match==='AE.ADBE Motion';
function unbox(value){
  const seen=new Set();
  while(value&&typeof value==='object'&&value.value!==undefined){
    if(seen.has(value))throw Error('Valor cíclico exposto por Movimento.');
    seen.add(value);value=value.value;
  }
  if(Array.isArray(value))return value;
  if(value&&typeof value==='object'&&Number.isFinite(value.x)&&Number.isFinite(value.y))return [value.x,value.y];
  return value;
}
function createMotionGuard(ppro){
  const stackOf=ctx=>ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2');
  const compOf=ctx=>ctx.motion&&ctx.motion.comp||ctx.motion;
  const entryOf=(ctx,stack)=>{
    const comp=compOf(ctx);
    return stack.find(c=>c.comp===comp)||null;
  };
  const badReceipt=()=>{const error=Error('O recibo não identifica Movimento gerenciado. Nenhuma alteração foi feita.');error.code='ANCHOR_MOTION_RECEIPT_INVALID';return error;};
  const indeterminateError=list=>{
    const where=list.map(x=>'parâmetro '+x.index+': '+x.count+' de '+x.total).join('; ');
    const error=Error('Não foi possível ler a interpolação de keyframes de Movimento ('+where+'). A leitura é indeterminada; nada foi sobrescrito. Tente novamente.');
    error.code='ANCHOR_HOST_INDETERMINATE';error.where='Movimento › interpolação';error.indeterminate=list;return error;
  };
  async function fingerprintDetail(comp,start,note=null,{nativePointPresence=false}={}){
    if(!comp||typeof comp.getParamCount!=='function')throw Error('A estrutura de Movimento não está disponível.');
    const channels=[],indeterminate=[],interpolationCapabilities=[];
    for(let index=0,count=await comp.getParamCount();index<count;index++){
      const param=await comp.getParam(index),varying=await param.isTimeVarying(),name=String(param.displayName||''),where='Movimento › '+(name||'parâmetro '+index);
      let times=varying?(await H.keyTimes(param,where+' › lista de keyframes',note)).seconds.slice().sort((a,b)=>a-b):[start];
      // An enabled stopwatch can legitimately remain after its keys were deleted.
      // Re-read a valid empty list; null/failed lists keep the existing hard error.
      if(varying&&times.length===0)times=(await H.keyTimes(param,where+' › confirmar lista vazia',note)).seconds.slice().sort((a,b)=>a-b);
      const emptyAnimated=varying&&times.length===0;
      const values=[],interpolation=[],pointerCapabilities=[];
      // This shortcut is presence-only. Write ownership/capture remains strict.
      // The native SDK PointKeyframe interface is uniform and has no temporal
      // interpolation reader. Validate every value, probe its native type, and
      // recheck the complete key-time list; generic hosts still probe every key.
      const pointValue=v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite);
      const nativeParamType=()=>{
        const proto=Object.getPrototypeOf(param);
        if(typeof ppro.ComponentParam==='function')return proto===ppro.ComponentParam.prototype;
        // SDK 26.5 exposes this native constructor through the instance, not
        // through the premierepro namespace. A tag alone is insufficient.
        const ctor=proto&&proto.constructor,native=fn=>typeof fn==='function'&&Function.prototype.toString.call(fn).includes('[native code]');
        return Object.prototype.toString.call(param)==='[object ComponentParam]'&&ctor?.name==='ComponentParam'&&
          native(ctor)&&proto===ctor.prototype&&native(param.getKeyframePtr);
      };
      const nativePointInterface=()=>nativePointPresence&&nativeParamType()&&!Object.prototype.hasOwnProperty.call(param,'getKeyframePtr')&&
        typeof ppro.PointKeyframe==='function'&&typeof ppro.PointKeyframe.prototype.getTemporalInterpolationMode!=='function';
      const nativePointKey=key=>!!key&&nativePointInterface()&&key instanceof ppro.PointKeyframe&&
        Object.getPrototypeOf(key)===ppro.PointKeyframe.prototype&&typeof key.getTemporalInterpolationMode!=='function';
      let nativePointSchema=false,nativePointReused=false;
      if(emptyAnimated){
        let value=unbox(await param.getValueAtTime(ppro.TickTime.createWithSeconds(start)));
        if(value===null||value===undefined)value=unbox(await param.getValueAtTime(ppro.TickTime.createWithSeconds(start)));
        if(value===null||value===undefined)throw H.hostError(where+' › valor da animação vazia',String(value));
        values.push(value);
      }
      async function readKey(time,k){
        const tick=ppro.TickTime.createWithSeconds(time);let value=unbox(await param.getValueAtTime(tick));
        if(value===null||value===undefined){
          if(note)await note('RELEITURA: '+where+' › valor na keyframe '+k+' veio vazio.');
          value=unbox(await param.getValueAtTime(ppro.TickTime.createWithSeconds(time)));
          if(value===null||value===undefined)throw H.hostError(where+' › valor na keyframe '+k,String(value));
        }
        if(!varying)return {value};
        if(nativePointSchema&&nativePointInterface()&&pointValue(value)){
          nativePointReused=true;return {value,mode:null,capability:'unsupported',invalid:false,nativePoint:true};
        }
        let mode=null,key=null,invalidInterpolation=false,modeReadFailed=false,capability,modeGetter=null;
        if(typeof param.getKeyframePtr==='function'){
          try{key=await param.getKeyframePtr(ppro.TickTime.createWithSeconds(time));}catch(_){invalidInterpolation=true;}
        }
        if(!key||typeof key!=='object'){invalidInterpolation=true;capability='invalid';}
        else if(typeof(modeGetter=key.getTemporalInterpolationMode)!=='function')capability='unsupported';
        else{
          capability='supported';
          for(let attempt=0;attempt<2;attempt++){
            try{mode=await modeGetter.call(key);}catch(_){modeReadFailed=true;break;}
            if(typeof mode==='number'&&Number.isFinite(mode))break;
          }
        }
        const invalid=invalidInterpolation||modeReadFailed||capability==='supported'&&(typeof mode!=='number'||!Number.isFinite(mode));
        return {value,mode:typeof mode==='number'&&Number.isFinite(mode)?mode:null,capability,invalid,nativePoint:!invalid&&capability==='unsupported'&&pointValue(value)&&nativePointKey(key)};
      }
      // Independent read-only SDK calls; settle a bounded group before using any result.
      // Every value and every interpolation capability is still checked, in time order.
      for(let at=0;at<times.length;at+=16){
        const reads=await Promise.allSettled(times.slice(at,at+16).map((time,i)=>readKey(time,at+i)));
        const failed=reads.find(r=>r.status==='rejected');if(failed)throw failed.reason;
        for(const read of reads){const data=read.value;values.push(data.value);if(!varying)continue;
          pointerCapabilities.push(data.capability);interpolation.push(data.mode);
          if(data.invalid){let item=indeterminate.find(x=>x.index===index);if(!item){item={index,count:0,total:times.length};indeterminate.push(item);}item.count++;}
        }
        if(at===0&&reads.length&&reads.every(read=>read.value.nativePoint===true))nativePointSchema=true;
        if(at&&at%4096===0&&note)await note('CONFERINDO: '+where+' | '+at+' de '+times.length+' keyframes.');
      }
      if(nativePointReused){
        let tail=null;try{tail=await param.getKeyframePtr(ppro.TickTime.createWithSeconds(times[times.length-1]));}catch(_){}
        const finalTimes=(await H.keyTimes(param,where+' › confirmar tempos na presença',note)).seconds.slice().sort((a,b)=>a-b);
        if(!nativePointKey(tail)||finalTimes.length!==times.length||finalTimes.some((time,i)=>time!==times[i])){
          if(!indeterminate.some(item=>item.index===index))indeterminate.push({index,count:1,total:times.length});
        }
      }
      let interpolationCapability='not-applicable';
      if(varying&&!emptyAnimated){
        const allPointF=values.length>0&&values.every(v=>Array.isArray(v)&&v.length===2&&v.every(Number.isFinite));
        const allUnsupported=pointerCapabilities.length===times.length&&pointerCapabilities.every(c=>c==='unsupported');
        const allSupported=pointerCapabilities.length===times.length&&pointerCapabilities.every(c=>c==='supported');
        if(allUnsupported&&allPointF)interpolationCapability='unsupported-point';
        else if(allSupported)interpolationCapability='supported';
        else if(!indeterminate.some(x=>x.index===index)){
          let item=indeterminate.find(x=>x.index===index);
          if(!item){item={index,count:1,total:Math.max(1,times.length)};indeterminate.push(item);}
        }
        if(interpolationCapability!=='not-applicable')interpolationCapabilities.push({index,name,capability:interpolationCapability});
      }
      channels.push({index,name,varying,...(emptyAnimated?{emptyAnimated:true}:{}),times:varying?times:[],values,interpolation,interpolationCapability});
    }
    return {channels,digest:I.digest(channels),indeterminate,interpolationCapabilities};
  }
  function validDimensions(value){
    return !!value&&Number.isFinite(value.width)&&value.width>0&&Number.isFinite(value.height)&&value.height>0&&Number.isFinite(value.pixelAspect)&&value.pixelAspect>0&&
      (value.sequencePixelAspect===undefined?value.pixelAspect===1:Number.isFinite(value.sequencePixelAspect)&&value.sequencePixelAspect>0&&Math.abs(value.pixelAspect-value.sequencePixelAspect)<=Math.max(value.pixelAspect,value.sequencePixelAspect)*1e-9);
  }
  const copyDimensions=value=>({width:value.width,height:value.height,pixelAspect:value.pixelAspect,...(value.sequencePixelAspect!==undefined?{sequencePixelAspect:value.sequencePixelAspect}:{})});
  function validBaseline(value){return !!value&&Number.isFinite(value.rotationAtReference);}
  const validCoordinateBaseline=(baseline,dimensions)=>validBaseline(baseline)&&validDimensions(dimensions)&&(dimensions.pixelAspect===1||baseline.rotationAtReference===0);
  function validMatches(value){return Array.isArray(value)&&value.length>0&&value.every(x=>typeof x==='string'&&x.length>0);}
  function validPrior(value){return value===undefined||value===null||!!value&&typeof value.fingerprint==='string'&&value.fingerprint.length>0&&
    validMatches(value.matches)&&value.matches.filter(x=>x==='AE.ADBE Motion').length===1;}
  function validCapabilities(value){return Array.isArray(value)&&value.every((x,i)=>!!x&&Number.isInteger(x.index)&&x.index>=0&&typeof x.name==='string'&&x.name.length>0&&
    ['supported','unsupported-point'].includes(x.capability)&&(!i||value[i-1].index<x.index));}
  function validReceipt(receipt){
    return isMotion(receipt)&&receipt.fingerprintVersion===3&&typeof receipt.fingerprint==='string'&&receipt.fingerprint.length>0&&validCapabilities(receipt.interpolationCapabilities)&&
      validMatches(receipt.matches)&&Number.isInteger(receipt.motionIndex)&&receipt.motionIndex>=0&&receipt.motionIndex<receipt.matches.length&&
      receipt.matches[receipt.motionIndex]==='AE.ADBE Motion'&&receipt.matches.filter(x=>x==='AE.ADBE Motion').length===1&&
      validCoordinateBaseline(receipt.baseline,receipt.sourceDimensions)&&validMigration(receipt.migration)&&validPrior(receipt.prior)&&
      // 0.9.41: whether this application wrote Rotation keys. Absent in older receipts (unknown).
      (receipt.rotationManaged===undefined||typeof receipt.rotationManaged==='boolean');
  }
  function validMigration(receipt){
    return receipt===null||receipt===undefined||!!receipt&&receipt.version===1&&validMatches(receipt.matches)&&
      Number.isInteger(receipt.index)&&receipt.index>=0&&receipt.index<receipt.matches.length&&receipt.matches[receipt.index]==='AE.ADBE Geometry2'&&
      typeof receipt.fingerprint==='string'&&receipt.fingerprint.length>0;
  }
  function validateShape(ctx,receipt){
    if(!validReceipt(receipt))throw badReceipt();
    const stack=stackOf(ctx),matches=stack.map(c=>c.match),entry=stack[receipt.motionIndex];
    if(I.canonical(receipt.matches)!==I.canonical(matches)||!entry||entry.match!=='AE.ADBE Motion'||matches.filter(m=>m==='AE.ADBE Motion').length!==1){
      const error=Error('A estrutura ou a ordem dos efeitos mudou. Preserve os ajustes e revise Movimento; nenhuma alteração foi feita.');error.code='ANCHOR_MOTION_STRUCTURE';throw error;
    }
    return {stack,matches,entry};
  }
  function compareDetail(receipt,matches,detail,{replaceEdited=false}={}){
    if(detail.indeterminate.length)throw indeterminateError(detail.indeterminate);
    // Interpolation is not applicable once animation is disabled. A removed
    // capability on a fully read static channel is an ordinary content edit,
    // still subject to replaceEdited and the fresh fingerprint before writing.
    // Added capabilities or changes on animated channels remain a hard block.
    const stoppedOnly=detail.interpolationCapabilities.every(current=>receipt.interpolationCapabilities.some(old=>I.canonical(old)===I.canonical(current)))&&
      receipt.interpolationCapabilities.every(old=>detail.interpolationCapabilities.some(current=>I.canonical(old)===I.canonical(current))||
        detail.channels.some(channel=>channel.index===old.index&&channel.name===old.name&&(channel.varying===false||channel.emptyAnimated===true)&&channel.interpolationCapability==='not-applicable'));
    if(I.canonical(detail.interpolationCapabilities)!==I.canonical(receipt.interpolationCapabilities)&&!stoppedOnly){
      const error=Error('A capacidade de verificar a interpolação de Movimento mudou. Revise o clipe antes de continuar.');error.code='ANCHOR_MOTION_CAPABILITY';throw error;
    }
    if(detail.digest!==receipt.fingerprint){
      if(replaceEdited===true&&matches.filter(m=>m==='AE.ADBE Motion').length===1)return {edited:true};
      const error=Error('O Movimento deste take foi editado depois da aplicação do Dynamic Anchor. Para recalcular, desfaça a edição com Ctrl+Z ou redefina o Movimento do clipe e aplique de novo. Nada foi gravado.');error.code='ANCHOR_MOTION_EDITED';throw error;
    }
    return {edited:false,receipt:{...receipt,matches:matches.slice()}};
  }
  function makeReceipt(stack,entry,matches,detail,{baseline,sourceDimensions,migration,prior}){
    const receipt={version:2,destination:'motion',layout:'native-motion-v1',match:'AE.ADBE Motion',matches,motionIndex:stack.indexOf(entry),fingerprintVersion:3,
      fingerprint:detail.digest,interpolationCapabilities:detail.interpolationCapabilities,baseline:{rotationAtReference:baseline.rotationAtReference},
      sourceDimensions:copyDimensions(sourceDimensions),migration:migration||null};
    if(prior)receipt.prior={fingerprint:prior.fingerprint,matches:prior.matches.slice()};
    return receipt;
  }
  async function captureAndValidate(ctx,{baseline,sourceDimensions,migration=null,prior=null,note=null,managedReceipt=null,replaceEdited=false}={}){
    if(!validCoordinateBaseline(baseline,sourceDimensions)||!validMigration(migration)||!validPrior(prior))throw badReceipt();
    const stack=stackOf(ctx),entry=entryOf(ctx,stack),matches=stack.map(c=>c.match);
    if(!entry||entry.match!=='AE.ADBE Motion'||matches.filter(x=>x==='AE.ADBE Motion').length!==1)throw Error('Não foi possível identificar um único componente Movimento.');
    const managed=managedReceipt?validateShape(ctx,managedReceipt):null;
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (recibo de Movimento)',note);
    const detail=await fingerprintDetail(entry.comp,start,note);
    if(detail.indeterminate.length)throw indeterminateError(detail.indeterminate);
    if(managed)compareDetail(managedReceipt,managed.matches,detail,{replaceEdited});
    return makeReceipt(stack,entry,matches,detail,{baseline,sourceDimensions,migration,prior});
  }
  async function validateMany(ctx,checks,{note=null}={}){
    if(!Array.isArray(checks)||!checks.length)throw badReceipt();
    const prepared=checks.map(check=>{
      if(!check||!check.receipt)throw badReceipt();
      return {check,shape:validateShape(ctx,check.receipt)};
    });
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (conferência de Movimento)',note);
    const detail=await fingerprintDetail(prepared[0].shape.entry.comp,start,note);
    return prepared.map(({check,shape})=>compareDetail(check.receipt,shape.matches,detail,{replaceEdited:check.replaceEdited===true}));
  }
  async function capture(ctx,{baseline,sourceDimensions,migration=null,prior=null,note=null,rotationManaged}={}){
    if(rotationManaged!==undefined&&typeof rotationManaged!=='boolean')throw badReceipt();
    if(!validCoordinateBaseline(baseline,sourceDimensions)||!validMigration(migration))throw badReceipt();
    const stack=stackOf(ctx),entry=entryOf(ctx,stack),matches=stack.map(c=>c.match);
    if(!entry||entry.match!=='AE.ADBE Motion'||matches.filter(x=>x==='AE.ADBE Motion').length!==1)throw Error('Não foi possível identificar um único componente Movimento.');
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (recibo de Movimento)',note);
    const detail=await fingerprintDetail(entry.comp,start,note);
    if(detail.indeterminate.length)throw indeterminateError(detail.indeterminate);
    if(!validPrior(prior))throw badReceipt();
    const receipt={version:2,destination:'motion',layout:'native-motion-v1',match:'AE.ADBE Motion',matches,motionIndex:stack.indexOf(entry),fingerprintVersion:3,
      fingerprint:detail.digest,interpolationCapabilities:detail.interpolationCapabilities,baseline:{rotationAtReference:baseline.rotationAtReference},
      sourceDimensions:copyDimensions(sourceDimensions),migration:migration||null};
    if(prior)receipt.prior={fingerprint:prior.fingerprint,matches:prior.matches.slice()};
    if(rotationManaged!==undefined)receipt.rotationManaged=rotationManaged;
    return receipt;
  }
  async function validate(ctx,receipt,{replaceEdited=false,note=null}={}){
    const {matches,entry}=validateShape(ctx,receipt);
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (conferência de Movimento)',note),detail=await fingerprintDetail(entry.comp,start,note);
    return compareDetail(receipt,matches,detail,{replaceEdited});
  }
  async function appliedCheck(ctx,receipt,expectedKeys=null){
    try{
      if(!validReceipt(receipt))return {present:null,reason:'receipt',keys:null};
      const stack=stackOf(ctx),matches=stack.map(c=>c.match),finalShape=I.canonical(receipt.matches)===I.canonical(matches)&&
        Number.isInteger(receipt.motionIndex)&&stack[receipt.motionIndex]?.match==='AE.ADBE Motion'&&matches.filter(m=>m==='AE.ADBE Motion').length===1;
      const prior=receipt.prior,priorShape=!!prior&&validPrior(prior)&&
        I.canonical(prior.matches)===I.canonical(matches)&&matches.filter(m=>m==='AE.ADBE Motion').length===1;
      if(!finalShape&&!priorShape)return {present:null,reason:'order',keys:null};
      const entry=stack[finalShape?receipt.motionIndex:matches.indexOf('AE.ADBE Motion')];
      const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (conferência de Movimento)');
      const detail=await fingerprintDetail(entry.comp,start,null,{nativePointPresence:true});
      if(detail.indeterminate.length)return {present:null,reason:'host',keys:null};
      const finalCapabilitiesMatch=I.canonical(detail.interpolationCapabilities)===I.canonical(receipt.interpolationCapabilities);
      if(finalShape&&finalCapabilitiesMatch&&detail.digest===receipt.fingerprint)return {present:true,reason:null,keys:null};
      if(priorShape&&detail.digest===receipt.prior.fingerprint)return {present:false,reason:'undo',keys:null};
      if(finalShape&&!finalCapabilitiesMatch)return {present:null,reason:'capability',keys:null};
      if(!priorShape)return {present:null,reason:'prior',keys:null};
      return {present:null,reason:'changed',keys:null};
    }catch(error){if(error&&error.code==='ANCHOR_HOST_NULL')return {present:null,reason:'host',keys:null};throw error;}
  }
  return {capture,validate,captureAndValidate,validateMany,appliedCheck,isMotion};
}
module.exports={createMotionGuard,isMotion};
