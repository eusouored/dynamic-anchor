'use strict';
// All reads finish before synchronous lock/transaction callbacks. No actions escape the lock.
function createEngine(ppro, C, checkpoint, options={}) {
  let running = false;
  const guard=options.pointKeyframes?require('./transform-curve-guard').createTransformCurveGuard(ppro):require('./effect-guard.js').createGuard(ppro),H=require('./host-values.js'),H_=require('./host-values.js'),G=require('./framing-geometry.js');
  const integrity=require('./integrity.js');
  const sameSelection=(a,b)=>require('./integrity.js').canonical(a)===require('./integrity.js').canonical(b);
  const unbox = k => k && k.value !== undefined ? unbox(k.value) : k;
  // Auto preenche o quadro. Um limite insuficiente nunca autoriza aplicar bordas.
  // A margem extra pode ser reduzida, desde que a cobertura geométrica permaneça.
  function checkedKeys(rows,refIndex,opt){
    return G.checkedKeys(rows,refIndex,opt);
  }
  // Both lists are time ordered. Avoid comparing every frame with every
  // existing keyframe on long clips.
  // actual: segundos já conferidos (H.keyTimes), nunca TickTime cru do host.
  function missingTimes(expected,actual,tolerance){
    const sorted=actual.slice().sort((a,b)=>a-b),missing=[];let j=0;
    for(const time of expected){while(j<sorted.length&&sorted[j]<time-tolerance)j++;
      if(j===sorted.length||Math.abs(sorted[j]-time)>=tolerance)missing.push(time);}
    return missing;
  }
  // Posição do efeito na pilha sem máscaras (a mesma contagem do recibo).
  const effectIndex=ctx=>ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2').findIndex(c=>c.comp===ctx.effect.comp);
  function overlaps(a,b,tolerance){let i=0,j=0;
    while(i<a.length&&j<b.length){const delta=a[i]-b[j];if(Math.abs(delta)<tolerance)return true;if(delta<0)i++;else j++;}
    return false;
  }
  // 1.7.7: consultas independentes vão juntas ao Premiere. Com o Premiere ocupado, cada resposta
  // pode levar décimos de segundo; uma a uma, a leitura de um take somava dezenas delas.
  const range=n=>Array.from({length:n},(_,i)=>i);
  async function components(clip) {
    const chain = await clip.getComponentChain(), n = await chain.getComponentCount();
    const comps = await Promise.all(range(n).map(i => chain.getComponentAtIndex(i)));
    return Promise.all(comps.map(async comp => { const [match, name] = await Promise.all([comp.getMatchName(), comp.getDisplayName()]); return { comp, match, name }; }));
  }
  async function params(comp) {
    const n = await comp.getParamCount(), list = await Promise.all(range(n).map(i => comp.getParam(i)));
    return list.map((param, index) => ({ param, name: String(param.displayName || ''), index }));
  }
  async function context(expected=null,all=false) {
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error('Abra um projeto no Premiere.');
    const seq = await project.getActiveSequence();
    if (!seq) throw new Error('Abra uma sequência.');
    const items = await (await seq.getSelection()).getTrackItems();
    const read = await Promise.all((items || []).map(async clip => {
      if (typeof clip.getComponentChain !== 'function') return null;
      const comps = await components(clip);
      const motion = comps.find(c => /AE\.ADBE Motion/i.test(c.match)) ||
        comps.find(c => /^(motion|movimento|movimiento|bewegung|mouvement)$/i.test(c.name));
      return motion ? { clip, comps, motion } : null;
    })), found = read.filter(Boolean);
    if(expected){const same=await Promise.all(found.map(async info=>sameSelection(await describe({project,seq,...info}),expected)));found.splice(0,found.length,...found.filter((_,i)=>same[i]));}
    // B27: com um clipe esperado, "não achei" significa que ele mudou de posição ou de corte, não que falta seleção.
    if(expected&&!found.length)throw new Error('O clipe mudou de posição ou de corte desde a leitura. Leia o rastreamento de novo. Nada foi aplicado.');
    if(all){if(!found.length)throw new Error('Selecione pelo menos um clipe de vídeo.');return found.map(info=>({project,seq,...info}));}
    if (found.length !== 1) throw new Error(found.length ? 'Selecione apenas um clipe de vídeo.' : 'Selecione um clipe de vídeo com Movimento na timeline.');
    const info = found[0], ps = await params(info.motion.comp);
    const pick = (re, index) => ps.find(p => re.test(p.name.trim())) || ps[index];
    return { project, seq, ...info, position:pick(/posi/i,0), scale:pick(/^(scale|escala|échelle|skalierung)$/i,1),
      uniform:ps[3], rotation:pick(/rota|drehung/i,4), anchor:pick(/anchor|ancor|ancla|anker|ancrage/i,5) };
  }
  function transact(project, title, build) {
    let ok = false;
    project.lockedAccess(() => { ok = project.executeTransaction(build, 'Dynamic Anchor: ' + title); });
    if (ok !== true) throw new Error('O Premiere recusou a transação: ' + title + '. Operação interrompida.');
  }
  async function readStatic(info, time) {
    if (!info || await info.param.isTimeVarying()) throw new Error((info ? info.name : 'Parâmetro') + ': já possui animação. Use uma cópia sem essa animação.');
    return unbox(await info.param.getValueAtTime(ppro.TickTime.createWithSeconds(time)));
  }
  async function readValue(info,time){
    return unbox(await info.param.getValueAtTime(ppro.TickTime.createWithSeconds(time)));
  }
  async function motionGeometry(ctx,times,W,H){
    const point=v=>Array.isArray(v)?{x:v[0],y:v[1]}:v;
    // Cache only non-animated channels, for this application only. Never reuse
    // values across user edits, clips, or separate Apply operations.
    const fixed=new Map();
    for(const info of [ctx.position,ctx.anchor,ctx.scale,ctx.rotation])
      if(!await info.param.isTimeVarying())fixed.set(info,await readValue(info,times[0]));
    const at=async(info,time)=>fixed.has(info)?fixed.get(info):await readValue(info,time);
    const uniform=ctx.uniform?await readStatic(ctx.uniform,times[0]):true;
    if(uniform!==true&&uniform!==1)throw new Error('Ative Escala uniforme em Movimento para compor o rastreamento.');
    const output=[];
    for(const time of times){
      const rawPosition=point(await at(ctx.position,time)),rawAnchor=point(await at(ctx.anchor,time));
      const scale=Number(await at(ctx.scale,time))/100,rotation=Number(await at(ctx.rotation,time));
      if(!rawPosition||!rawAnchor||![rawPosition.x,rawPosition.y,rawAnchor.x,rawAnchor.y,scale,rotation].every(Number.isFinite)||!(scale>0))
        throw new Error('Movimento contém um ajuste inválido.');
      output.push({position:{x:rawPosition.x*W,y:rawPosition.y*H},anchor:{x:rawAnchor.x*W,y:rawAnchor.y*H},scale,rotation});
    }
    return output;
  }
  function inMotion(rows,sourceTransform){
    // Resolve a facial reference before composing Motion. Leaving a source
    // trackingPoint beside transformed x/y would make core use it twice.
    const points=C.motionRows(rows);
    return sourceTransform?points.map((row,i)=>{
      const m=sourceTransform[i],v=C.rot({x:row.x-m.anchor.x,y:row.y-m.anchor.y},m.rotation);
      return {...row,x:m.position.x+m.scale*v.x,y:m.position.y+m.scale*v.y,angle:row.angle+m.rotation};
    }):points;
  }
  async function transformContext(ctx, createNew=false) {
    let matches = ctx.comps.filter(c => c.match === 'AE.ADBE Geometry2');
    if (!matches.length || createNew) {
      const previousCount=matches.length;
      const names = await ppro.VideoFilterFactory.getMatchNames();
      if (!names.includes('AE.ADBE Geometry2')) throw new Error('O efeito Transformar não está disponível neste Premiere.');
      const component = await ppro.VideoFilterFactory.createComponent('AE.ADBE Geometry2');
      const chain = await ctx.clip.getComponentChain();
      await checkpoint('ANTES: adicionar efeito Transformar.');
      transact(ctx.project,'adicionar Transformar', ca => { ca.addAction(chain.createAppendComponentAction(component)); });
      await checkpoint('DEPOIS: efeito Transformar adicionado; Movimento preservado.');
      ctx.comps = await components(ctx.clip);
      matches = ctx.comps.filter(c => c.match === 'AE.ADBE Geometry2');
      if (matches.length !== previousCount+1) throw new Error('Não foi possível confirmar o efeito Transformar adicionado.');
    }
    const effect=matches[matches.length-1],ps=await params(effect.comp);
    const required=[0,1,2,3,5,7];
    if (required.some(i=>!ps[i])) throw new Error('Estrutura do efeito Transformar não reconhecida.');
    return {...ctx,position:ps[1],scale:ps[3],uniform:ps[2],rotation:ps[7],anchor:ps[0],skew:ps[5],useCompositionShutter:ps[9],shutterAngle:ps[10],effect,upstream:matches.slice(0,-1)};
  }
  async function upstreamGeometry(effects,times,W,H){
    let scale=1;
    const translations=times.map(()=>({x:0,y:0}));
    for(const effect of effects){
      const ps=await params(effect.comp),start=times[0];
      if([0,1,2,3,5,7].some(i=>!ps[i]))throw new Error('Transformar anterior não reconhecido.');
      const s=Number(await readStatic(ps[3],start))/100,a=unbox(await readStatic(ps[0],start));
      const anchor=Array.isArray(a)?{x:a[0],y:a[1]}:a;
      const uniform=await readStatic(ps[2],start),skew=Number(await readStatic(ps[5],start)),rotation=Number(await readStatic(ps[7],start));
      if(![true,1].includes(uniform)||!(s>0)||!anchor||![anchor.x,anchor.y].every(Number.isFinite)||skew!==0||rotation!==0)
        throw new Error('Para combinar efeitos, o Transformar anterior precisa de escala uniforme e não pode ter giro ou inclinação.');
      const positionAnimated=await ps[1].param.isTimeVarying(),staticPosition=positionAnimated?null:unbox(await readValue(ps[1],start));
      for(let i=0;i<times.length;i++){
        const raw=positionAnimated?unbox(await ps[1].param.getValueAtTime(ppro.TickTime.createWithSeconds(times[i]))):staticPosition,p=Array.isArray(raw)?{x:raw[0],y:raw[1]}:raw;
        if(!p||![p.x,p.y].every(Number.isFinite))throw new Error('Posição inválida no Transformar anterior.');
        translations[i]={x:s*translations[i].x+p.x*W-s*anchor.x*W,y:s*translations[i].y+p.y*H-s*anchor.y*H};
      }
      scale*=s;
    }
    if(!Number.isFinite(scale))throw new Error('Escala acumulada inválida.');
    return {scale,translations};
  }
  async function activeGeometry(previous,reuse,times,W,H){
    if(!reuse||!previous.length)return {activeScale:100,activeAnchor:{x:W/2,y:H/2}};
    const ps=await params(previous[previous.length-1].comp);
    if([0,2,3,5].some(i=>!ps[i]))throw Error('Transformar inválido para medir o enquadramento.');
    const scale=Number(await readValue(ps[3],times[0])),raw=await readValue(ps[0],times[0]),anchor=Array.isArray(raw)?{x:raw[0],y:raw[1]}:raw;
    const uniform=await readStatic(ps[2],times[0]),skew=Number(await readStatic(ps[5],times[0]));
    if(![true,1].includes(uniform))throw Error('Ative Escala uniforme no efeito Transformar.');
    if(!Number.isFinite(skew)||Math.abs(skew)>1e-7)throw Error('O Transformar já tem Inclinação. Use um efeito sem inclinação para o Dynamic Anchor.');
    if(!(scale>0)||!anchor||![anchor.x,anchor.y].every(Number.isFinite))throw Error('Transformar inválido para medir o enquadramento.');
    return {activeScale:scale,activeAnchor:{x:anchor.x*W,y:anchor.y*H}};
  }
  function snapshotGeometry(rows,settings,sourceTransform,basis,active,reuse){
    return {version:1,W:settings.W,H:settings.H,sourceTimes:settings.sourceTimes?settings.sourceTimes.slice():null,selection:settings.sourceSelection||null,
      measuredRows:inMotion(rows,sourceTransform),sourceTransform,basisScale:basis.scale,...active,reuse:!!reuse,ownershipVerified:false};
  }
  function sourceGeometrySignature(W,H,times,sourceTransform,basis){
    return integrity.digest({version:1,W,H,sourceTimes:times,sourceTransform,basisScale:basis.scale,upstreamTranslations:basis.translations});
  }
  async function readFramingGeometry(rows,settings){
    const started=Date.now(),ctx=await context(settings.sourceSelection),times=settings.sourceTimes;
    if(!Array.isArray(rows)||rows.length<2||!Array.isArray(times)||times.length!==rows.length||![settings.W,settings.H].every(n=>Number.isFinite(n)&&n>0))throw Error('Dados incompletos para medir o enquadramento.');
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (enquadramento)'),end=await H.clipSeconds(ctx.clip,'getOutPoint','saída do clipe (enquadramento)');
    if(times.some((t,i)=>!Number.isFinite(t)||t<start||t>=end+1e-7||(i&&t<=times[i-1])))throw Error('Intervalo inválido para medir o enquadramento.');
    const previous=ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2');
    let reuse=!settings.createNew&&settings.effectPolicy!=='managed'||!settings.createNew&&!!settings.managedReceipt;
    if(settings.effectPolicy==='managed'&&settings.managedReceipt&&reuse){
      if(guard.isMissing(ctx,settings.managedReceipt))reuse=false;
      else{
        const stack=settings.managedReceipt.layout==='effects-without-mask-v1'?ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2'):ctx.comps;
        if(settings.managedReceipt.version!==1||!Number.isInteger(settings.managedReceipt.index)||!sameSelection(settings.managedReceipt.matches,stack.map(c=>c.match))||stack[settings.managedReceipt.index]?.match!=='AE.ADBE Geometry2'||stack.slice(settings.managedReceipt.index+1).some(c=>c.match==='AE.ADBE Geometry2'))throw Error('A ordem dos efeitos mudou. Não foi possível medir a pilha atual.');
      }
    }
    reuse=!!(reuse&&previous.length);
    const basis=await upstreamGeometry(reuse?previous.slice(0,-1):previous,times,settings.W,settings.H),active=await activeGeometry(previous,reuse,times,settings.W,settings.H);
    const sourceTransform=settings.sourceSelection?await motionGeometry(ctx,times,settings.W,settings.H):null;
    const snapshot=snapshotGeometry(rows,settings,sourceTransform,basis,active,reuse);G.validate(snapshot);
    // Reads never attest receipt ownership. Apply/explicit Preview retain the
    // full guard; this lighter snapshot cannot authorize a mutation.
    if(settings.sourceSelection)await context(settings.sourceSelection);
    snapshot.readMs=Date.now()-started;return snapshot;
  }
  async function readSourceGeometrySignature(settings){
    let times=settings&&settings.sourceTimes;const W=settings&&settings.W,H=settings&&settings.H,selection=settings&&settings.sourceSelection,receipt=settings&&settings.managedReceipt;
    if(!selection||!receipt||!Array.isArray(times)||!times.length||![W,H].every(n=>Number.isFinite(n)&&n>0)||times.some((t,i)=>!Number.isFinite(t)||(i&&t<=times[i-1])))
      throw Error('Dados incompletos para conferir a geometria de origem.');
    const ctx=await context(selection),stack=receipt.layout==='effects-without-mask-v1'?ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2'):ctx.comps;
    // This read only fingerprints calculation inputs; it cannot attest ownership
    // or authorize mutation. shouldSkip compares geometry first, then runs the
    // final full receipt check. The host does not expose an atomic read snapshot.
    if(receipt.version!==1||!Number.isInteger(receipt.index)||!Array.isArray(receipt.matches)||!sameSelection(receipt.matches,stack.map(c=>c.match))||stack[receipt.index]?.match!=='AE.ADBE Geometry2'||stack.slice(receipt.index+1).some(c=>c.match==='AE.ADBE Geometry2'))
      throw Error('A ordem dos efeitos mudou. Não foi possível conferir a geometria de origem.');
    {const start=await H_.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (conferência)');if(Number.isFinite(start))times=times.map(t=>(t<start&&start-t<1e-7)?start:t);}
    const sourceTransform=await motionGeometry(ctx,times,W,H);
    const upstream=stack.slice(0,receipt.index).filter(c=>c.match==='AE.ADBE Geometry2');
    const basis=await upstreamGeometry(upstream,times,W,H);
    return sourceGeometrySignature(W,H,times,sourceTransform,basis);
  }
  async function apply(rows, settings) {
    if (running) throw new Error('Já existe uma aplicação em andamento.');
    running = true;
    let movementCommitted=false,mutationAttempted=false,preparedReceipt=null,diagnosticWarning=null,committedReceipt=null,activeCtx=null;
    const totalStart=Date.now(),timings={};let phaseStart=totalStart;
    const report=async message=>{
      try{await checkpoint(message);}catch(error){
        if(!movementCommitted)throw error;
        diagnosticWarning=error.message;
      }
    };
    try {
      if(!Array.isArray(rows)||rows.length<2||!rows.every(r=>r&&[r.x,r.y,r.angle].every(Number.isFinite))||
        !Number.isFinite(settings.fps)||settings.fps<=0||!Number.isInteger(settings.refIndex)||settings.refIndex<0||settings.refIndex>=rows.length)
        throw new Error('Dados de rastreamento inválidos. Leia a máscara novamente.');
      if(settings.opt&&settings.opt.zoomProtection!==undefined&&typeof settings.opt.zoomProtection!=='boolean')
        throw new Error('zoomProtection deve ser booleano.');
      if(settings.opt&&settings.opt.zoomProtection===true&&
        (settings.opt.scaleMode!=='auto'||settings.resetScale===true||settings.opt.scaleOverride!==undefined))
        throw new Error("zoomProtection só aceita scaleMode 'auto' e não aceita resetScale/scaleOverride.");
      const requestedShutter=settings.shutterAngle;
      if(requestedShutter!==undefined && (typeof requestedShutter!=='number'||!Number.isFinite(requestedShutter)||requestedShutter<0||requestedShutter>360))
        throw new Error('Ângulo do obturador: informe um número entre 0 e 360 graus.');
      await report('INÍCIO: verificando clipe e parâmetros.');
      if(options.pointKeyframes?.ready)await options.pointKeyframes.ready();
      let ctx = await context(settings.sourceSelection);
      const {project,clip} = ctx;
      if (settings.sourceSelection) {
        const actual=await describe(ctx);
        if(!sameSelection(actual,settings.sourceSelection))throw new Error('O clipe selecionado mudou. Leia a máscara novamente.');
      }
      const start = await H.clipSeconds(clip,'getInPoint','entrada do clipe',report);
      const end = await H.clipSeconds(clip,'getOutPoint','saída do clipe',report);
      const keyframeIndices=require('./keyframe-sampling.js').validate(settings.keyframeIndices,rows.length);
      // B17: resíduo de arredondamento antes do in-point vira o in-point (igual ao Movimento e à releitura).
      const times = (settings.sourceTimes || rows.map(r => start + (r.frame - rows[0].frame) / settings.fps)).map(t => (t < start && start - t < 1e-7) ? start : t);
      if (times.length!==rows.length || !Number.isFinite(start) || !Number.isFinite(end) || times.some((t,i) => !Number.isFinite(t) || t < start || t >= end + 1e-7 || (i>0&&t<=times[i-1])))
        throw new Error('Os dados ultrapassam a duração do trecho do clipe. Confira o FPS e a quantidade de quadros.');
      const gated=settings.limitToTrackedRange===true;
      const frameStep=1/settings.fps;
      const before=gated&&times[0]-start>frameStep*.5?times[0]-frameStep:null;
      const after=gated&&end-times[times.length-1]>frameStep*1.5?times[times.length-1]+frameStep:null;
      let sourceTransform=settings.sourceSelection?await motionGeometry(ctx,times,settings.W,settings.H):null;
      let measured=inMotion(rows,sourceTransform);
      // Recusa antes de vincular/criar um Transformar ou iniciar qualquer transação.
      if(settings.opt.scaleMode==='auto')checkedKeys(measured,settings.refIndex,{...settings.opt,sourceTransform});
      // Validate the existing stack before adding a new effect.
      const previous=ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2');
      let createNew=settings.createNew===true,validatedReceipt=null;
      if(settings.recoverManaged===true){
        // Interrupted operations must pass the same strict check as explicit
        // recovery, including when the user requested a new effect. Missing,
        // edited or ambiguous effects never authorize creating or replacing one.
        if(settings.effectPolicy!=='managed'||!settings.managedReceipt)throw Error('Não há identificação suficiente para retomar. Preserve o efeito ou vincule-o explicitamente após a revisão.');
        await report('ETAPA_UI: conferir-existente');
        const validateStart=Date.now();
        const validation=await guard.validate(ctx,settings.managedReceipt,{replaceEdited:false,note:report});
        timings.validateMs=Date.now()-validateStart;
        validatedReceipt=validation&&validation.receipt||null;
        await report('RECUPERAÇÃO: efeito conferido automaticamente antes da aplicação.');
      }else if(settings.effectPolicy==='managed'){
        if(settings.managedReceipt&&!createNew){
          if(guard.isMissing(ctx,settings.managedReceipt)){
            createNew=true;
            await report('RECUPERAÇÃO: Transformar removido; um novo efeito será criado, com os demais efeitos preservados.');
          }else{
            await report('ETAPA_UI: conferir-existente');
            const validateStart=Date.now();
            const validation=await guard.validate(ctx,settings.managedReceipt,{replaceEdited:settings.replace===true,note:report});
            timings.validateMs=Date.now()-validateStart;
            if(validation?.edited)await report('REAPLICAÇÃO: Transformar ajustado; substituição habilitada. O enquadramento será recalculado com os controles atuais do Dynamic Anchor.');
            else validatedReceipt=validation&&validation.receipt||null;
          }
        }
        else if(!settings.managedReceipt){
          // Sem recibo (ripple antigo, Salvar como, estado perdido): um Transformar já animado quase sempre é
          // o do próprio Dynamic Anchor. Criar outro empilharia dois efeitos e o segundo recalcularia em cima do primeiro.
          const existing=ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2'),animated=[];
          for(const c of existing){try{for(const p of await params(c.comp))if(await p.param.isTimeVarying()){animated.push(c);break;}}catch(_){}}
          if(!animated.length)createNew=true; // Transformar manual sem animação: nunca é tocado, o Dynamic Anchor cria o seu
          else if(animated.length===1&&existing.length===1&&settings.replace===true){
            const receipt=await guard.capture({...ctx,effect:animated[0]},report);
            const validation=await guard.validate(ctx,receipt,{replaceEdited:true,note:report});
            validatedReceipt=validation&&validation.receipt||receipt;settings={...settings,managedReceipt:receipt};
            await report('RECUPERAÇÃO: recibo perdido; o Transformar animado existente foi vinculado e será atualizado, sem criar outro efeito.');
          }else{
            const error=Error(existing.length>1?'Este take tem mais de um Transformar e o Dynamic Anchor não consegue saber qual é o dele. Nada foi gravado. Remova os efeitos que não são do Dynamic Anchor ou revise a pilha antes de aplicar.'
              :'Este take já tem um Transformar animado, provavelmente do Dynamic Anchor, mas o registro da aplicação anterior foi perdido. Apague esse Transformar (ou desfaça com Ctrl+Z) e aplique de novo, para não criar um segundo efeito. Nada foi gravado.');
            error.code='ANCHOR_EFFECT_UNLINKED';error.anchor={mutationAttempted:false,movementCommitted:false};throw error;
          }
        }
      }
      // Receipt checks can take a long time on dense effects. A change to
      // Motion during that check is not covered by the Transform receipt.
      // Refresh only coverage-promising runs; caches remain local to a read.
      if(settings.sourceSelection&&(settings.opt.guardFill===true||settings.opt.scaleMode==='auto')){
        sourceTransform=await motionGeometry(ctx,times,settings.W,settings.H);measured=inMotion(rows,sourceTransform);
      }
      const basis=await upstreamGeometry(createNew?previous:previous.slice(0,-1),times,settings.W,settings.H);
      // Fill is a promise about this actual application, not a stored preview.
      // Check it before appending an effect or opening any native transaction.
      if(settings.opt.guardFill===true||settings.opt.scaleMode==='auto'){
        const active=await activeGeometry(previous,!createNew&&previous.length>0,times,settings.W,settings.H);
        G.calculate(snapshotGeometry(rows,settings,sourceTransform,basis,active,!createNew&&previous.length>0),settings);
      }
      if(createNew||!previous.length)mutationAttempted=true;
      ctx = await transformContext(ctx,createNew);
      activeCtx=ctx;
      if(settings.effectPolicy==='managed'){
        // Efeito conferido agora mesmo e não alterado desde então (nenhum efeito
        // novo): o recibo da conferência vale; não relê as mesmas keyframes.
        const reuse=validatedReceipt&&!createNew&&ctx.effect&&effectIndex(ctx)===validatedReceipt.index,receiptStart=Date.now();
        if(!reuse)await report('ETAPA_UI: conferir-existente');
        preparedReceipt=reuse?validatedReceipt:await guard.capture(ctx,report);
        timings.preparedReceiptMs=Date.now()-receiptStart;timings.preparedReceiptReused=!!reuse;
        if(settings.onPreparedReceipt)await settings.onPreparedReceipt(preparedReceipt);
      }
      let shutterState=null;
      if(requestedShutter!==undefined){
        // Geometry2 exposes its checkbox at index 9 with a blank displayName in Premiere 26.
        if(!ctx.useCompositionShutter||!ctx.shutterAngle||!/shutter|obturador/i.test(ctx.shutterAngle.name)||
          (ctx.useCompositionShutter.name.trim()&&!/shutter|obturador/i.test(ctx.useCompositionShutter.name)))
          throw new Error('Os controles do obturador deste Transformar não foram reconhecidos.');
        const useComposition=await readStatic(ctx.useCompositionShutter,start),angle=Number(await readStatic(ctx.shutterAngle,start));
        if(![true,false,0,1].includes(useComposition)||!Number.isFinite(angle))throw new Error('Não foi possível ler o obturador do Transformar.');
        shutterState={useComposition:!!useComposition,angle};
      }
      const skew = Number(await readStatic(ctx.skew,start));
      if (!Number.isFinite(skew) || Math.abs(skew)>1e-7) throw new Error('O Transformar já tem Inclinação. Use um efeito sem inclinação para o Dynamic Anchor.');
      const rotationAnimated = await ctx.rotation.param.isTimeVarying();
      const resetStaticRotation = !gated && !settings.opt.rotation && !rotationAnimated;
      const scaleAnimated=await ctx.scale.param.isTimeVarying(),anchorAnimated=await ctx.anchor.param.isTimeVarying();
      if(!settings.replace&&(scaleAnimated||anchorAnimated))throw new Error('O Transformar já possui animação. Nada foi gravado: apague os keyframes desse Transformar ou aplique num novo efeito.');
      const zoomProtection=settings.opt.zoomProtection===true;
      const animateScale=gated||scaleAnimated||zoomProtection,animateAnchor=(gated&&settings.opt.rotation)||anchorAnimated;
      const scale = Number(animateScale?await readValue(ctx.scale,times[0]):await readStatic(ctx.scale,start));
      const rawAnchor = animateAnchor?await readValue(ctx.anchor,times[0]):await readStatic(ctx.anchor,start);
      const anchor = Array.isArray(rawAnchor) ? {x:rawAnchor[0], y:rawAnchor[1]} : rawAnchor;
      const uniform = ctx.uniform ? await readStatic(ctx.uniform, start) : true;
      await report('LEITURA: escala=' + JSON.stringify(scale) + '; âncora=' + JSON.stringify(anchor) + '; uniforme=' + JSON.stringify(uniform));
      if (uniform !== true && uniform !== 1) throw new Error('Ative Escala uniforme no efeito Transformar.');
      if (!(scale > 0) || !anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y))
        throw new Error('Não foi possível ler a escala e o ponto de ancoragem do clipe.');
      const geometry={version:1,W:settings.W,H:settings.H,sourceTimes:times,selection:settings.sourceSelection||null,measuredRows:measured,sourceTransform,basisScale:basis.scale,
        activeScale:scale,activeAnchor:{x:anchor.x*settings.W,y:anchor.y*settings.H},reuse:!createNew&&previous.length>0,ownershipVerified:!!validatedReceipt};
      const opt=G.resolveOptions(geometry,settings);
      timings.readMs=Date.now()-phaseStart;phaseStart=Date.now();
      const keys = checkedKeys(measured, settings.refIndex, opt);
      timings.calculateMs=Date.now()-phaseStart;phaseStart=Date.now();
      keys.meta.measuredRows=measured;
      keys.meta.sourceTransform=sourceTransform;
      keys.meta.sourceGeometrySignature=sourceGeometrySignature(settings.W,settings.H,times,sourceTransform,basis);
      if (keys.some(k => ![k.px,k.py,k.rotation,k.scale].every(Number.isFinite)))
        throw new Error('O cálculo produziu valores inválidos. Confira os dados de movimento.');
      // Compose N = desired * upstream^-1; appending a Transform must not track twice.
      const nativeScale=keys.meta.scale/basis.scale*100;
      const nativeScales=zoomProtection?keys.map(k=>k.scale/basis.scale*100):null;
      // Keep the first tracked-frame value before guarded-range keys are
      // unshifted into the same stream array below.
      const expectedFirstScale=zoomProtection?nativeScales[0]:nativeScale;
      const positions=keys.map((k,i)=>{
        const t=basis.translations[i],s=k.scale/basis.scale,a=k.anchor;
        const correction=C.rot({x:s*(a.x-t.x)-k.scale*a.x,y:s*(a.y-t.y)-k.scale*a.y},k.rotation);
        return {x:(k.px+correction.x)/settings.W,y:(k.py+correction.y)/settings.H};
      });
      const animated = [{info:ctx.position, values:positions}];
      // Disabling compensation replaces existing rotation samples with zero.
      if (opt.rotation || rotationAnimated || gated) animated.push({info:ctx.rotation,values:keys.map(k => k.rotation)});
      if(animateScale)animated.push({info:ctx.scale,values:zoomProtection?nativeScales:keys.map(()=>nativeScale)});
      if(animateAnchor)animated.push({info:ctx.anchor,values:keys.map(()=>({x:keys[0].anchor.x/settings.W,y:keys[0].anchor.y/settings.H}))});
      // The neighboring frames retain the Transform values that existed before
      // this run. Tracking never extends beyond the saved mask interval.
      for(const stream of animated){
        stream.times=keyframeIndices?keyframeIndices.map(i=>times[i]):times.slice();if(keyframeIndices)stream.values=keyframeIndices.map(i=>stream.values[i]);
        if(before!==null){
          const v=await readValue(stream.info,before);
          stream.times.unshift(before);stream.values.unshift(Array.isArray(v)?{x:v[0],y:v[1]}:v);
        }
        if(after!==null){
          const v=await readValue(stream.info,after);
          stream.times.push(after);stream.values.push(Array.isArray(v)?{x:v[0],y:v[1]}:v);
        }
      }
      // Preflight every stream before touching any stream.
      for (const stream of animated) {
        const p = stream.info.param;
        if (!await p.areKeyframesSupported()) throw new Error(stream.info.name + ': keyframes não suportados.');
        stream.varying = await p.isTimeVarying();
        const existing = await H.keyTimes(p,stream.info.name+' › keyframes existentes',report);
        stream.existing = existing.ticks.map((tick,i)=>({tick,seconds:existing.seconds[i]}));
        // A partial mask must stop motion at its last saved frame. When replacing
        // an existing run, remove stale keys in the untracked remainder too.
        const replacementEnd=gated?stream.times[stream.times.length-1]+1e-8:
          settings.replace&&settings.replaceThroughEnd===true?end-1e-8:times[times.length-1]+1e-8;
        stream.inside = stream.existing.filter(t => t.seconds >= (gated?stream.times[0]:times[0]) - 1e-8 && t.seconds <= replacementEnd);
        if (!settings.replace && overlaps(stream.inside.map(t=>t.seconds).sort((a,b)=>a-b),stream.times,1e-8))
          throw new Error('Já há keyframes nos mesmos tempos. Nada foi gravado: apague os keyframes desse trecho e aplique de novo.');
      }
      // Complete native PointF copies before entering the transaction.
      if(options.pointKeyframes)for(const stream of animated){
        if(stream.values.every(v=>typeof v!=='number')){
          stream.detachedKeys=await options.pointKeyframes.prepare(stream.values,stream.times,report);
          if(stream.detachedKeys.length!==stream.times.length)throw Error('Quantidade de pontos lineares incompatível. Nada foi gravado.');
        }
      }
      await report('PRÉ-VERIFICAÇÃO OK: Transformar | ' + rows.length + ' quadros; escala ' + (keys.meta.scale*100).toFixed(2) + '%.');
      // Preserve every animated sample, including constant channels and interval guards.
      // The editor requested the original dense keyframe behavior.
      keys.meta.omittedKeyframes=0;keys.meta.pointKeyframeStrategy=options.pointKeyframes?.strategy||null;
      keys.meta.writtenKeyframes=animated.reduce((n,s)=>n+s.times.length,0);
      keys.meta.keyframeMetrics={scope:'canais animados gravados',before:animated.reduce((n,s)=>n+s.existing.length,0),written:keys.meta.writtenKeyframes,after:0,transformsBefore:previous.length,transformsAfter:ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2').length};
      const removed = animated.reduce((n,s) => n + (settings.replace ? s.inside.length : 0), 0);
      await report('ETAPA_UI: aplicar-movimento');
      await report('ANTES: gravar escala, ' + animated.length + ' canais; substituir ' + removed + ' keyframes individuais.');
      timings.prepareKeysMs=Date.now()-phaseStart;phaseStart=Date.now();
      if(settings.sourceSelection)await context(settings.sourceSelection);
      mutationAttempted=true;
      transact(project, 'aplicar movimento', ca => {
        // Animation and keyframe writes belong to the same host transaction.
        for(const stream of animated)if(!stream.varying)ca.addAction(stream.info.param.createSetTimeVaryingAction(true));
        if (resetStaticRotation) ca.addAction(ctx.rotation.param.createSetValueAction(ctx.rotation.param.createKeyframe(0), false));
        if(shutterState){
          if(shutterState.useComposition)ca.addAction(ctx.useCompositionShutter.param.createSetValueAction(ctx.useCompositionShutter.param.createKeyframe(false),false));
          if(Math.abs(shutterState.angle-requestedShutter)>1e-6)ca.addAction(ctx.shutterAngle.param.createSetValueAction(ctx.shutterAngle.param.createKeyframe(requestedShutter),false));
        }
        if (!animateScale && (settings.resetScale === true || opt.scaleMode !== 'none') && Math.abs(scale - nativeScale) > 1e-6)
          ca.addAction(ctx.scale.param.createSetValueAction(ctx.scale.param.createKeyframe(nativeScale), false));
        if (opt.rotation && !animateAnchor) {
          const a = keys[0].anchor;
          ca.addAction(ctx.anchor.param.createSetValueAction(ctx.anchor.param.createKeyframe(new ppro.PointF(a.x/settings.W,a.y/settings.H)), false));
        }
        for (const stream of animated) {
          const p = stream.info.param;
          if (settings.replace) for (const t of stream.inside) ca.addAction(p.createRemoveKeyframeAction(t.tick, false));
          stream.values.forEach((v,i) => {
            const k = stream.detachedKeys?stream.detachedKeys[i]:p.createKeyframe(typeof v === 'number' ? v : new ppro.PointF(v.x,v.y));
            if(!stream.detachedKeys)k.position = ppro.TickTime.createWithSeconds(stream.times[i]);
            ca.addAction(p.createAddKeyframeAction(k));
          });
        }
      });
      movementCommitted=true;
      timings.writeMs=Date.now()-phaseStart;phaseStart=Date.now();
      await report('ETAPA_UI: conferir-resultado');
      await report('DEPOIS: transação de movimento aceita. Conferindo os tempos gravados.');
      if (resetStaticRotation && Number(await readStatic(ctx.rotation,start)) !== 0)
        throw new Error('Não foi possível zerar a rotação do Transformar.');
      const confirmedScale=Number(animateScale?await readValue(ctx.scale,times[0]):await readStatic(ctx.scale,start));
      if(!Number.isFinite(confirmedScale)||Math.abs(confirmedScale-expectedFirstScale)>1e-4)
        throw new Error('A escala lida de volta difere da solicitada. Confira o efeito Transformar.');
      await report('ESCALA DO TRANSFORMAR: '+confirmedScale.toFixed(2)+' confirmada.');
      if(shutterState){
        const useComposition=await readStatic(ctx.useCompositionShutter,start),angle=Number(await readStatic(ctx.shutterAngle,start));
        if((useComposition!==false&&useComposition!==0)||!Number.isFinite(angle)||Math.abs(angle-requestedShutter)>1e-4)
          throw new Error('O obturador lido de volta difere do solicitado. Confira o efeito Transformar.');
        await report('OBTURADOR: '+angle+'° confirmados; ângulo da composição desligado.');
      }
      for (const stream of animated) {
        const read = (await H.keyTimes(stream.info.param,stream.info.name+' › keyframes gravadas',report)).seconds;
        keys.meta.keyframeMetrics.after+=read.length;
        const missing = missingTimes(stream.times,read,1e-7);
        if (missing.length) throw new Error(stream.info.name + ': faltam ' + missing.length + ' keyframes. Revise o clipe ou use Desfazer.');
        await report(stream.info.name + ': ' + stream.times.length + '/' + stream.times.length + ' tempos confirmados; total no clipe: ' + read.length + '.');
        const indexes=[...new Set([0,Math.floor(stream.times.length/4),Math.floor(stream.times.length/2),Math.floor(stream.times.length*3/4),stream.times.length-1])];
        const checks=indexes.map(i=>({time:stream.times[i],value:stream.values[i]}));
        for(const check of checks){
          let actual=unbox(await stream.info.param.getValueAtTime(ppro.TickTime.createWithSeconds(check.time))),expected=check.value;
          if(Array.isArray(actual))actual={x:actual[0],y:actual[1]};
          const valid=typeof expected==='number'?Number.isFinite(actual)&&Math.abs(actual-expected)<1e-4:
            actual&&Number.isFinite(actual.x)&&Number.isFinite(actual.y)&&Math.abs(actual.x-expected.x)<1e-5&&Math.abs(actual.y-expected.y)<1e-5;
          if(!valid)throw new Error(stream.info.name+': o valor lido de volta difere do calculado em '+check.time.toFixed(6)+' s. Use Desfazer e confira o clipe.');
        }
        await report(stream.info.name+': '+indexes.length+' amostras de valores lidas de volta e conferidas.');
      }
      timings.verifyTimesMs=Date.now()-phaseStart;
      await report('CONCLUÍDO: escala ' + (keys.meta.scale*100).toFixed(2) + '%.');
      if(diagnosticWarning)keys.meta.diagnosticWarning=diagnosticWarning;
      if(settings.effectPolicy==='managed'){
        const receiptStart=Date.now();
        try{keys.meta.managedReceipt=await guard.capture(ctx,report,preparedReceipt);}
        catch(error){keys.meta.managementWarning='Movimento aplicado, mas o efeito precisa ser revisto: '+error.message;}
        finally{timings.receiptMs=Date.now()-receiptStart;}
      }
      timings.verifyMs=Date.now()-phaseStart;timings.totalMs=Date.now()-totalStart;keys.meta.timings=timings;
      return keys;
    } catch(error) {
      // Gravação já aceita pelo Premiere e conferência falhou: o recibo "preparado" descreve o efeito
      // ANTES da gravação e não casa mais. Registra o recibo do efeito como está agora (feito por nós
      // nesta mesma operação) para a recuperação poder retomar sem exigir Ctrl+Z.
      if(mutationAttempted&&activeCtx&&settings.effectPolicy==='managed'&&typeof guard.capture==='function'){
        try{committedReceipt=await guard.capture(activeCtx,null,preparedReceipt);}catch(_){committedReceipt=null;}
      }
      error.anchor={mutationAttempted,movementCommitted,preparedReceipt,committedReceipt};
      throw error;
    } finally { running = false; }
  }
  async function probe() {
    const ctx = await context();
    for (const c of ctx.comps) {
      await checkpoint(c.name + ' (' + c.match + ')');
      for (const p of await params(c.comp)) {
        const list=await p.param.getKeyframeListAsTickTimes(),problem=H.listProblem(list);
        await checkpoint('  ' + p.name + ': animado=' + await p.param.isTimeVarying() + '; keyframes=' + (problem?'lista inválida ('+problem+')':list.length));
      }
    }
    await checkpoint('A inspeção lista parâmetros expostos pela API. Máscaras não atribuídas podem não aparecer.');
  }
  async function sequenceFormat(expected=null) {
    const bound=expected?await context(expected):null,project=bound?bound.project:await ppro.Project.getActiveProject(),seq=bound?bound.seq:project&&await project.getActiveSequence();
    if (!seq) throw new Error('Abra uma sequência no Premiere.');
    return formatOf(seq);
  }
  async function formatOf(seq){
    const [rect, timebase] = await Promise.all([seq.getFrameSize(), seq.getTimebase()]), ticks = Number(timebase);
    const width = rect.width === undefined ? rect.right-rect.left : rect.width;
    const height = rect.height === undefined ? rect.bottom-rect.top : rect.height;
    if (!(width>0 && height>0 && ticks>0)) throw new Error('Não foi possível ler o formato. Preencha os campos manualmente.');
    return { width,height,fps:254016000000/ticks };
  }
  async function describe(ctx) {
    const {project,seq,clip}=ctx;
    // Todas as leituras juntas; os erros continuam saindo na ordem de antes (velocidade primeiro).
    const settled=await Promise.allSettled([clip.getSpeed(),clip.isSpeedReversed(),clip.getTrackIndex(),clip.getName(),
      H.clipSeconds(clip,'getStartTime','início do clipe na sequência'),H.clipSeconds(clip,'getEndTime','fim do clipe na sequência'),
      H.clipSeconds(clip,'getInPoint','entrada do clipe'),H.clipSeconds(clip,'getOutPoint','saída do clipe'),
      typeof clip.getProjectItem==='function'?clip.getProjectItem():null]);
    const value=i=>{if(settled[i].status==='rejected')throw settled[i].reason;return settled[i].value;};
    if(Math.abs(Number(value(0))-1)>1e-8||value(1))throw new Error('Use um clipe sem alteração de velocidade nem inversão.');
    const description={projectPath:project.path,sequenceId:seq.guid.toString(),trackIndex:value(2),name:value(3),
      start:value(4),end:value(5),inPoint:value(6),outPoint:value(7)};
    if(project.guid)description.projectGuid=project.guid.toString();
    const item=value(8);
    if(item&&typeof item.getId==='function')description.projectItemId=String(await item.getId());
    return description;
  }
  async function diagnose(){
    const contexts=await context(null,true),items=[];
    for(const ctx of contexts){
      let keyframes=0,animated=0,hostProblems=0;
      for(const c of ctx.comps)for(const p of await params(c.comp)){
        if(await p.param.isTimeVarying())animated++;
        const list=await p.param.getKeyframeListAsTickTimes();
        if(H.listProblem(list))hostProblems++;else keyframes+=list.length;
      }
      items.push({name:typeof ctx.clip.getName==='function'?await ctx.clip.getName():'',transforms:ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2').length,accessibleMasks:ctx.comps.filter(c=>/mask/i.test(c.match)).length,keyframes,animated,...(hostProblems?{hostProblems}:{})});
    }
    const totals={takes:items.length,items,maskVisibility:'Somente componentes expostos pela API; não comprova ausência de outras máscaras.'};
    for(const key of ['transforms','accessibleMasks','keyframes','animated'])totals[key]=items.reduce((n,item)=>n+item[key],0);
    return totals;
  }

  async function preview(rows,settings){
    const ctx=await context(settings.sourceSelection),times=settings.sourceTimes;
    if(!Array.isArray(times)||times.length!==rows.length)throw Error('Tempos ausentes para a prévia.');
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (prévia)'),end=await H.clipSeconds(ctx.clip,'getOutPoint','saída do clipe (prévia)');
    if(times.some((t,i)=>!Number.isFinite(t)||t<start||t>=end+1e-7||(i&&t<=times[i-1])))throw Error('Intervalo inválido para a prévia.');
    const previous=ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2');
    let reuse=!settings.createNew&&settings.effectPolicy!=='managed'||!settings.createNew&&!!settings.managedReceipt;
    if(settings.effectPolicy==='managed'&&settings.managedReceipt&&reuse){
      if(guard.isMissing(ctx,settings.managedReceipt))reuse=false;
      else await guard.validate(ctx,settings.managedReceipt,{replaceEdited:settings.replace===true});
    }
    reuse=reuse&&previous.length>0;
    const basis=await upstreamGeometry(reuse?previous.slice(0,-1):previous,times,settings.W,settings.H);
    const active=await activeGeometry(previous,reuse,times,settings.W,settings.H);
    const sourceTransform=settings.sourceSelection?await motionGeometry(ctx,times,settings.W,settings.H):null;
    const geometry=snapshotGeometry(rows,settings,sourceTransform,basis,active,reuse),keys=G.calculate(geometry,settings);
    keys.meta.measuredRows=geometry.measuredRows;keys.meta.sourceTransform=sourceTransform;keys.meta.geometry=geometry;keys.meta.schematic=true;return keys;
  }
  async function selections(){const contexts=await context(null,true);return Promise.all(contexts.map(describe));}
  async function selection(){return describe(await context());}
  async function saveForRead(expected){
    const ctx=Array.isArray(expected)?(await context(null,true))[0]:await context(),actual=Array.isArray(expected)?await selections():await describe(ctx);
    if(!sameSelection(actual,expected))throw new Error('A seleção mudou durante a leitura. Tente novamente.');
    if(!await ctx.project.save())throw new Error('Não foi possível salvar o projeto para ler a máscara.');
  }
  // Leitura rápida (só contagem de keyframes) para saber se a aplicação ainda
  // está no Transformar gerenciado, por exemplo depois de um Ctrl+Z.
  async function appliedCheck(expected,receipt,expectedKeys){
    const ctx=await context(expected),stack=ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2'),entry=receipt&&Number.isInteger(receipt.index)?stack[receipt.index]:null;
    // Pilha diferente do recibo (efeito inserido/removido pelo editor): não dá para afirmar
    // "desfeito"; só é ausência certa quando não sobrou nenhum Transformar.
    const order=Array.isArray(receipt&&receipt.matches)?receipt.matches:null;
    if(order&&(order.length!==stack.length||order.some((m,i)=>m!==stack[i].match)))
      return stack.some(c=>c.match==='AE.ADBE Geometry2')?{present:null,reason:'order',keys:null}:{present:false,reason:'effect',keys:0};
    if(!entry||entry.match!=='AE.ADBE Geometry2')return {present:false,reason:'effect',keys:0};
    // Lista vazia/nula do host: não dá para afirmar presença nem ausência.
    let keys=0;for(const {param} of await params(entry.comp)){if(await param.isTimeVarying()){const list=await param.getKeyframeListAsTickTimes();if(H.listProblem(list))return {present:null,reason:'host',keys:null};keys+=list.length;}}
    if(guard.appliedCheck&&receipt?.pointCurve){const proof=await guard.appliedCheck({...ctx,effect:entry},receipt);if(proof)return proof;}
    const enough=Number.isFinite(expectedKeys)&&expectedKeys>0?keys>=expectedKeys:keys>0;
    return {present:enough,reason:enough?null:'keyframes',keys};
  }
  async function verifyManaged(expected,receipt){await guard.validate(await context(expected),receipt);return true;}
  const summarize=(ctx,selection)=>({selection,visibleMasks:ctx.comps.filter(c=>/mask/i.test(c.match)).length,transforms:ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2').length});
  async function selectionSummary(){
    const contexts=await context(null,true),selections=await Promise.all(contexts.map(describe));
    return contexts.map((ctx,i)=>summarize(ctx,selections[i]));
  }
  // 1.7.7: a troca de take lia a seleção duas vezes (identidade e resumo das máscaras). Agora é uma leitura só.
  async function selectionsWithSummary(){
    const contexts=await context(null,true),selections=await Promise.all(contexts.map(describe));
    return {selections,summary:contexts.map((ctx,i)=>summarize(ctx,selections[i]))};
  }
  // 1.7.7: tudo o que a análise precisa do Premiere numa leitura só (antes eram quatro leituras
  // completas da seleção: take, formato da sequência, arquivo do clipe e a conferência final).
  async function analysisSource(){
    const ctx=await context(),[selection,sequenceFormat,media]=await Promise.all([describe(ctx),formatOf(ctx.seq),mediaOf(ctx)]);
    return {selection,sequenceFormat,media};
  }
  async function navigate(expected,sourceTime){
    const ctx=await context(expected);
    if(!Number.isFinite(sourceTime)||sourceTime<expected.inPoint-1e-7||sourceTime>=expected.outPoint)throw Error('Escolha um quadro dentro deste trecho.');
    if(typeof ctx.seq.setPlayerPosition!=='function')throw Error('Esta versão não oferece navegação pelo painel.');
    let position=ppro.TickTime.createWithSeconds(expected.start+sourceTime-expected.inPoint);
    // Só navegação: segundos arredondados podem cair alguns ticks antes da borda
    // e o cursor ser truncado para o quadro anterior. Usa a grade da sequência.
    // Nunca altera sourceTimes nem os tempos dos keyframes aplicados.
    if(typeof position.alignToNearestFrame==='function'||typeof ppro.TickTime.createWithFrameAndFrameRate==='function'){
      let rate=null;
      if(typeof ctx.seq.getSettings==='function'){
        const settings=await ctx.seq.getSettings();
        if(typeof settings?.getVideoFrameRate==='function')rate=await settings.getVideoFrameRate();
      }
      const validRate=r=>r&&typeof r.ticksPerFrame==='number'&&Number.isSafeInteger(r.ticksPerFrame)&&r.ticksPerFrame>0;
      if(!validRate(rate)&&typeof ctx.seq.getTimebase==='function'&&typeof ppro.FrameRate?.createWithValue==='function'){
        const ticks=Number(await ctx.seq.getTimebase());
        if(Number.isSafeInteger(ticks)&&ticks>0){
          const fallback=ppro.FrameRate.createWithValue(254016000000/ticks);
          // Não aceita uma aproximação da taxa como se fosse a grade exata.
          if(validRate(fallback)&&fallback.ticksPerFrame===ticks)rate=fallback;
        }
      }
      if(validRate(rate)){
        if(typeof position.alignToNearestFrame==='function')position=await position.alignToNearestFrame(rate);
        else position=ppro.TickTime.createWithFrameAndFrameRate(Math.round(position.seconds*254016000000/rate.ticksPerFrame),rate);
        // O ponto de saída é exclusivo. Um aviso em outPoint−1ms não deve
        // arredondar para o primeiro quadro do próximo clipe.
        const fps=254016000000/rate.ticksPerFrame,first=Math.ceil(expected.start*fps-1e-7),last=Math.ceil(expected.end*fps-1e-7)-1;
        if(last<first)throw Error('O trecho não contém um quadro da sequência para navegação.');
        const wanted=Math.round(position.seconds*fps),frame=Math.max(first,Math.min(last,wanted));
        if(frame!==wanted){
          position=typeof ppro.TickTime.createWithFrameAndFrameRate==='function'?ppro.TickTime.createWithFrameAndFrameRate(frame,rate):
            await ppro.TickTime.createWithSeconds(frame/fps).alignToNearestFrame(rate);
        }
      }
      // Host sem a grade/API necessária conserva a navegação anterior.
    }
    if(!position||typeof position.seconds!=='number'||!Number.isFinite(position.seconds))throw Error('Não foi possível determinar o quadro para navegação.');
    if(await ctx.seq.setPlayerPosition(position)===false)throw Error('O Premiere recusou a navegação.');
  }
  async function adoptLast(expected,confirmed=false){
    if(confirmed!==true)throw Error('Confirme a vinculação do efeito antes de continuar.');
    const ctx=await context(expected),matches=ctx.comps.filter(c=>c.match==='AE.ADBE Geometry2');
    if(!matches.length)throw Error('O trecho não tem Transformar para vincular.');
    const receipt=await guard.capture({...ctx,effect:matches[matches.length-1]});await guard.validate(ctx,receipt);return receipt;
  }
  // Rendered sequence pixels are analysis-only, never source-mask coordinates.
  async function exportAnalysisFrame(expected,sequenceTime,folder,width,height){
    const ctx=await context();
    if(!sameSelection(await describe(ctx),expected))throw Error('A seleção mudou. Prepare a análise novamente.');
    if(!Number.isFinite(sequenceTime)||sequenceTime<expected.start-1e-7||sequenceTime>=expected.end||!folder||!folder.nativePath||![width,height].every(n=>Number.isInteger(n)&&n>=8&&n<=1024))throw Error('Quadro de análise fora do intervalo.');
    if(!ppro.Exporter||typeof ppro.Exporter.exportSequenceFrame!=='function')throw Error('Esta versão do Premiere não oferece exportação de quadros ao UXP.');
    const ok=await ppro.Exporter.exportSequenceFrame(ctx.seq,ppro.TickTime.createWithSeconds(sequenceTime),'analysis.bmp',folder.nativePath,width,height);
    if(ok!==true)throw Error('O Premiere não conseguiu renderizar o quadro de análise.');
    if(!sameSelection(await selection(),expected))throw Error('A seleção mudou durante a exportação.');
    return folder.getEntry('analysis.bmp');
  }
  // Read-only: media and proxy paths for the external face engine. Each API is
  // optional; a missing path is reported, never guessed.
  async function mediaSource(expected=null){return mediaOf(await context(expected));}
  async function mediaOf(ctx){
    const clip=ctx.clip;
    if(typeof clip.getProjectItem!=='function')throw Error('Este Premiere não informa o item de projeto do clipe.');
    const item=await clip.getProjectItem(),cast=ppro.ClipProjectItem&&typeof ppro.ClipProjectItem.cast==='function'?ppro.ClipProjectItem.cast(item):item;
    if(!cast)throw Error('O clipe selecionado não é uma mídia de arquivo.');
    const read=async name=>{try{if(typeof cast[name]!=='function')return null;const value=await cast[name]();return typeof value==='string'&&value?value:null;}catch(error){return null;}};
    const proxy=async()=>{try{return typeof cast.hasProxy!=='function'||await cast.hasProxy()?await read('getProxyPath'):null;}catch(error){return null;}};
    // Dimensões e aspecto do pixel da mídia (metadados do Premiere): o motor analisa no quadro do vídeo.
    const format=async()=>{try{return await require('./motion-source.js').readMediaFormat(ppro,ctx);}catch(error){return null;}};
    const [mediaPath,proxyPath,mediaFormat]=await Promise.all([read('getMediaFilePath'),proxy(),format()]);
    return {mediaPath,proxyPath,format:mediaFormat};
  }
  // The product panel requests Motion explicitly. The old path remains only
  // for reading/verifying historical receipts and its existing contract tests;
  // it is never a fallback after a failed Motion request.
  let directMotion=null;
  const motion=()=>directMotion||(directMotion=require('./motion-engine.js').createMotionEngine({ppro,C,checkpoint,host:{
    context,describe,components,params,transact,readValue,upstreamGeometry,legacyGuard:guard,pointKeyframes:options.pointKeyframes,motionGuard:options.pointKeyframes?require('./motion-curve-guard').createMotionCurveGuard(ppro):null,
    readMediaFormat:ctx=>require('./motion-source.js').readMediaFormat(ppro,ctx)
  }}));
  const wantsMotion=settings=>{
    if(settings?.destination!==undefined&&!['motion','transform'].includes(settings.destination))throw Error('Destino de aplicação desconhecido. Nada foi alterado.');
    return settings?.destination==='motion';
  };
  const motionReceipt=receipt=>receipt?.version===2&&receipt.destination==='motion';
  const forMotion=settings=>{
    const receipt=settings?.managedReceipt;
    if(!receipt||motionReceipt(receipt))return settings;
    if(receipt.version!==1||!Array.isArray(receipt.matches)||!Number.isInteger(receipt.index)||receipt.matches[receipt.index]!=='AE.ADBE Geometry2')
      throw Error('Recibo de aplicação desconhecido. Nada foi alterado.');
    if(settings.migrationReceipt&&integrity.canonical(settings.migrationReceipt)!==integrity.canonical(receipt))
      throw Error('Há recibos de migração diferentes. Revise o clipe antes de aplicar.');
    return {...settings,migrationReceipt:receipt,managedReceipt:null};
  };
  async function applyToDestination(rows,settings){
    if(!wantsMotion(settings))return apply(rows,settings);
    if(running)throw Error('Já existe uma aplicação em andamento.');
    running=true;try{return await motion().apply(rows,forMotion(settings));}finally{running=false;}
  }
  return {supportsManagedRecoveryPreflight:true,motionPointKeyframeStrategy:options.pointKeyframes?.strategy||null,transformPointKeyframeStrategy:options.pointKeyframes?.strategy||null,apply:applyToDestination,
    preview:(rows,settings)=>wantsMotion(settings)?motion().preview(rows,forMotion(settings)):preview(rows,settings),
    readFramingGeometry:(rows,settings)=>wantsMotion(settings)?motion().readFramingGeometry(rows,forMotion(settings)):readFramingGeometry(rows,settings),
    readSourceGeometrySignature:settings=>wantsMotion(settings)?motion().readSourceGeometrySignature(forMotion(settings)):readSourceGeometrySignature(settings),
    verifyManaged:(expected,receipt)=>motionReceipt(receipt)?motion().verifyManaged(expected,receipt):verifyManaged(expected,receipt),
    appliedCheck:(expected,receipt,expectedKeys)=>motionReceipt(receipt)?motion().appliedCheck(expected,receipt,expectedKeys):appliedCheck(expected,receipt,expectedKeys),
    probe,diagnose,adoptLast,selectionSummary,selectionsWithSummary,analysisSource,navigate,sequenceFormat,selection,selections,saveForRead,exportAnalysisFrame,mediaSource};
}
if (typeof module !== 'undefined') module.exports = {createEngine};

