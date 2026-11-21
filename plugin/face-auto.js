'use strict';
// Orquestra uma análise no serviço local e valida o resultado antes de ele
// chegar ao fluxo de aplicação. Não toca no projeto.
const T=require('./trajectory.js'),I=require('./integrity.js'),S=require('./face-service.js'),V=require('./video-reference.js');
const normalize=p=>String(p||'').replace(/^\\\\\?\\/,'').replace(/\\/g,'/').toLowerCase();
function verify(result,job,options={}){
  if(!result||result.format!=='anchor-face-track'||![1,2].includes(result.version))throw new S.ServiceError('Resposta do motor em formato incompatível.','invalid');
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  if(![job.inPoint,job.outPoint,job.fps,job.width,job.height].every(finite)||!(job.outPoint>job.inPoint))throw new S.ServiceError('Pedido sem intervalo ou formato válido; nada foi aplicado.','invalid');
  if(![result.inPoint,result.outPoint,result.fps,result.width,result.height].every(finite))throw new S.ServiceError('Resultado sem intervalo ou formato válido; nada foi aplicado.','invalid');
  if(result.requestId!==job.requestId)throw new S.ServiceError('O motor devolveu o resultado de outro pedido; nada foi aplicado.','stale');
  let same=false;try{same=I.canonical(T.identity(result.selection))===I.canonical(T.identity(job.selection));}catch(_){same=false;}
  if(!same)throw new S.ServiceError('O resultado pertence a outro take; nada foi aplicado.','stale');
  if(result.width!==job.width||result.height!==job.height||Math.abs(result.fps-job.fps)>1e-4)throw new S.ServiceError('Formato ou FPS do resultado diferente da sequência; nada foi aplicado.','invalid');
  if(Math.abs(result.inPoint-job.inPoint)>1e-6||Math.abs(result.outPoint-job.outPoint)>1e-6)throw new S.ServiceError('Intervalo do resultado diferente do take; nada foi aplicado.','invalid');
  if(job.mediaPath&&normalize(result.mediaPath)!==normalize(job.mediaPath))throw new S.ServiceError('O motor analisou outro arquivo ('+String(result.fileName||'')+'); nada foi aplicado.','invalid');
  if(!finite(result.coverage)||result.coverage<0||result.coverage>1)throw new S.ServiceError('Cobertura informada pelo motor inválida; nada foi aplicado.','invalid');
  const wantsVideo15=options&&options.referencia==='video15',hasVideo15=V.isVideo15(result.trackingReference);
  const adaptive=['adaptativo','cabeca'].includes(options?.referencia),isAdaptive=require('./adaptive-reference.js').isAdaptive(result.trackingReference);
  if(adaptive!==isAdaptive)throw new S.ServiceError('Referência adaptativa diferente da solicitada; nada foi aplicado.','invalid');
  if(adaptive){
    if((options.referencia==='cabeca')!==require('./head-reference.js').isHead(result.trackingReference))throw new S.ServiceError('A referência de cabeça difere da solicitada.','invalid');
    require('./adaptive-reference.js').validate(result.trackingReference);
    const asked=options.passo==='auto'||options.passo===undefined?1:options.passo;
    if(result.trackingReference.sampling.step!==asked||result.stats?.step!==asked)throw new S.ServiceError('Velocidade adaptativa diferente da solicitada; nada foi aplicado.','invalid');
  }
  if(wantsVideo15!==hasVideo15)throw new S.ServiceError(wantsVideo15?'O motor não devolveu a referência da cabeça pedida. Nada foi aplicado. Clique em Preparar motor para atualizá-lo e tente de novo.':'O motor devolveu uma referência diferente da solicitada; nada foi aplicado.','invalid');
  if(wantsVideo15){
    try{V.validatePackage(result,job.selection,{width:job.width,height:job.height,fps:job.fps});}
    catch(error){throw new S.ServiceError('Resultado video15 inválido: '+error.message+' Nada foi aplicado.','invalid');}
    // 0.9.46: a velocidade devolvida tem de ser a pedida; nunca troca Fast/Ultra por Normal (nem o contrário) em silêncio.
    const asked=options.passo===undefined||options.passo==='auto'?1:options.passo,got=V.hasSampling(result.trackingReference)?result.trackingReference.sampling.step:1;
    if(asked!==got)throw new S.ServiceError('O motor devolveu outra velocidade de análise (passo '+got+' em vez de '+asked+'); nada foi aplicado.','invalid');
  }
  // Held rows belong only to an explicitly reviewed recovery, never to a raw
  // detector response. Undefined source remains compatible with old v1 data.
  const sources=adaptive?['detected','interpolated','tracked']:V.hasSampling(result.trackingReference)?['detected','interpolated','sampled']:['detected','interpolated'];
  const rawRows=rows=>{for(const row of rows)if(!row||row.held!==undefined||row.trackingSegment!==undefined||(row.source!==undefined&&!sources.includes(row.source)))throw new S.ServiceError('O motor devolveu uma amostra mantida ou de origem desconhecida. Refaça a análise; nada foi aplicado.','invalid');};
  if(!Array.isArray(result.rows)||result.rows.length<2)throw new S.ServiceError('Resultado sem trajeto de rosto válido; nada foi aplicado.','invalid');
  rawRows(result.rows);
  if(adaptive)for(const row of result.rows)require('./adaptive-reference.js').validateRow(row,result.trackingReference);
  if(result.segments!==undefined&&!Array.isArray(result.segments))throw new S.ServiceError('Lista de trechos do motor inválida; nada foi aplicado.','invalid');
  let primary=0,auxiliaries=0;
  for(const segment of result.segments||[]){
    if(!segment||typeof segment.primary!=='boolean'||(segment.rows!==undefined&&!Array.isArray(segment.rows)))throw new S.ServiceError('Trecho do motor inválido; nada foi aplicado.','invalid');
    if(segment.primary)primary++;else auxiliaries++;
    if(Array.isArray(segment.rows)){rawRows(segment.rows);if(adaptive)for(const row of segment.rows)require('./adaptive-reference.js').validateRow(row,result.trackingReference);}
  }
  const count=result.stats?.segments;
  if(primary>1||(count!==undefined&&(!Number.isInteger(count)||count<1||(result.segments!==undefined&&count!==1+auxiliaries))))throw new S.ServiceError('A lista de trechos não confere com o resultado do motor; refaça a análise. Nada foi aplicado.','invalid');
  if(require('./head-reference.js').isSampled(result.trackingReference))result.analysisSamples=require('./head-reference.js').normalizeSamples(result.analysisSamples,[...result.rows,...(result.segments||[]).filter(s=>!s.primary).flatMap(s=>s.rows)].map(r=>r.time),job.selection,{fps:result.fps,mediaFps:result.mediaFps});
  return result;
}
function describe(task,job){
  if(task.state==='queued')return 'Motor de rosto: preparando…';
  if(task.state==='done')return 'Motor de rosto: análise concluída'+(task.cached?' (reaproveitada).':'.');
  if(task.state==='cancelled')return 'Motor de rosto: análise cancelada.';
  if(task.state==='error')return 'Motor de rosto: '+(task.message||'falha.');
  // O motor conta quadros da MÍDIA (frames, framesPerSecond); o take é medido na
  // sequência. Com FPS diferentes (59,94 na mídia, 29,97 na sequência) não se pode
  // misturar as duas contagens: o restante sai da própria fração analisada.
  const p=Math.max(0,Math.min(1,task.progress||0)),pct=Math.floor(100*p),qps=task.framesPerSecond||0,frames=task.frames||0;
  const left=qps>0&&p>=0.02&&p<1?Math.max(0,Math.round(frames*(1-p)/p/qps)):null;
  if(p>=.95)return 'Finalizando análise: '+pct+'%';
  return 'Analisando rosto: '+pct+'%'+(left!==null?' · cerca de '+left+' s restantes':'');
}
// O cancelamento vale em qualquer ponto: antes de iniciar, durante o pedido,
// durante a espera ou a consulta, e mesmo quando a resposta já vem pronta
// (cache). Um resultado só é devolvido se o usuário não cancelou.
async function analyze({client,job,options,onProgress=()=>{},isCancelled=()=>false,sleep=ms=>new Promise(r=>setTimeout(r,ms)),pollMs=400,stallMs=90000,now=()=>Date.now(),statusChecked=false}){
  const cancelledError=()=>new S.ServiceError('Análise cancelada. Nada foi aplicado.','cancelled');
  let task=null,ownedId=null,cancelSent=false;
  async function stopOwnedTask(){
    if(ownedId&&!cancelSent&&task&&(task.state==='queued'||task.state==='running')){
      cancelSent=true;try{await client.cancel(ownedId);}catch(_){}
      // Espera curta pela confirmação para que uma nova análise logo em
      // seguida não encontre o motor ainda ocupado. Só consulta o id recebido
      // no próprio início; uma resposta estranha nunca transfere a propriedade.
      for(let i=0;i<15;i++){try{const t=await client.task(ownedId);if(!t||t.id!==ownedId||(t.state!=='queued'&&t.state!=='running'))break;}catch(_){break;}await sleep(pollMs||200);}
    }
  }
  async function stopIfCancelled(){
    if(!isCancelled())return;
    try{await stopOwnedTask();}catch(_){}
    throw cancelledError();
  }
  try{
    // A v1 service can still serve every legacy mode, but its cache/status must
    // positively advertise the experimental runtime/model before video15.
    if(!statusChecked||options&&options.referencia==='video15')S.checkStatus(await client.status(),options&&options.referencia);
    await stopIfCancelled();
    // Instrumentação do lado do painel (só mede): espera total, consultas e a
    // última resposta, que traz o resultado inteiro (em takes longos, alguns MB).
    const started=now();let polls=0,lastFetchMs=null;
    let fetchStart=now();
    task=await client.start(job,options);
    if(!task||typeof task.id!=='string'||!task.id)throw new S.ServiceError('Resposta do motor sem identificador de análise válido; nada foi aplicado.','invalid');
    ownedId=task.id;
    lastFetchMs=now()-fetchStart;
    await stopIfCancelled();
    let lastFrames=-1,lastChange=now();
    while(task.state==='queued'||task.state==='running'){
      onProgress(task);
      await sleep(pollMs);
      await stopIfCancelled();
      fetchStart=now();
      const nextTask=await client.task(ownedId);
      if(!nextTask||nextTask.id!==ownedId)throw new S.ServiceError('O motor devolveu o estado de outra análise; nada foi aplicado.','stale');
      task=nextTask;
      lastFetchMs=now()-fetchStart;polls++;
      await stopIfCancelled();
      if(task.state==='queued'||task.state==='running'){
        // Etapas longas do pós-processamento mudam progresso/mensagem sem mudar os quadros lidos.
        const sig=[task.frames,task.progress,task.message].join('|');
        if(sig!==lastFrames){lastFrames=sig;lastChange=now();}
        else if(now()-lastChange>stallMs)throw new S.ServiceError('O motor de rosto parou de avançar. Tente novamente.','stalled');
      }
    }
    onProgress(task);
    if(task.state==='cancelled')throw cancelledError();
    if(task.state==='error')throw new S.ServiceError(task.message||'Falha no motor de rosto.','engine');
    if(task.state!=='done'||!task.result)throw new S.ServiceError('Resposta incompleta do motor de rosto.','invalid');
    const verifyStart=now();
    verify(task.result,job,options);
    task.panelTiming={waitMs:now()-started,polls,finalFetchMs:lastFetchMs,verifyMs:now()-verifyStart,rows:Array.isArray(task.result.rows)?task.result.rows.length:null};
    await stopIfCancelled();
    return task;
  }catch(error){
    // STALL e falhas de consulta também encerram a análise iniciada aqui.
    // A limpeza é limitada e nunca substitui o motivo original da falha.
    try{await stopOwnedTask();}catch(_){}
    throw error;
  }
}
module.exports={analyze,verify,describe};
