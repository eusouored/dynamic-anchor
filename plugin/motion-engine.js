'use strict';

// Direct Motion destination. This module deliberately has no component factory
// or append path: the only possible write target is the clip's native Motion.
const H=require('./host-values.js'),G=require('./framing-geometry.js'),I=require('./integrity.js');
const M=require('./motion-geometry.js');

function createMotionEngine({ppro,C,checkpoint,host}){
  if(!ppro||!C||!host)throw Error('Dependências incompletas para Movimento.');
  const guard=host.motionGuard||require('./motion-guard.js').createMotionGuard(ppro);
  const legacyGuard=host.legacyGuard||require('./effect-guard.js').createGuard(ppro);
  const unbox=v=>v&&v.value!==undefined?unbox(v.value):v;
  const report=async text=>{if(checkpoint)await checkpoint(text);};
  // Recovery receipts describe the exact state before an interrupted write.
  // Even when the user selected Replace, a changed Motion state must not be
  // treated as an editable receipt during recovery: it may already contain
  // the committed result whose final receipt could not be captured.
  const replaceEdited=settings=>settings.recoverManaged!==true&&settings.replace===true;
  function same(a,b){return I.canonical(a)===I.canonical(b);}
  function geometrySignature(snapshot){return I.digest({W:snapshot.W,H:snapshot.H,sourceTimes:snapshot.sourceTimes,
    sourceDimensions:snapshot.sourceDimensions,ratio:snapshot.ratio,sourceTransform:snapshot.sourceTransform,K:snapshot.K});}
  async function selected(expected){
    const ctx=await host.context(expected);
    if(expected&&host.describe&&!same(await host.describe(ctx),expected))throw Error('O clipe selecionado mudou. Leia a máscara novamente.');
    if(!ctx.motion||!ctx.position||!ctx.scale||!ctx.anchor||!ctx.rotation||!ctx.uniform)
      throw Error('O efeito Movimento não expõe todos os controles necessários. Nada foi alterado.');
    return ctx;
  }
  async function migrationPlan(ctx,settings){
    const receipt=settings.migrationReceipt||null;
    if(!receipt)return null;
    if(settings.replace!==true)throw Error('Para migrar o Transformar antigo, ative Substituir após revisar o clipe. Nada foi alterado.');
    if(guard.isMotion(settings.managedReceipt))throw Error('Há recibos de Movimento e Transformar ao mesmo tempo. Revise a gestão do clipe antes de migrar.');
    if(!legacyGuard||typeof legacyGuard.validate!=='function')throw Error('Não é possível comprovar o Transformar antigo. Nenhuma alteração foi feita.');
    await legacyGuard.validate(ctx,receipt,{replaceEdited:false,note:report});
    const stack=ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2');
    if(receipt.version!==1||!Number.isInteger(receipt.index)||stack[receipt.index]?.match!=='AE.ADBE Geometry2')
      throw Error('O Transformar antigo não corresponde ao recibo. Nada foi alterado.');
    const component=stack[receipt.index].comp,chain=await ctx.clip.getComponentChain();
    if(typeof chain.createRemoveComponentAction!=='function')throw Error('Este Premiere não permite remover o Transformar comprovado na mesma transação. Nada foi alterado.');
    return {receipt,component,chain};
  }
  function geometryContext(ctx,migration){
    return migration?{...ctx,comps:ctx.comps.filter(c=>c.comp!==migration.component)}:ctx;
  }
  async function paramValue(info,time){return unbox(await host.readValue(info,time));}
  const asPoint=v=>M.point(unbox(v));
  async function parameterSeries(info,times){
    // A local snapshot only: another read always rechecks the native control.
    if(await info.param.isTimeVarying()===false){const value=await paramValue(info,times[0]);return times.map(()=>value);}
    const values=[];for(const time of times)values.push(await paramValue(info,time));return values;
  }
  function normalizeParamName(name){return String(name||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z]/g,'');}
  async function validateMotionCrop(ctx,time){
    const comp=ctx.motion.comp||ctx.motion,count=await comp.getParamCount();
    // Six-parameter Motion is the known legacy schema without native crop
    // controls. The newer schema exposes four controls at indices 7..10.
    if(count===6)return;
    if(count<11)throw Error('A estrutura dos controles de corte de Movimento é desconhecida. Nada foi alterado.');
    const expected=[/^(corteaesquerda|cropleft)$/, /^(cortesuperior|croptop)$/, /^(corteadireita|cropright)$/, /^(corteinferior|cropbottom)$/];
    for(let offset=0;offset<4;offset++){
      const index=7+offset,param=await comp.getParam(index),name=normalizeParamName(param?.displayName);
      if(!param||!expected[offset].test(name))throw Error('Não foi possível confirmar o esquema dos controles de corte de Movimento. Nada foi alterado.');
      if(typeof param.isTimeVarying!=='function'||await param.isTimeVarying())
        throw Error('Movimento contém corte animado, que não pode ser compensado com segurança. Nada foi alterado.');
      const value=await paramValue({param},time);
      if(typeof value!=='number'||!Number.isFinite(value)||value!==0)
        throw Error('Movimento contém corte diferente de zero, que não pode ser compensado com segurança. Nada foi alterado.');
    }
  }
  async function timesAndRange(ctx,rows,settings){
    require('./keyframe-sampling.js').validate(settings.keyframeIndices,rows.length);
    if(!Array.isArray(rows)||rows.length<2||!rows.every(r=>r&&[r.x,r.y,r.angle].every(Number.isFinite))||
      !Number.isFinite(settings.fps)||settings.fps<=0||!Number.isInteger(settings.refIndex)||settings.refIndex<0||settings.refIndex>=rows.length)
      throw Error('Dados de rastreamento inválidos. Leia a máscara novamente.');
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe',report),end=await H.clipSeconds(ctx.clip,'getOutPoint','saída do clipe',report);
    const sourceTimes=settings.sourceTimes||rows.map(r=>start+(r.frame-rows[0].frame)/settings.fps);
    if(!Array.isArray(sourceTimes)||sourceTimes.length!==rows.length||!Number.isFinite(start)||!Number.isFinite(end)||
      sourceTimes.some((t,i)=>!Number.isFinite(t)||t<start-1e-7||t>=end+1e-7||(i&&t<=sourceTimes[i-1])))
      throw Error('Os dados ultrapassam a duração do trecho do clipe. Confira FPS e quantidade de quadros.');
    // JSON decoder PTS are rounded to nanoseconds; native TickTime preserves
    // finer precision. Normalize that rounding residue without moving a frame.
    const times=sourceTimes.map(t=>t<start?start:t);
    const step=1/settings.fps,partial=settings.limitToTrackedRange===true;
    const before=partial&&times[0]-start>step*.5?times[0]-step:null;
    const after=partial&&end-times[times.length-1]>step*1.5?times[times.length-1]+step:null;
    return {start,end,times,before,after,partial};
  }
  async function sourceFormat(ctx,W,height){
    const media=await host.readMediaFormat(ctx);let sequencePixelAspect=1;
    if(typeof ctx.seq?.getSettings==='function'){
      const settings=await ctx.seq.getSettings();
      if(typeof settings?.getVideoPixelAspectRatio==='function')sequencePixelAspect=require('./preview-geometry.js').pixelAspect(await settings.getVideoPixelAspectRatio());
      else if(Math.abs(media?.pixelAspect-1)>1e-9)throw Error('Aspecto do pixel da sequência indisponível. Nada foi gravado.');
    }else if(Math.abs(media?.pixelAspect-1)>1e-9)throw Error('Aspecto do pixel da sequência indisponível. Nada foi gravado.');
    return M.validateSourceFormat(media,W,height,{sequencePixelAspect});
  }
  async function readGeometry(ctx,rows,settings,timeInfo){
    const {W,H:height}=settings;
    if(![W,height].every(n=>Number.isFinite(n)&&n>0))throw Error('Formato da sequência inválido.');
    const source=await sourceFormat(ctx,W,height),ratio=source.ratio;
    if(guard.isMotion(settings.managedReceipt)){
      const priorDimensions=settings.managedReceipt.sourceDimensions;
      if(!priorDimensions||priorDimensions.width!==source.width||priorDimensions.height!==source.height||!same(priorDimensions,M.sourceDimensions(source)))
        throw Error('As dimensões da mídia mudaram desde o recibo de Movimento. Revise o clipe antes de reaplicar.');
    }
    const uniformV=await ctx.uniform.param.isTimeVarying();
    if(uniformV||![true,1].includes(unbox(await paramValue(ctx.uniform,timeInfo.times[0]))))
      throw Error('Escala uniforme de Movimento precisa estar ativada e sem animação. Nada foi gravado.');
    const anchors=[],actualRotations=[],scales=[],anchorValues=await parameterSeries(ctx.anchor,timeInfo.times),rotationValues=await parameterSeries(ctx.rotation,timeInfo.times),scaleValues=await parameterSeries(ctx.scale,timeInfo.times);
    for(let i=0;i<timeInfo.times.length;i++){
      const a=asPoint(anchorValues[i]);
      const r=Number(rotationValues[i]),s=Number(scaleValues[i]);
      if(!a||![a.x,a.y,r,s].every(Number.isFinite)||s<=0)throw Error('Movimento contém âncora, rotação ou escala inválida.');
      anchors.push(a);actualRotations.push(r);scales.push(s);
    }
    const receipt=settings.managedReceipt;
    const baseline=guard.isMotion(receipt)?receipt.baseline?.rotationAtReference:null;
    const rotationBase=settings.opt.rotation===true?(Number.isFinite(baseline)?baseline:actualRotations[settings.refIndex]):null;
    // Rotation off after an application that wrote Rotation: those keys are
    // Dynamic Anchor's own compensation, not source rotation. Restore the baseline.
    const restoreRotation=await rotationRestore(ctx,settings,timeInfo);
    const rotations=settings.opt.rotation===true?actualRotations.map(()=>rotationBase):
      restoreRotation!==null?actualRotations.map(()=>restoreRotation):actualRotations.slice();
    M.validateSourceRotation(source,rotations,settings.opt.rotation===true);
    // A âncora do Movimento é normalizada pela mídia: vai para o quadro do vídeo (igual a W×H na mesma proporção).
    const SW=source.sourceWidth,SH=source.sourceHeight;
    const sourceTransform=M.rotationSourceTransform(SW,SH,ratio,anchors,rotations);
    const measured=M.measureInDestination(C,rows,sourceTransform);
    const stack=ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2'),motionIndex=stack.findIndex(c=>c.comp===(ctx.motion.comp||ctx.motion));
    if(motionIndex<0)throw Error('Não foi possível localizar Movimento na pilha do clipe.');
    const geometric=c=>/geometry|transform|crop|corner.?pin|perspective|warp/i.test(c.match);
    if(stack.slice(0,motionIndex).some(geometric))throw Error('Há um efeito geométrico antes de Movimento que não pode ser composto com segurança. Revise a pilha antes de aplicar.');
    const downstream=stack.slice(motionIndex+1);
    const knownGeometry=downstream.filter(geometric);
    if(knownGeometry.some(c=>c.match!=='AE.ADBE Geometry2'))throw Error('Há um efeito geométrico incompatível depois de Movimento. Revise a pilha antes de aplicar.');
    const K=await host.upstreamGeometry(downstream.filter(c=>c.match==='AE.ADBE Geometry2'),timeInfo.times,W,height);
    if(!K||!Number.isFinite(K.scale)||K.scale<=0||!Array.isArray(K.translations)||K.translations.length!==rows.length)
      throw Error('Não foi possível compor os efeitos Transformar posteriores a Movimento.');
    if(K.translations.some(t=>!t||![t.x,t.y].every(Number.isFinite)))throw Error('Posição inválida em um Transformar posterior.');
    const basisScale=ratio*K.scale,anchorVirtual=sourceTransform[settings.refIndex].anchor;
    const motionScale=scales[settings.refIndex];
    const snapshot={version:1,W,H:height,SW,SH,sourceTimes:timeInfo.times.slice(),selection:settings.sourceSelection||null,
      measuredRows:measured,sourceTransform,basisScale,activeScale:motionScale,activeAnchor:anchorVirtual,
      sourceDimensions:M.sourceDimensions(source),rotationBase,ratio,K};
    G.validate(snapshot);
    if(restoreRotation!==null)snapshot.restoreRotation=restoreRotation;
    return snapshot;
  }
  // Returns the baseline rotation to restore when Rotation is off now but the
  // managed receipt says the previous application wrote Rotation keys; null
  // otherwise. Older receipts do not record this: if Rotation has a key on
  // every tracked sample (the Dynamic Anchor dense pattern), refuse instead of
  // guessing whose keys they are.
  async function rotationRestore(ctx,settings,timeInfo){
    const receipt=settings.managedReceipt;
    if(settings.opt.rotation===true||!guard.isMotion(receipt))return null;
    const baseline=receipt.baseline?.rotationAtReference;
    if(receipt.rotationManaged===true){
      if(!Number.isFinite(baseline))throw Error('Não foi possível estabelecer a rotação-base de Movimento.');
      return baseline;
    }
    if(receipt.rotationManaged===false)return null;
    if(!await ctx.rotation.param.isTimeVarying())return null;
    const keys=(await H.keyTimes(ctx.rotation.param,(ctx.rotation.name||'Rotação')+' › keyframes existentes',report)).seconds;
    const dense=timeInfo.times.every(t=>keys.some(k=>Math.abs(k-t)<1e-7));
    if(!dense)return null;
    const error=Error('Este take tem keyframes de Rotação em todos os quadros rastreados, provavelmente de uma aplicação anterior com Rotação ligada, e o recibo não permite confirmar. Para desligar a rotação, apague essas keyframes de Rotação no Movimento e reaplique com Substituir, ou reaplique com Rotação ligada. Nada foi alterado.');
    error.code='ANCHOR_ROTATION_UNKNOWN';throw error;
  }
  function calculate(snapshot,settings){
    const resolved=G.resolveOptions(snapshot,{...settings,opt:{...settings.opt,frame:settings.opt.frame||{w:snapshot.W,h:snapshot.H}}});
    // Motion position is excluded; in scaleMode none the existing absolute
    // Motion scale is the requested baseline. Reapplying writes the same value.
    const guards={guardAuto:settings.opt.scaleMode==='auto',guardFill:settings.opt.guardFill===true};
    let keys=G.checkedKeys(snapshot.measuredRows,settings.refIndex,resolved,guards);
    // Fixed/Auto are virtual fit zooms, identical to the validated core. Only
    // mode none/resetScale uses the native Motion or 100% basis via resolveOptions.
    if(settings.opt.guardFill===true&&settings.opt.scaleMode!=='auto'){
      const coverage=G.evaluateCoverage(snapshot,keys);
      if(coverage.borderFrames||keys.meta.scale+1e-9<coverage.neededScale){
        const e=Error('Preencher quadro: Movimento não cobre toda a imagem sem bordas. Confira os controles. Nada foi aplicado.');
        e.code='ANCHOR_FILL_COVERAGE';throw e;
      }
    }
    return keys;
  }
  async function prepare(ctx,rows,settings,timeInfo){
    const snapshot=await readGeometry(ctx,rows,settings,timeInfo),keys=calculate(snapshot,settings);
    const channels=[{role:'position',info:ctx.position,values:[],name:ctx.position.name},
      {role:'scale',info:ctx.scale,values:[],name:ctx.scale.name}];
    const restoring=Number.isFinite(snapshot.restoreRotation);
    if(settings.opt.rotation===true||restoring)channels.push({role:'rotation',info:ctx.rotation,values:[],name:ctx.rotation.name});
    for(let i=0;i<keys.length;i++){
      const native=M.nativeValues(C,keys,i,{W:snapshot.W,H:snapshot.H,ratio:snapshot.ratio,K:snapshot.K,
        anchorVirtual:snapshot.sourceTransform[i].anchor,rotationBase:snapshot.rotationBase||0});
      channels[0].values.push(native.position);channels[1].values.push(native.scale);
      if(settings.opt.rotation===true)channels[2].values.push(native.rotation);
      else if(restoring)channels[2].values.push(snapshot.restoreRotation);
    }
    for(const channel of channels){
      const selected=require('./keyframe-sampling.js').validate(settings.keyframeIndices,keys.length);
      channel.times=selected?selected.map(i=>timeInfo.times[i]):timeInfo.times.slice();if(selected)channel.values=selected.map(i=>channel.values[i]);
      // Leave an existing key at the guard instant untouched; it already
      // preserves the neighboring value. Otherwise add one frame of guard.
      channel.guardExpected=[];
      if(timeInfo.before!==null){
        const read=await H.keyTimes(channel.info.param,channel.name+' › keyframes existentes',report),existing=read.seconds.some(t=>Math.abs(t-timeInfo.before)<1e-8),value=unbox(await paramValue(channel.info,timeInfo.before));
        channel.guardExpected.push({time:timeInfo.before,value:pointValue(value)});
        if(!existing){
          channel.times.unshift(timeInfo.before);channel.values.unshift(pointValue(unbox(await paramValue(channel.info,timeInfo.before))));
        }
      }
      if(timeInfo.after!==null){
        const read=await H.keyTimes(channel.info.param,channel.name+' › keyframes existentes',report),existing=read.seconds.some(t=>Math.abs(t-timeInfo.after)<1e-8),value=unbox(await paramValue(channel.info,timeInfo.after));
        channel.guardExpected.push({time:timeInfo.after,value:pointValue(value)});
        if(!existing){
          channel.times.push(timeInfo.after);channel.values.push(pointValue(unbox(await paramValue(channel.info,timeInfo.after))));
        }
      }
      channel.times.forEach((t,i)=>{
        if(!Number.isFinite(t)||!(typeof channel.values[i]==='number'||(channel.values[i]&&Number.isFinite(channel.values[i].x)&&Number.isFinite(channel.values[i].y))))
          throw Error(channel.name+': valor inválido em keyframe. Nada foi gravado.');
      });
      if(Array.isArray(settings.keyframeIndices)&&!settings.limitToTrackedRange&&channel.role!=='position'&&channel.values.length>2&&channel.values.every(v=>typeof v==='number'&&Number.isFinite(v)&&v===channel.values[0])){
        keys.meta.constantChannels=keys.meta.constantChannels||[];keys.meta.constantChannels.push({role:channel.role,before:channel.times.length,after:2});
        channel.times=[channel.times[0],channel.times[channel.times.length-1]];channel.values=[channel.values[0],channel.values[channel.values.length-1]];
      }
      if(!await channel.info.param.areKeyframesSupported())throw Error(channel.name+': keyframes não suportados.');
      channel.varying=await channel.info.param.isTimeVarying();
      const list=await H.keyTimes(channel.info.param,channel.name+' › keyframes existentes',report);
      channel.existing=list.ticks.map((tick,i)=>({tick,seconds:list.seconds[i]}));
      const from=timeInfo.times[0],through=timeInfo.times[timeInfo.times.length-1];
      channel.inside=channel.existing.filter(t=>t.seconds>=from-1e-8&&t.seconds<=through+1e-8);
      if(!settings.replace&&channel.inside.length)throw Error(channel.name+': já há keyframes na faixa rastreada. Nada foi gravado: apague os keyframes dessa faixa e aplique de novo.');
    }
    return {snapshot,keys,channels};
  }
  function pointValue(v){return Array.isArray(v)?{x:v[0],y:v[1]}:v;}
  async function prepareDetachedKeys(channels,linear){
    for(const channel of channels){
      channel.detachedKeys=[];
      if(host.pointKeyframes&&channel.values.every(v=>typeof v!=='number')){
        channel.detachedKeys=await host.pointKeyframes.prepare(channel.values,channel.times,report);
        if(channel.detachedKeys.length!==channel.times.length)throw Error('Quantidade de keyframes lineares incompatível. Nada foi alterado.');
        continue;
      }
      for(let i=0;i<channel.times.length;i++){
        const value=channel.values[i],param=channel.info.param;
        const valueArg=typeof value==='number'?value:new ppro.PointF(value.x,value.y);
        const key=param.createKeyframe(valueArg);key.position=ppro.TickTime.createWithSeconds(channel.times[i]);
        if(typeof value==='number'){
          if(typeof key.setTemporalInterpolationMode!=='function')
            throw Error(channel.name+': o Premiere não permite preparar keyframes escalares lineares antes da transação. Nada foi alterado.');
          const accepted=await key.setTemporalInterpolationMode(linear);
          if(accepted===false||typeof key.getTemporalInterpolationMode!=='function'||await key.getTemporalInterpolationMode()!==linear)
            throw Error(channel.name+': o Premiere não confirmou o modo linear da keyframe escalar. Nada foi alterado.');
        }else if(typeof key.setTemporalInterpolationMode==='function'){
          // PointF keyframes may not expose interpolation controls. The guard
          // records this capability explicitly; do not claim verification.
          await key.setTemporalInterpolationMode(linear);
        }
        channel.detachedKeys.push(key);
        if(i>0&&i%2000===0)await report('PREPARANDO: '+channel.name+' | '+i+' de '+channel.times.length+' keyframes.');
      }
    }
  }
  function addKey(channel,key){
    const param=channel.info.param;
    return param.createAddKeyframeAction(key);
  }
  async function apply(rows,settings){
    let committed=false,attempted=false,postWriteReceipt=null;
    try{
    if(settings.destination!=='motion')throw Error('O destino Movimento precisa ser solicitado explicitamente.');
    if(settings.createNew===true)throw Error('O destino Movimento não cria efeitos. Desative Criar Transformar para continuar.');
    if(settings.shutterAngle!==undefined&&settings.shutterAngle!==null&&
      (typeof settings.shutterAngle!=='number'||!Number.isFinite(settings.shutterAngle)||settings.shutterAngle<0||settings.shutterAngle>360))
      throw Error('Ângulo do obturador inválido. Nada foi alterado.');
    if(settings.shutterAngle>0||settings.setShutter===true)throw Error('Desfoque de movimento não está disponível no destino Movimento. Nenhuma alteração foi feita.');
    if(settings.managedReceipt&&!guard.isMotion(settings.managedReceipt))throw Error('O recibo não identifica Movimento. Envie o Transformar comprovado separadamente para migração.');
    const expected=settings.sourceSelection;
      const ctx=await selected(expected),timeInfo=await timesAndRange(ctx,rows,settings);
      await report('INÍCIO: conferindo Movimento e o intervalo do clipe.');
      await validateMotionCrop(ctx,timeInfo.times[0]);
      const migration=await migrationPlan(ctx,settings);
      if(guard.isMotion(settings.managedReceipt)){
        await guard.validate(ctx,settings.managedReceipt,{replaceEdited:replaceEdited(settings),note:report});
      }
      const source=await sourceFormat(ctx,settings.W,settings.H),savedBaseline=guard.isMotion(settings.managedReceipt)?
        settings.managedReceipt.baseline.rotationAtReference:Number(await paramValue(ctx.rotation,timeInfo.times[settings.refIndex]));
      if(!Number.isFinite(savedBaseline))throw Error('Não foi possível estabelecer a rotação-base de Movimento.');
      M.validateSourceRotation(source,[savedBaseline],settings.opt.rotation===true);
      const priorOptions={baseline:{rotationAtReference:savedBaseline},sourceDimensions:M.sourceDimensions(source),
        migration:migration?.receipt||null,note:report,managedReceipt:guard.isMotion(settings.managedReceipt)?settings.managedReceipt:null,
        replaceEdited:replaceEdited(settings)};
      const prior=guard.captureAndValidate?await guard.captureAndValidate(ctx,priorOptions):await guard.capture(ctx,priorOptions);
      if(!guard.captureAndValidate&&guard.isMotion(settings.managedReceipt))
        await guard.validate(ctx,settings.managedReceipt,{replaceEdited:replaceEdited(settings),note:report});
      const geometryCtx=geometryContext(ctx,migration),prepared=await prepare(geometryCtx,rows,settings,timeInfo),{snapshot,keys,channels}=prepared;
      if(!same(snapshot.sourceDimensions,prior.sourceDimensions))
        throw Error('As dimensões da mídia mudaram durante a leitura. Nada foi gravado.');
      if(settings.opt.rotation===true&&snapshot.rotationBase!==prior.baseline.rotationAtReference)
        throw Error('A rotação-base mudou durante a leitura. Nada foi gravado.');
      if(!guard.isMotion(settings.managedReceipt)&&snapshot.sourceTransform[settings.refIndex].rotation!==prior.baseline.rotationAtReference)
        throw Error('A rotação de Movimento mudou durante a leitura. Nada foi gravado.');
      for(const channel of channels){
        if(!channel.varying&&typeof channel.info.param.createSetTimeVaryingAction!=='function')throw Error(channel.name+': não é possível habilitar keyframes.');
      }
      const linear=ppro.Constants?.InterpolationMode?.LINEAR;
      if(typeof linear!=='number'||!Number.isFinite(linear))throw Error('O modo de interpolação linear do Premiere não está disponível. Nada foi alterado.');
      const written=channels.reduce((n,c)=>n+c.times.length,0),beforeCount=channels.reduce((n,c)=>n+c.existing.length,0);
      if(typeof settings.onPreparedReceipt==='function')await settings.onPreparedReceipt(prior);
      await report('PRÉ-VERIFICAÇÃO OK: Movimento | '+rows.length+' quadros; '+channels.length+' canais.');
      // Finish all detached-key setters before reacquiring and validating the
      // selected clip, parameters, source format, geometry, and ownership.
      await prepareDetachedKeys(channels,linear);
      const writeCtx=await selected(expected);
      const freshMigration=migration?await migrationPlan(writeCtx,settings):null;
      const refs={position:writeCtx.position,scale:writeCtx.scale,rotation:writeCtx.rotation};
      for(const channel of channels){const fresh=refs[channel.role];
        if(!fresh||fresh.index!==channel.info.index||fresh.name!==channel.info.name)throw Error('A estrutura dos parâmetros de Movimento mudou durante a aplicação. Nada foi gravado.');
        channel.info=fresh;
      }
      const freshSource=await sourceFormat(writeCtx,settings.W,settings.H);
      if(!same(M.sourceDimensions(freshSource),prior.sourceDimensions))
        throw Error('As dimensões da mídia mudaram durante a aplicação. Nada foi gravado.');
      // Geometry2 is foreign to the Motion receipt fingerprint. Re-read the
      // full geometry after the durable prepared-receipt callback so a change
      // to downstream scale/translation cannot leave keys based on stale K.
      const freshSnapshot=await readGeometry(geometryContext(writeCtx,freshMigration),rows,settings,timeInfo);
      if(geometrySignature(freshSnapshot)!==geometrySignature(snapshot))
        throw Error('A geometria do clipe ou os parâmetros de Movimento mudaram durante a preparação. Leia a máscara novamente antes de aplicar.');
      await validateMotionCrop(writeCtx,timeInfo.times[0]);
      const oldComponent=freshMigration?.component||null,chain=freshMigration?.chain||null;
      // Final fresh ownership checks run after the durable prepared receipt.
      // Nothing awaits between the last proof and entering the transaction.
      if(guard.validateMany){
        const checks=[];
        if(guard.isMotion(settings.managedReceipt))checks.push({receipt:settings.managedReceipt,replaceEdited:replaceEdited(settings)});
        checks.push({receipt:prior,replaceEdited:false});
        await guard.validateMany(writeCtx,checks,{note:report});
      }else{
        if(guard.isMotion(settings.managedReceipt))await guard.validate(writeCtx,settings.managedReceipt,{replaceEdited:replaceEdited(settings),note:report});
        await guard.validate(writeCtx,prior,{replaceEdited:false,note:report});
      }
      if(freshMigration)await legacyGuard.validate(writeCtx,freshMigration.receipt,{replaceEdited:false,note:report});
      attempted=true;
      host.transact(writeCtx.project,'aplicar movimento Dynamic Anchor',ca=>{
        for(const channel of channels)if(!channel.varying)ca.addAction(channel.info.param.createSetTimeVaryingAction(true));
        if(migration)ca.addAction(chain.createRemoveComponentAction(oldComponent));
        for(const channel of channels){
          if(settings.replace)for(const item of channel.inside)ca.addAction(channel.info.param.createRemoveKeyframeAction(item.tick,false));
          for(let i=0;i<channel.times.length;i++){
            ca.addAction(addKey(channel,channel.detachedKeys[i]));
          }
        }
      });
      committed=true;
      // Se a conferência falhar depois da gravação, o recibo "prior" não casa mais com o efeito.
      // Guarda como obter o recibo do efeito como ficou, para a recuperação retomar sem Ctrl+Z.
      postWriteReceipt=async()=>guard.capture(await selected(expected),{baseline:{rotationAtReference:snapshot.rotationBase??snapshot.sourceTransform[settings.refIndex].rotation},rotationManaged:settings.opt.rotation===true,
        sourceDimensions:snapshot.sourceDimensions,migration:null,prior:{fingerprint:prior.fingerprint,matches:prior.matches,pointCurve:prior.pointCurve},note:report});
      let afterCount=0;
      for(const channel of channels){
        const actual=(await H.keyTimes(channel.info.param,channel.name+' › keyframes gravadas',report)).seconds.slice().sort((a,b)=>a-b);
        afterCount+=actual.length;
        const removedInRange=new Set(channel.inside),finalExpected=channel.existing.filter(t=>!removedInRange.has(t)).map(t=>t.seconds).concat(channel.times).sort((a,b)=>a-b);
        if(actual.length!==finalExpected.length||actual.some((t,i)=>Math.abs(t-finalExpected[i])>1e-7))throw Error(channel.name+': tempos ou quantidade de keyframes diferem do esperado. Use Desfazer e confira o clipe.');
        // Every tracked sample is a critical frame. PointF interpolation may
        // be unsupported by the native API, so verify every explicit key.
        for(let i=0;i<channel.times.length;i++){
          let value=unbox(await paramValue(channel.info,channel.times[i]));
          if(Array.isArray(value))value={x:value[0],y:value[1]};
          const want=channel.values[i],valid=typeof want==='number'?Number.isFinite(value)&&Math.abs(value-want)<1e-4:
            value&&Math.abs(value.x-want.x)<1e-5&&Math.abs(value.y-want.y)<1e-5;
          if(!valid)throw Error(channel.name+': valor lido de volta difere do solicitado. Use Desfazer e confira o clipe.');
        }
        for(const check of channel.guardExpected){
          let actualValue=unbox(await paramValue(channel.info,check.time));if(Array.isArray(actualValue))actualValue={x:actualValue[0],y:actualValue[1]};
          const expectedValue=check.value,valid=typeof expectedValue==='number'?Number.isFinite(actualValue)&&Math.abs(actualValue-expectedValue)<1e-4:
            actualValue&&Math.abs(actualValue.x-expectedValue.x)<1e-5&&Math.abs(actualValue.y-expectedValue.y)<1e-5;
          if(!valid)throw Error(channel.name+': o valor da guarda externa mudou. Use Desfazer e confira o clipe.');
        }
      }
      keys.meta.destination='motion';keys.meta.writtenKeyframes=written;keys.meta.pointKeyframeStrategy=host.pointKeyframes?.strategy||null;
      keys.meta.keyframeMetrics={scope:'canais Motion gravados',before:beforeCount,written,after:afterCount,
        transformsBefore:ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2').length,
        transformsAfter:ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2').length-(migration?1:0)};
      keys.meta.geometry=snapshot;keys.meta.measuredRows=snapshot.measuredRows;keys.meta.sourceTransform=snapshot.sourceTransform;
      keys.meta.sourceGeometrySignature=geometrySignature(snapshot);
      if(migration)keys.meta.migratedGeometry2=true;
      try{
        const finalCtx=await selected(expected);
        keys.meta.managedReceipt=await guard.capture(finalCtx,{baseline:{rotationAtReference:snapshot.rotationBase??snapshot.sourceTransform[settings.refIndex].rotation},rotationManaged:settings.opt.rotation===true,
          sourceDimensions:snapshot.sourceDimensions,migration:null,prior:{fingerprint:prior.fingerprint,matches:prior.matches,pointCurve:prior.pointCurve},note:report});
        const unsupported=keys.meta.managedReceipt.interpolationCapabilities?.filter(item=>item.capability==='unsupported-point')||[];
        if(unsupported.length)keys.meta.verificationWarnings=unsupported.map(item=>
          item.name+': interpolação de keyframes PointF não é exposta pelo Premiere; valores e tempos explícitos foram conferidos.'
        );
      }catch(error){keys.meta.needsReview='Movimento aplicado; não foi possível confirmar o recibo: '+error.message;keys.meta.managementWarning=keys.meta.needsReview;}
      return keys;
    }catch(error){
      let committedReceipt=null;
      if(committed&&postWriteReceipt){try{committedReceipt=await postWriteReceipt();}catch(_){committedReceipt=null;}}
      error.anchor={mutationAttempted:attempted,movementCommitted:committed,needsReview:committed,committedReceipt};throw error;}
  }
  async function preview(rows,settings){
    const ctx=await selected(settings.sourceSelection),migration=await migrationPlan(ctx,settings),geometryCtx=geometryContext(ctx,migration);
    const times=await timesAndRange(ctx,rows,settings);await validateMotionCrop(geometryCtx,times.times[0]);
    const prepared=await prepare(geometryCtx,rows,settings,times),keys=prepared.keys;
    keys.meta.destination='motion';keys.meta.measuredRows=prepared.snapshot.measuredRows;
    keys.meta.sourceTransform=prepared.snapshot.sourceTransform;keys.meta.geometry=prepared.snapshot;keys.meta.schematic=true;
    return keys;
  }
  async function readFramingGeometry(rows,settings){
    const ctx=await selected(settings.sourceSelection),migration=await migrationPlan(ctx,settings),geometryCtx=geometryContext(ctx,migration);
    const times=await timesAndRange(ctx,rows,settings);await validateMotionCrop(geometryCtx,times.times[0]);
    const snapshot=await readGeometry(geometryCtx,rows,settings,times);
    return snapshot;
  }
  async function readSourceGeometrySignature(settings){
    const ctx=await selected(settings.sourceSelection),migration=await migrationPlan(ctx,settings),geometryCtx=geometryContext(ctx,migration),rawTimes=settings.sourceTimes,W=settings.W,Hh=settings.H;
    // B17: mesma normalização da aplicação (resíduo de arredondamento antes do in-point vira o in-point).
    let times=rawTimes;if(Array.isArray(rawTimes)&&rawTimes.length){const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe',report);if(Number.isFinite(start))times=rawTimes.map(t=>Number.isFinite(t)&&t<start?start:t);}
    if(!Array.isArray(times)||!times.length||times.some((t,i)=>!Number.isFinite(t)||(i&&t<=times[i-1]))||![W,Hh].every(n=>Number.isFinite(n)&&n>0))
      throw Error('Tempos ou formato ausentes para conferir a geometria de Movimento.');
    const source=await sourceFormat(geometryCtx,W,Hh),anchors=[],rotations=[];
    const anchorValues=await parameterSeries(geometryCtx.anchor,times),rotationValues=await parameterSeries(geometryCtx.rotation,times);
    for(let i=0;i<times.length;i++){const a=asPoint(anchorValues[i]),r=Number(rotationValues[i]);
      if(!a||![a.x,a.y,r].every(Number.isFinite))throw Error('Âncora ou rotação inválida ao conferir Movimento.');anchors.push(a);rotations.push(r);}
    if(settings.opt?.rotation===true&&guard.isMotion(settings.managedReceipt)&&Number.isFinite(settings.managedReceipt.baseline?.rotationAtReference))
      rotations.fill(settings.managedReceipt.baseline.rotationAtReference);
    else if(settings.opt?.rotation!==true){
      // Same rule as readGeometry: Rotation keys written by Dynamic Anchor are not source rotation.
      const restore=await rotationRestore(geometryCtx,{...settings,opt:settings.opt||{}},{times});
      if(restore!==null)rotations.fill(restore);
    }
    M.validateSourceRotation(source,rotations,settings.opt?.rotation===true);
    const sourceTransform=M.rotationSourceTransform(source.sourceWidth,source.sourceHeight,source.ratio,anchors,rotations),stack=geometryCtx.comps.filter(c=>c.match!=='AE.ADBE AEMask2'),at=stack.findIndex(c=>c.comp===(geometryCtx.motion.comp||geometryCtx.motion));
    if(at<0)throw Error('Não foi possível localizar Movimento ao conferir sua geometria.');
    const geometric=c=>/geometry|transform|crop|corner.?pin|perspective|warp/i.test(c.match);
    if(stack.slice(0,at).some(geometric))throw Error('Há um efeito geométrico antes de Movimento.');
    const downstream=stack.slice(at+1),known=downstream.filter(geometric);
    if(known.some(c=>c.match!=='AE.ADBE Geometry2'))throw Error('Há um efeito geométrico incompatível depois de Movimento.');
    const K=await host.upstreamGeometry(downstream.filter(c=>c.match==='AE.ADBE Geometry2'),times,W,Hh);
    return I.digest({W,H:Hh,sourceTimes:times,sourceDimensions:M.sourceDimensions(source),ratio:source.ratio,sourceTransform,K});
  }
  async function verifyManaged(expected,receipt){const ctx=await selected(expected);await guard.validate(ctx,receipt);return true;}
  async function appliedCheck(expected,receipt,expectedKeys){const ctx=await selected(expected);return guard.appliedCheck(ctx,receipt,expectedKeys);}
  return {apply,preview,readFramingGeometry,readSourceGeometrySignature,verifyManaged,appliedCheck};
}

module.exports={createMotionEngine};
