'use strict';
const I=require('./integrity.js'),T=require('./trajectory.js'),E=require('./editing.js'),Q=require('./quality.js'),R=require('./tracking-reference.js'),SourceGuard=require('./source-guard.js');
function createWorkflow({engine,repository,report=()=>{},maxCachedSamples=50000,maxCachedStates=64}){
  const memory=new Map(),states=new Map(),confirmations=new Map(),unsavedStates=new Set();let canceled=false;
  const samples=data=>data.masks.reduce((n,m)=>n+m.rows.length,0);
  function cacheInfo(){return {cachedTakes:memory.size,cachedSamples:[...memory.values()].reduce((n,d)=>n+samples(d),0),cachedStates:states.size};}
  function rememberState(key,value,unsaved=false){
    if(unsaved)unsavedStates.add(key);
    states.delete(key);states.set(key,value);
    // Only persisted identities can be evicted; session-only state has no fallback.
    if(repository)for(const old of states.keys()){if(states.size<=maxCachedStates)break;if(old!==key&&!old.startsWith('legacy:')&&!unsavedStates.has(old))states.delete(old);}
    return value;
  }
  function remember(key,data){memory.delete(key);memory.set(key,data);let count=cacheInfo().cachedSamples;for(const [old,value]of memory){if(memory.size<=24&&count<=maxCachedSamples)break;if(old!==key&&value.persistent){memory.delete(old);count-=samples(value);}}return data;}
  const takeKey=s=>{try{return T.key(s);}catch(_){return 'legacy:'+I.digest(s);}};
  async function verifyAnalysisSource(selection,data){
    const facial=!!(data&&(data.evidence?.faceEngine===true||data.masks?.some(mask=>mask.type==='external-face')));
    if(!facial){
      const saved=data&&data.evidence&&data.evidence.projectStamp;
      if(saved&&data.persistent){const now=await SourceGuard.fileSignature(selection.projectPath);
        if(now&&(now.mediaSize!==saved.mediaSize||now.mediaModified!==saved.mediaModified))throw Error('O projeto foi salvo depois da leitura da máscara; ela pode ter sido refeita. Clique em Ler máscara para ler de novo.');}
      return;
    }
    const evidence=data.evidence||{},hasStamp=Object.prototype.hasOwnProperty.call(evidence,'sourceStamp');
    if(!hasStamp){report('AVISO: trajeto facial legado sem identificação da mídia; origem não certificada.');return;}
    await SourceGuard.verify(evidence.sourceStamp,selection,engine);
  }
  function sourceGeometrySpec(data,settings){
    const times=settings.sourceTimes||data.times;
    if(!Array.isArray(times)||!times.length||times.some((t,i)=>!Number.isFinite(t)||(i&&t<=times[i-1]))||
      ![settings.W,settings.H].every(n=>Number.isFinite(n)&&n>0)||!Number.isInteger(settings.refIndex)||settings.refIndex<0||settings.refIndex>=times.length)return null;
    return {W:settings.W,H:settings.H,sourceTimes:times.slice(),refIndex:settings.refIndex,opt:{rotation:settings.opt?.rotation===true}};
  }
  const isMotionReceipt=receipt=>!!receipt&&receipt.version===2&&receipt.destination==='motion'&&receipt.layout==='native-motion-v1'&&receipt.match==='AE.ADBE Motion';
  // Historical Geometry2 receipts remain usable only by the legacy Transform
  // path or as a separately named, freshly verified migration proof.
  const isLegacyTransformReceipt=receipt=>!!receipt&&receipt.version===1&&Array.isArray(receipt.matches)&&Number.isInteger(receipt.index)&&
    receipt.matches[receipt.index]==='AE.ADBE Geometry2'&&typeof receipt.fingerprint==='string'&&receipt.fingerprint.length>0;
  function destinationOptions(selection,settings,old){
    const destination=settings.destination||'transform';
    // 0.9.45: Movimento → Transformar somaria o Transformar ao Movimento já animado pelo Dynamic Anchor.
    // Sem uma forma comprovada de devolver o Movimento à base, recusa antes de ler ou gravar.
    if(destination!=='motion'&&isMotionReceipt(old.managedReceipt)){
      const error=Error('Este take já tem o rastreamento do Dynamic Anchor em Movimento. Para não somar dois movimentos, ele continua em Movimento: desligue "Usar efeito Transformar" para atualizá-lo. Nada foi alterado.');
      error.code='ANCHOR_DESTINATION_SWITCH';throw error;
    }
    if(destination!=='motion')return {destination,managedReceipt:old.managedReceipt||null};
    const managedReceipt=isMotionReceipt(old.managedReceipt)?old.managedReceipt:null;
    const migrationReceipt=settings.replace===true?(managedReceipt&&isLegacyTransformReceipt(managedReceipt.migration)?managedReceipt.migration:
      !managedReceipt&&isLegacyTransformReceipt(old.managedReceipt)?old.managedReceipt:null):null;
    return {destination,managedReceipt,migrationReceipt};
  }
  async function capture(groups,selections,evidence={}){
    // Máscara lida do .prproj: guarda tamanho e data do arquivo no momento da leitura. Se o projeto mudar depois
    // (máscara refeita e salva), aplicar o trajeto salvo exige ler a máscara de novo.
    if(!evidence.faceEngine&&!evidence.projectStamp){const stamp=await SourceGuard.fileSignature(selections[0]&&selections[0].projectPath);if(stamp)evidence={...evidence,projectStamp:stamp};}
    // Validate the entire batch before publishing any captured data.
    const records=groups.map((masks,i)=>{try{return T.record(selections[i],masks,evidence);}catch(error){if(selections[i].projectGuid&&selections[i].projectItemId)throw error;return null;}});
    for(let i=0;i<groups.length;i++){
      const key=takeKey(selections[i]),record=records[i];
      const previous=await load(selections[i]),newMasks=record?record.masks:I.clone(groups[i].map((m,index)=>({...m,maskKey:m.maskKey||String(index)+':'+m.name})));
      const motionDigest=masks=>I.digest(masks.map(m=>({key:m.maskKey||m.name,W:m.W,H:m.H,SW:m.SW,SH:m.SH,fps:m.fps,rows:m.rows,times:m.times,rotationSupported:m.rotationSupported,
        ...(R.isVideo15(m.trackingReference)?{trackingReference:m.trackingReference,referenceCoverage:m.referenceCoverage}:{})})));
      const changed=previous&&motionDigest(previous.masks)!==motionDigest(newMasks);
      // Invalidar antes de publicar outra fonte: uma falha de armazenamento
      // não pode deixar o novo trajeto ligado ao estado "verificado" do antigo.
      if(changed){const old=await state(selections[i]);if(old.status==='verified')await saveState(selections[i],{...old,status:'adjusted',finalized:false});}
      let checksum=null;
      if(record&&repository){await repository.write(key,record);const read=await repository.read(key);T.recover(read.payload,selections[i]);checksum=read.checksum;confirmations.set(key,checksum);}
      remember(key,{masks:newMasks,persistent:!!(record&&repository),checksum,evidence:I.clone(evidence),confirmed:true});
      if(!record||!repository)report('AVISO: identificação ou armazenamento persistente indisponível; trajeto disponível somente nesta sessão.');
    }
  }
  const migrated=new Set();
  async function migrate(selection){const k=takeKey(selection);if(!repository||k.startsWith('legacy:')||migrated.has(k))return;migrated.add(k);await T.migrateLegacy(repository,selection);}
  async function load(selection){
    await migrate(selection);const key=takeKey(selection);if(memory.has(key)){const data=memory.get(key);for(const mask of data.masks)mask.selection=I.clone(selection);return remember(key,data);}
    if(!repository||key.startsWith('legacy:'))return null;
    const entry=await repository.read(key);if(!entry)return null;
    const masks=T.recover(entry.payload,selection),data={masks,persistent:true,checksum:entry.checksum,evidence:entry.payload.evidence,confirmed:confirmations.get(key)===entry.checksum,recovered:entry.recovered};
    return remember(key,data);
  }
  async function state(selection){
    await migrate(selection);const key=takeKey(selection);if(states.has(key))return rememberState(key,states.get(key));
    const stored=repository&&!key.startsWith('legacy:')?await repository.read(key+':state'):null;
    const value=stored?.payload||{schema:1,status:'not-started'};
    if(value.schema!==1||!['not-started','running','verified','needs-review','adjusted'].includes(value.status))throw Error('Estado de aplicação incompatível.');
    if(stored?.recovered||value.status==='running')value.status='needs-review';
    return rememberState(key,value);
  }
  async function saveState(selection,value){
    const key=takeKey(selection),data={...value,schema:1,updatedAt:new Date().toISOString()};
    if(repository&&!key.startsWith('legacy:'))await repository.write(key+':state',data);
    unsavedStates.delete(key);
    return rememberState(key,data);
  }
  async function confirm(selection){const d=await load(selection);if(!d)throw Error('Trajeto ausente.');await verifyAnalysisSource(selection,d);d.confirmed=true;if(d.checksum)confirmations.set(takeKey(selection),d.checksum);return d;}
  async function invalidate(selection){confirmations.delete(takeKey(selection));const d=await load(selection);if(d)d.confirmed=false;}
  function invalidateAll(){confirmations.clear();for(const data of memory.values())data.confirmed=false;}
  async function apply(d,settings,uiSettings={}){
    const data=await load(d.selection);await verifyAnalysisSource(d.selection,data);let old=await state(d.selection);
    const destination=destinationOptions(d.selection,settings,old);let recoveryReceipt=null;
    // Proporção do vídeo diferente da sequência: só o destino Movimento tem a conversão validada.
    if(settings.destination!=='motion'&&(Number.isFinite(d.SW)||Number.isFinite(data&&data.SW)))throw Error('Com vídeo de proporção diferente da sequência, use o destino Movimento.');
    if(data&&!data.confirmed)throw Error('A origem pode ter mudado. Atualize a máscara ou escolha Usar trajeto salvo.');
    if(old.status==='needs-review'||old.status==='running'){
      try{
        if(engine.supportsManagedRecoveryPreflight===true){
          // Defer recovery to the engine's final strict preflight. No earlier
          // read becomes an ownership token across processing/state writes.
          recoveryReceipt=old.committedReceipt||old.preparedReceipt||old.managedReceipt;
          if(!recoveryReceipt)throw Error('Não há identificação suficiente para retomar. Preserve o efeito ou vincule-o explicitamente após a revisão.');
          if(destination.destination==='motion'&&!isMotionReceipt(recoveryReceipt))throw Error('A operação interrompida pertence a outro destino. Revise o estado antes de aplicar em Movimento.');
        }else{
          await recoverOperation(d.selection);old=await state(d.selection);report('RECUPERAÇÃO: efeito conferido automaticamente antes da aplicação.');
        }
      }
      catch(error){throw Error('Uma aplicação anterior precisa de revisão. '+error.message);}
    }
    settings={...settings,...require('./keyframe-sampling.js').fromTrajectory(d,settings.sourceTimes||d.times)};
    const processed=Q.process(d,settings.quality);
    if(settings.quality?.ignoreFirst)report('INÍCIO: primeira amostra da máscara ignorada; segunda amostra usada no primeiro quadro, sem deslocar os tempos.');
    const sourceWarnings=E.analyze(processed);
    if(sourceWarnings.total)report('ANÁLISE DA MÁSCARA: '+JSON.stringify(sourceWarnings));
    const edited=E.correct(processed,old.corrections||[]);
    const current={...old,status:'running',destination:destination.destination,managedReceipt:destination.managedReceipt,
      migrationReceipt:destination.migrationReceipt,settings:I.clone(uiSettings),signature:signature(d,settings,old.corrections),finalized:false,pendingNew:null,
      preparedReceipt:recoveryReceipt||null,sourceGeometrySpec:destination.destination==='motion'?sourceGeometrySpec(d,settings):null};
    await saveState(d.selection,current);
    const started=Date.now();
    try{
      const result=await engine.apply(edited.rows,{...settings,...destination,
        ...(recoveryReceipt&&destination.destination==='motion'?{migrationReceipt:recoveryReceipt.migration||null}:{}),
        ...(destination.destination==='motion'?{}:{effectPolicy:'managed'}),
        ...(recoveryReceipt?{managedReceipt:recoveryReceipt,recoverManaged:true}:{}),
        onPreparedReceipt:async receipt=>{current.preparedReceipt=receipt;await saveState(d.selection,current);}});
      const managementWarning=result.meta.managementWarning||result.meta.needsReview||null;
      const needsReview=!!managementWarning||(!result.meta.managedReceipt&&typeof engine.diagnose==='function');
      const next={...current,status:needsReview?'needs-review':'verified',managedReceipt:result.meta.managedReceipt||null,
        preparedReceipt:needsReview?current.preparedReceipt:null,migrationReceipt:needsReview?current.migrationReceipt:null,error:managementWarning,
        sourceGeometrySignature:result.meta.sourceGeometrySignature||null,verifiedAt:new Date().toISOString(),applyMs:Date.now()-started,
        lastRun:{timings:result.meta.timings||{},keyframes:result.meta.keyframeMetrics||null},maskKey:d.maskKey||d.maskId||d.name,chosenMaskKey:d.maskKey||d.maskId||d.name};
      try{await saveState(d.selection,next);}catch(error){rememberState(takeKey(d.selection),{...next,status:'needs-review'},true);report('AVISO: aplicado no Premiere, mas o estado não pôde ser preservado: '+error.message);result.meta.managementWarning=error.message;}
      if(managementWarning&&!result.meta.managementWarning)result.meta.managementWarning=managementWarning;
      return result;
    }catch(error){if(recoveryReceipt)error.message='Uma aplicação anterior precisa de revisão. '+error.message;const untouched=error.anchor?.mutationAttempted===false;await saveState(d.selection,{...(untouched?old:current),status:untouched?old.status:'needs-review',error:error.message,preparedReceipt:error.anchor?.preparedReceipt||current.preparedReceipt||null,committedReceipt:error.anchor?.committedReceipt||null}).catch(()=>{});throw error;}
  }
  async function recoverOperation(selection){
    const old=await state(selection);
    if(!['needs-review','running'].includes(old.status))return {changed:false,message:'Nenhuma operação interrompida neste take.'};
    const receipt=old.preparedReceipt||old.managedReceipt;
    if(!receipt||!engine.verifyManaged)throw Error('Não há identificação suficiente para retomar. Preserve o efeito ou vincule-o explicitamente após a revisão.');
    let accepted=receipt;
    try{await engine.verifyManaged(selection,receipt);}
    catch(error){
      // Operação cortada depois da gravação: o efeito já tem os valores novos, então só o recibo posterior casa.
      if(error.code==='ANCHOR_EFFECT_EDITED'&&old.committedReceipt){await engine.verifyManaged(selection,old.committedReceipt);accepted=old.committedReceipt;}
      else{if(error.code==='ANCHOR_EFFECT_EDITED')error.message+=' Se a gravação foi interrompida, use Desfazer no Premiere uma vez e tente Recuperar de novo.';throw error;}
    }
    await saveState(selection,{...old,status:'adjusted',committedReceipt:null,...(isMotionReceipt(accepted)?{managedReceipt:accepted,destination:'motion'}:{managedReceipt:accepted,destination:'transform'}),error:null,signature:null});
    return {changed:true,message:'Efeito conferido sem gravação no Premiere. A próxima aplicação pode ser retomada.'};
  }
  async function finalize(selection){
    const data=await load(selection),applied=await state(selection);
    if(!data?.persistent)throw Error('Preserve o trajeto em disco antes de finalizar.');
    if(!data.confirmed)throw Error('Confirme o trajeto salvo ou atualize a leitura antes de finalizar.');
    const read=await repository.read(T.key(selection));T.recover(read.payload,selection);
    if(read.recovered)throw Error('O trajeto foi recuperado de uma gravação anterior. Atualize ou exporte antes de finalizar.');
    if(applied.status!=='verified'||!applied.managedReceipt)throw Error('A aplicação precisa estar verificada antes da finalização.');
    if(!engine.verifyManaged)throw Error('A integração não permite conferir o efeito para finalizar.');
    if(isMotionReceipt(applied.managedReceipt)){
      const spec=applied.sourceGeometrySpec;
      if(!applied.sourceGeometrySignature||!spec||!engine.readSourceGeometrySignature)
        throw Error('Não há dados suficientes para conferir a geometria de Movimento. Reaplique o rastreamento antes de finalizar.');
      const currentGeometry=await engine.readSourceGeometrySignature({...spec,sourceSelection:selection,managedReceipt:applied.managedReceipt});
      if(!currentGeometry||currentGeometry!==applied.sourceGeometrySignature)
        throw Error('A geometria de Movimento ou a pilha de efeitos mudou desde a aplicação. Reaplique o rastreamento antes de finalizar.');
    }
    // Geometry reads are not an atomic host snapshot; receipt ownership is the
    // last check before finalizing so edits during those reads cannot authorize it.
    await engine.verifyManaged(selection,applied.managedReceipt);
    // No individual mask deletion API with proven reference ownership is
    // available in the documented host surface. Never edit PRPROJ/PRMF.
    await saveState(selection,{...applied,finalized:true});
    return {removed:false,reason:'Trajeto preservado e aplicação registrada. A remoção automática desta máscara não tem suporte seguro confirmado; remova-a manualmente apenas após revisar suas outras utilizações.'};
  }
  async function exportTake(selection){
    if(!repository)throw Error('Armazenamento indisponível.');
    const stored=await repository.read(T.key(selection));if(!stored)throw Error('Trajeto não encontrado.');T.recover(stored.payload,selection);
    const s=await state(selection),payload={trajectory:stored.payload,settings:s.settings||{},maskKey:s.maskKey||null,corrections:s.corrections||[]};
    return JSON.stringify({format:'anchor-transfer',version:1,checksum:I.digest(payload),payload});
  }
  async function importTake(text,selection){
    const pkg=JSON.parse(text);
    if(pkg.format!=='anchor-transfer'||pkg.version!==1||pkg.checksum!==I.digest(pkg.payload))throw Error('Pacote de trajetos inválido ou incompatível.');
    const old=pkg.payload.trajectory,id=T.identity(selection);
    // Import is an explicit action. Only the project location may differ;
    // matching a filename alone never authorizes rebinding.
    const previous={...old.identity,projectPath:id.projectPath};
    if(I.canonical(previous)!==I.canonical(id))throw Error('A mídia, sequência ou corte não corresponde ao pacote.');
    T.recover(old,old.selection);
    const masks=T.recover({...old,identity:id,masks:old.masks.map(m=>({...m,selection}))},selection);
    if(pkg.payload.settings&&Object.keys(pkg.payload.settings).length)E.validateSettings(pkg.payload.settings);
    for(const mask of masks)E.correct(mask,pkg.payload.corrections||[]);
    await capture([masks],[selection],{imported:true});
    await saveState(selection,{schema:1,status:'not-started',settings:pkg.payload.settings,maskKey:pkg.payload.maskKey||null,corrections:pkg.payload.corrections||[]});
    return load(selection);
  }
  const signature=(d,s,corrections=[])=>I.digest({...((s.destination==='motion'?engine.motionPointKeyframeStrategy:engine.transformPointKeyframeStrategy)?{spatialInterpolation:s.destination==='motion'?engine.motionPointKeyframeStrategy:engine.transformPointKeyframeStrategy}:{}),keyframeLayout:require('./head-reference.js').isSampled(d.trackingReference)?'analyzed-frames-v1':'per-frame-v1',...(require('./head-reference.js').isSampled(d.trackingReference)?{analysisSamples:d.analysisSamples,...(s.destination==='motion'?{constantScalarLayout:'constant-scalar-endpoints-v1'}:{})}:{}),rows:d.rows,times:d.times,W:d.W,H:d.H,fps:d.fps,mask:d.maskKey||d.maskId||d.name,settings:s,corrections,
    ...(R.isVideo15(d.trackingReference)?{trackingReference:d.trackingReference,referenceCoverage:d.referenceCoverage}:{})});
  async function shouldSkip(d,s){
    const requested=s.destination||'transform';
    if(!s.replace||s.createNew||!engine.verifyManaged)return false;
    s={...s,...require('./keyframe-sampling.js').fromTrajectory(d,s.sourceTimes||d.times)};
    const data=await load(d.selection),previous=await state(d.selection);
    if(!data?.confirmed||previous.status!=='verified'||previous.signature!==signature(d,s,previous.corrections)||!previous.managedReceipt)return false;
    if(requested==='motion'?!isMotionReceipt(previous.managedReceipt):isMotionReceipt(previous.managedReceipt))return false;
    if(typeof engine.readSourceGeometrySignature==='function'){
      if(!previous.sourceGeometrySignature)return false;
      try{
        const current=await engine.readSourceGeometrySignature({...s,sourceSelection:d.selection,sourceTimes:s.sourceTimes||d.times,managedReceipt:previous.managedReceipt});
        if(!current||current!==previous.sourceGeometrySignature)return false;
      }catch(_){return false;}
    }
    // Geometry reads are not an atomic host snapshot. Verify receipt ownership
    // last so an edit during those reads cannot authorize reuse.
    try{await engine.verifyManaged(d.selection,previous.managedReceipt);}catch(error){if(['ANCHOR_EFFECT_MISSING','ANCHOR_EFFECT_EDITED','ANCHOR_MOTION_EDITED'].includes(error.code))return false;throw error;}
    return true;
  }
  async function correction(d,layer){const old=await state(d.selection),layers=layer==='undo'?(old.corrections||[]).slice(0,-1):layer?(old.corrections||[]).concat([layer]):[];E.correct(d,layers);await saveState(d.selection,{...old,status:old.status==='verified'?'adjusted':old.status,corrections:layers,finalized:false});}
  async function preview(d,s){const old=await state(d.selection),edited=E.correct(Q.process(d,s.quality),old.corrections||[]);if(!engine.preview)throw Error('Prévia indisponível nesta integração.');const options=destinationOptions(d.selection,s,old);return engine.preview(edited.rows,{...s,...options,...(s.destination==='motion'?{}:{effectPolicy:'managed'})});}
  async function prepareFraming(d,s){
    const old=await state(d.selection),processed=E.correct(Q.process(d,s.quality),old.corrections||[]);
    if(typeof engine.readFramingGeometry!=='function')throw Error('A integração não permite conferir a geometria real do enquadramento.');
    const options=destinationOptions(d.selection,s,old);
    const geometry=await engine.readFramingGeometry(processed.rows,{...s,...options,...(s.destination==='motion'?{}:{effectPolicy:'managed'})});
    return {data:d,spec:s,processed,geometry};
  }
  async function diagnostic(selection,{verifyEffect=false}={}){
    const d=await load(selection),s=await state(selection),stored=d?.persistent?await repository.read(T.key(selection)):null;
    let managedVerified=null,managementWarning=null;
    if(verifyEffect&&s.managedReceipt&&engine.verifyManaged)try{await engine.verifyManaged(selection,s.managedReceipt);managedVerified=true;}catch(error){managedVerified=false;managementWarning=error.message;}
    return {trajectories:d?.masks.length||0,samples:d?d.masks.reduce((n,m)=>n+m.rows.length,0):0,activeTrajectoryBytes:stored?.bytes||0,persistent:!!d?.persistent,sourceConfirmedThisSession:!!d?.confirmed,status:s.status,finalized:!!s.finalized,managedReceiptAvailable:!!s.managedReceipt,managedVerified,managementWarning,lastRun:s.lastRun||null,applyMs:s.applyMs??null};
  }

  return {capture,load,state,saveState,confirm,invalidate,invalidateAll,cacheInfo,apply,shouldSkip,correction,preview,prepareFraming,diagnostic,finalize,exportTake,importTake,recoverOperation,
    cancel(){canceled=true;},resetCancel(){canceled=false;},get canceled(){return canceled;}};
}
module.exports={createWorkflow};
