'use strict';
// Fluxo automático: selecionar o take, clicar em "Rastrear rosto e aplicar".
// O painel monta o pedido, liga/consulta o motor local, acompanha o progresso,
// valida o resultado e entrega o trajeto ao fluxo normal de aplicação
// (uma única transação no Premiere; desfazer continua funcionando).
// Cada etapa é registrada; falhas nativas do UXP (inclusive valores que não
// são Error) viram mensagens com o nome da etapa.
const S=require('./face-service.js'),A=require('./face-auto.js'),J=require('./face-job.js'),X=require('./external-track.js'),I=require('./integrity.js'),E=require('./face-errors.js'),T=require('./trajectory.js'),Q=require('./face-quality.js'),F=require('./face-composition.js');
const R=require('./face-recovery.js'),G=require('./face-gaps.js');
const SourceGuard=require('./source-guard.js');
const MAX_FACES=8;
const LAUNCHER='iniciar-motor.bat',PREPARER='preparar-motor.bat',START_WAIT_MS=25000,PREPARE_WAIT_MS=10*60*1000;
function initializeFacePanel({$,engine,workflow,repository=null,run,status,log,displayGroups,persistLog=async()=>false,applyTrajectory=null,onApplyFinished=null,onStateChanged=()=>{},framingSpec=null,setFraming=null,markUnapplied=null,framingSummary=null,updateCard=null,revealTaskFor=()=>{},client=S.createClient(),getUxp=()=>require('uxp'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),options={perfil:'equilibrado'},probeOnStart=true}){
  let disposed=false;const listeners=[];
  const listen=(target,type,handler,options)=>{target.addEventListener(type,handler,options);listeners.push([target,type,handler,options]);};
  const rawStatus=status,rawLog=log,rawDisplayGroups=displayGroups,rawPersistLog=persistLog,rawApplyTrajectory=applyTrajectory,rawOnApplyFinished=onApplyFinished,rawOnStateChanged=onStateChanged,rawSetFraming=setFraming,rawMarkUnapplied=markUnapplied,rawUpdateCard=updateCard;
  status=(...args)=>disposed?undefined:rawStatus(...args);log=(...args)=>disposed?undefined:rawLog(...args);displayGroups=(...args)=>disposed?undefined:rawDisplayGroups(...args);
  persistLog=(...args)=>disposed?Promise.resolve(false):rawPersistLog(...args);applyTrajectory=(...args)=>disposed?false:rawApplyTrajectory&&rawApplyTrajectory(...args);
  onApplyFinished=(...args)=>disposed?undefined:rawOnApplyFinished&&rawOnApplyFinished(...args);onStateChanged=(...args)=>disposed?undefined:rawOnStateChanged(...args);
  setFraming=(...args)=>disposed?undefined:rawSetFraming&&rawSetFraming(...args);markUnapplied=(...args)=>disposed?undefined:rawMarkUnapplied&&rawMarkUnapplied(...args);updateCard=(...args)=>disposed?undefined:rawUpdateCard&&rawUpdateCard(...args);
  let pendingChoice=null,chooserReturnFocus=null,issueIndex=-1,lastApplied=null,running=false,cancelled=false,engineState='unknown',readyText='Motor de rosto: verificando…',current=null,selectionKnown=false,externalBusy=false,notice=null;
  // Resumos por take: a linha de estado sempre fala do take selecionado.
  const notes=new Map(),keyOf=selection=>{try{return I.canonical(selection);}catch(_){return null;}};
  const say=text=>{if(disposed)return;$('faceState').textContent=text;try{$('faceState').setAttribute('title',String(text||''));}catch(_){}};
  const trace=text=>{if(disposed)return;try{log('MOTOR DE ROSTO › '+text);}catch(_){}};
  // Eventos importantes vão para o registro persistente mesmo sem aplicação.
  let engineStatus=null,preparing=false,prepareStop=false,orphanTaskId=null,chooserFile=null;
  // Preferência do editor: aplicar sozinho quando o rosto cobrir 100% (padrão: ligado).
  const AUTO_KEY='preferences:face-auto-apply';
  // Manual application is the only product path, including legacy preferences.
  const autoApply=()=>false;
  // Perdas do rosto: sempre tratadas (0.9.42; opção removida na 0.9.47). Falhas curtas emendadas, longas mantidas.
  // 0.9.44 (decisão do editor): toda análise nova usa a referência nova (video15, suavização incluída).
  // Sem opção nem preferência. Trajetos e recibos existentes mantêm o método com que foram medidos.
  const referenceLabel=method=>['selected-head-center-v1','selected-head-hybrid-v2','selected-head-hybrid-v3'].includes(method)?'cabeça inteira (rosto e cabelo)':method==='selected-face-center-v1'?'adaptativa (centro do rosto + acompanhamento visual)':!method||method==='caixa'?'clássica (centro da caixa)':method==='mediapipe-canthi-box-mm15-v3'?'nova (olhos + média de 15, corrigida pela caixa do rosto)':method==='video15'||['mediapipe-canthi-video-mm15-aligned-v1','mediapipe-canthi-video-mm15-aligned-v2'].includes(method)?'nova (video15: cantos dos olhos + média de 15)':method==='media5'||method==='yunet-mean5-aligned-v1'?'media5 (média dos 5 pontos do YuNet)':'desconhecida ('+method+')';
  // Única exceção: options injetadas com referencia:'caixa' (só os testes do caminho legado, que
  // reproduzem trajetos clássicos gravados antes da 0.9.44). O painel instalado não injeta isso.
  // 0.9.46: velocidade da análise (pedido do editor). Normal mede todos os quadros; Fast e Ultra Fast
  // medem 1 de cada 2 ou 3. Só é pedida a um motor que anuncie a amostragem; nunca é ignorada em silêncio.
  const SAMPLING_KEY='preferences:face-sampling';
  const SAMPLING={normal:{step:1,id:'faceSampleNormal',label:'Normal',note:'Mede todos os quadros. Mais fiel.'},
    fast:{step:2,id:'faceSampleFast',label:'Rápido',note:'Mede 1 de cada 2 quadros; os outros são reconstruídos entre medições válidas, nunca através de uma perda. Se perder uma medição, salva o trajeto para você conferir e aplicar.'},
    ultra:{step:3,id:'faceSampleUltra',label:'Ultra rápido',note:'Mede 1 de cada 3 quadros; o mais rápido. Viradas rápidas podem perder detalhe. Se perder uma medição, salva para você conferir e aplicar.'}};
  let sampling='normal',samplingTouched=false,samplingLoaded=Promise.resolve();
  // CONTRATO-0946: o motor anuncia samplingModes ('normal','fast','ultra'); sem anúncio, só Normal.
  const samplingSupported=(status,step)=>step===1||!!status&&Array.isArray(status.samplingModes)&&status.samplingModes.includes(Object.keys(SAMPLING).find(k=>SAMPLING[k].step===step));
  function showSampling(){
    for(const [name,m] of Object.entries(SAMPLING)){try{$(m.id).className=name===sampling?'selected':'';$(m.id).setAttribute('aria-pressed',String(name===sampling));}catch(_){}}
    try{$('faceSampleInfo').textContent=SAMPLING[sampling].note;}catch(_){}
  }
  const analysisOptions=()=>options.referencia==='caixa'?{...options}:{...options,referencia:'video15',analise:960,passo:SAMPLING[sampling].step,usar_proxy:false};
  function updateAutoText(){
    if(disposed)return;
    let summary='';try{summary=typeof framingSummary==='function'?framingSummary():'';}catch(_){summary='';}
    const on=autoApply();
    try{$('faceAutoFraming').textContent=on?'Aplica sozinho com: '+(summary||'o enquadramento atual')+'. Falhas curtas do rosto são emendadas e perdas longas mantêm o enquadramento; se uma retomada parecer outra pessoa, nada é aplicado.':'Só analisa; nada é aplicado. Depois, confira o enquadramento e clique em Aplicar.';}catch(_){}
    try{const title=$('btnFaceAuto').querySelector&&$('btnFaceAuto').querySelector('.file-title');if(title)title.textContent=on?'Rastrear rosto e aplicar':'Analisar rosto';}catch(_){}
  }
  const record=async text=>{trace(text);try{await persistLog();}catch(_){}};
  const sec=n=>Number(n).toFixed(1).replace('.',',');
  function setNote(selection,text,pending=false,head=null){const key=keyOf(selection);if(key)notes.set(key,{text,pending,head:head||text,name:selection.name});}
  function showCurrent(){
    if(disposed)return;
    const key=current&&keyOf(current);
    if(key&&notes.has(key))say(notes.get(key).text);
    else if(notice&&key!==notice.key)say(notice.text);
    else say(readyText);
    card();
  }
  // Estado do rosto para o cartão do take (análise, escolha, perda, falha, cabeça cortada).
  let runningKey=null,progressPct=null;const cuts=new Map();
  const card=()=>{if(!disposed&&typeof updateCard==='function')try{updateCard();}catch(_){}};
  const pctText=n=>Math.round(100*n)+'%';
  function cardState(selected,base){
    if(!Array.isArray(selected)||selected.length!==1)return null;
    const key=keyOf(selected[0]);if(!key)return null;
    if(running&&runningKey===key)return {chip:'Analisando'+(progressPct!==null?' '+progressPct+'%':'…'),tone:'run',next:'Aguarde ou cancele; nada é aplicado ao cancelar.'};
    if(pendingChoice&&pendingChoice.key===key)return {chip:pendingChoice.found.faces.length+' pessoas',tone:'info',next:'Clique na pessoa que deve ficar enquadrada. Nada é analisado nem aplicado antes da escolha.'};
    const note=notes.get(key),info=infos.get(key);
    if(note&&note.failure)return {chip:'Rosto: falha',tone:'bad',next:'Veja a mensagem junto à análise do rosto.'};
    let out=null;
    if(!(base&&base.strong)&&note&&note.pending&&note.kind==='partial')out={chip:Q.coverText(info&&info.coverage)+' · não aplicado',tone:'warn',next:'Nada foi aplicado. Confira as perdas; aplique mesmo assim, troque a pessoa ou deixe como está.'};
    else if(!(base&&base.strong)&&note&&note.pending&&note.kind==='ready')out={chip:Q.coverText(info&&info.coverage)+' · não aplicado',tone:'info',next:'Clique em Aplicar e confira no Monitor do Programa; Ctrl+Z desfaz.'};
    const cut=cuts.get(key);
    if(cut>0&&base&&base.chip!=='Sem rastreamento'){const next='Risco estimado de corte da cabeça: '+pctText(cut)+' dos quadros. Confira no Program e ajuste a folga. '+(out?out.next:base.next);out={...(out||{}),next};}
    return out;
  }
  // Escolha da pessoa e qualidade ficam guardadas por take (identidade do
  // corte), no armazenamento do plugin; sobrevivem a fechar o painel.
  const infos=new Map(),infoKey=selection=>'face-info:'+T.key(selection);
  async function loadInfo(selection){
    const key=keyOf(selection);if(!key)return null;if(infos.has(key))return infos.get(key);
    let value=null;try{if(repository)await T.migrateLegacy(repository,selection);const stored=repository&&await repository.read(infoKey(selection));value=stored&&stored.payload||null;}catch(error){trace('leitura da escolha: '+E.describe(error));}
    infos.set(key,value);return value;
  }
  // Pessoa do trajeto aplicado (para avisar quando um novo trajeto ainda não foi aplicado).
  async function rememberApplied(selection){const info=await loadInfo(selection);if(info&&info.target)await saveInfo(selection,{appliedTarget:info.target,appliedRequestId:info.requestId||null});}
  async function saveInfo(selection,patch,{strict=false}={}){
    const key=keyOf(selection),value={...(await loadInfo(selection)||{}),...patch,updatedAt:new Date().toISOString()};
    try{if(repository)await repository.write(infoKey(selection),value);}catch(error){trace('gravação da escolha: '+E.describe(error));if(strict)throw error;}
    infos.set(key,value);
    return value;
  }
  function recoveredInfo(mask,info){
    const e=mask&&mask.recoveryEvidence;
    if(e&&e.kind===G.KIND){
      const job={inPoint:mask.selection.inPoint,outPoint:mask.selection.outPoint,fps:mask.fps};
      const issues=(info&&info.issues||[]).filter(i=>!['outro trecho','sem rosto','mantido','emendado'].includes(i.kind));
      for(const g of e.gaps)issues.push({kind:e.keyframeInterpolation==='between-analyzed-instants-v1'?'intervalo sem medição':g.mode==='hold'?'mantido':'emendado',start:g.start,end:g.end});
      issues.sort((a,b)=>a.start-b.start);
      const available=Number.isFinite(e.availableCoverage)?e.availableCoverage:info?.coverageDetails?.availableCoverage??e.measuredCoverage,primary=Number.isFinite(e.primaryCoverage)?e.primaryCoverage:info?.primaryCoverage??info?.coverageDetails?.selectedCoverage??info?.coverage;
      return {...(info||{}),coverage:available,primaryCoverage:primary,measuredCoverage:e.measuredCoverage,coverageDetails:{selectedCoverage:primary,availableCoverage:available,otherSegments:[],missing:[]},qualityText:'Rastreamento disponível: '+Q.coverText(available)+' (inclui interpolações do motor). Segmento contínuo principal: '+Q.coverText(primary)+'. '+(G.summary(e)||'Perdas tratadas automaticamente.'),issues,job,recoveryPrepared:true};
    }
    if(!e||e.kind!=='reviewed-segments-hold-v1')return info;
    const job={inPoint:mask.selection.inPoint,outPoint:mask.selection.outPoint,fps:mask.fps},start=mask.times[0],end=mask.times.at(-1)+1/mask.fps;
    const heldRanges=e.heldRanges||e.missingRanges.filter(([a,b])=>a>=start-1e-6&&b<=end+1e-6);
    const outside=e.missingRanges.filter(([a,b])=>a<start-1e-6||b>end+1e-6);
    const issues=(info&&info.issues||[]).filter(i=>!['outro trecho','sem rosto','mantido'].includes(i.kind));
    for(const [a,b] of heldRanges)issues.push({kind:'mantido',start:a,end:b});
    for(const [a,b] of outside)issues.push({kind:'sem rosto',start:a,end:b});issues.sort((a,b)=>a.start-b.start);
    const qualityText='Trechos revisados: '+e.segmentCount+' · Acompanhamento disponível: '+Q.coverText(e.measuredCoverage)+' (inclui interpolações do motor) · Enquadramento mantido por '+sec(e.heldSeconds)+' s sem detecção. Pode haver salto ao reencontrar o rosto.'+(outside.length?' Há partes sem rastreamento nas pontas: confira os avisos.':'');
    return {...(info||{}),coverage:e.measuredCoverage,coverageDetails:{availableCoverage:e.measuredCoverage,otherSegments:[],missing:e.missingRanges},quality:null,qualityText,issues,job,recoveryPrepared:true,recoveryDigest:e.reviewDigest};
  }
  const personText=t=>t?'pessoa '+t.id+(t.count>1?' de '+t.count:'')+(t.chosenBy==='editor'?', escolhida pelo editor':t.count===1?', único rosto':''):'';
  // Executa uma etapa nomeada; em falha registra detalhe e lança Error legível.
  // Duração de cada etapa da última análise (instrumentação; vai para o registro).
  let stepTimes={},sourceLogged=false;
  async function step(label,fn){
    const t0=Date.now();
    try{const value=await fn();return value;}
    catch(error){
      if(error&&error.code==='cancelled')throw error;
      const detail=E.describe(error),where=E.stack(error);
      trace('falha em '+label+': '+detail+(where?' | '+where:''));
      const out=E.toError(error,'['+label+']');out.step=label;throw out;
    }
    finally{stepTimes[label]=(stepTimes[label]||0)+Date.now()-t0;}
  }
  function setButton(id,visible,enabled){const e=$(id);e.className='file-button compact-action'+(visible?'':' hidden');e.disabled=!enabled;e.setAttribute('aria-disabled',String(!enabled));}
  function sync(busy){
    if(disposed)return;
    externalBusy=!!busy;renderAvailability();
  }
  // Only the owner of the outer operation may release its lock. Status probes
  // and selection refreshes merely render the combined current state.
  function renderAvailability(){
    if(disposed)return;
    const busy=externalBusy||running,noSelection=!current;$('btnFaceAuto').disabled=busy||noSelection;$('btnFaceAuto').setAttribute('aria-disabled',String(busy||noSelection));
    setButton('btnFaceCancel',running||preparing||!!orphanTaskId,(running&&!cancelled)||(!running&&(preparing||!!orphanTaskId)));{const c=$('btnFaceCancel');if(c)c.textContent=running?'Cancelar análise':preparing?'Parar de esperar':orphanTaskId?'Cancelar análise anterior':'Cancelar análise';}
    setButton('btnFaceStart',!running&&['offline','outdated','incompatible','error'].includes(engineState),!busy);
    setButton('btnFacePrepare',!running&&['offline','outdated','incompatible','error'].includes(engineState),!busy&&!preparing);
    setButton('btnFaceDiagnose',!running&&engineState==='ready',!busy);
    // "Trocar pessoa" só existe depois que este take já tem uma pessoa escolhida.
    const info=current&&infos.get(keyOf(current));
    setButton('btnFacePick',!running&&!!(info&&info.target),!busy);
    for(const id of ['btnFaceCompose','btnFaceComposeFill','btnFaceNextIssue','btnFaceChooserCancel']){const e=$(id);e.disabled=!!busy;e.setAttribute('aria-disabled',String(!!busy));}
    // B04: modo que o motor não anuncia fica indisponível (motor desligado: nada é decidido ainda).
    for(const m of Object.values(SAMPLING)){const e=$(m.id),off=!!busy||!!(engineStatus&&engineState==='ready'&&!samplingSupported(engineStatus,m.step));e.disabled=off;e.setAttribute('aria-disabled',String(off));}
    for(let i=1;i<=MAX_FACES;i++){const b=$('faceChoice'+i),face=pendingChoice&&pendingChoice.found.faces[i-1];b.disabled=!!busy||!face;b.setAttribute('aria-disabled',String(b.disabled));}
  }
  async function probe(){
    if(disposed)return null;
    try{const raw=await client.status();if(disposed)return null;const st=markReady(S.checkStatus(raw));showCurrent();return st;}
    catch(error){engineState=error&&['outdated','incompatible','permission'].includes(error.code)?error.code:'offline';
      if(disposed)return null;
      trace('consulta inicial: '+E.describe(error));
      readyText=engineState==='offline'?'Motor de rosto desligado. Clique em Analisar rosto para ligá-lo automaticamente (o Windows pode pedir confirmação na primeira vez). Se o motor não ligar, use Preparar motor.':E.describe(error);showCurrent();return null;}
    finally{if(!disposed)renderAvailability();}
  }
  // Abre um .bat da pasta motor-rosto pelo shell do UXP (o Windows pede confirmação na primeira vez).
  async function openTool(name,why){
    if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
    const uxp=await step('módulo uxp',()=>getUxp());
    if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
    const folder=await step('pasta do plugin',()=>uxp.storage.localFileSystem.getPluginFolder());
    if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
    const root=String(folder&&folder.nativePath||'').replace(/[\\/]+$/,'');
    if(!root)throw Error('[pasta do plugin] O Premiere não informou o caminho da pasta do plugin ('+E.describe(folder)+').');
    const sep=root.includes('\\')?'\\':'/',path=root+sep+'motor-rosto'+sep+name;
    trace('abrindo '+path);
    const answer=await step('abrir '+name,()=>uxp.shell.openPath(path,why));
    if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
    trace('resposta do openPath: '+(answer===''||answer===undefined?'ok':E.describe(answer)));
    if(answer)throw Error('[abrir '+name+'] O Premiere/Windows recusou: '+E.describe(answer)+'. Abra manualmente: '+path);
    return path;
  }
  async function launch(){
    if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
    say('Ligando o motor de rosto…');
    await openTool(LAUNCHER,'Liga o motor de rosto local do Dynamic Anchor. Ele só lê os vídeos do take selecionado.');
    if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
    const until=Date.now()+START_WAIT_MS;let last=null;
    while(!disposed&&Date.now()<until){await sleep(700);if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');if(cancelled)throw new S.ServiceError('Análise cancelada.','cancelled');try{const raw=await client.status();if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');const st=S.checkStatus(raw);engineState='ready';trace('motor respondeu '+st.version);return st;}catch(error){last=error;if(disposed||error&&['outdated','incompatible','permission'].includes(error.code))throw error;}}
    trace('motor não respondeu: '+E.describe(last));throw Error('[aguardar motor] O motor de rosto não respondeu em '+Math.round(START_WAIT_MS/1000)+' s. Clique em Preparar motor: ele confere a instalação, corrige o que faltar e mostra cada passo.');
  }
  // Motor respondeu com versão compatível: o estado e o texto de "pronto" passam a valer.
  function markReady(st,how=''){engineState='ready';engineStatus=st;readyText='Motor de rosto '+st.version;clearFailures();return st;}
  // Versão antiga em execução: pede para encerrar e espera a porta parar de responder
  // com a versão antiga. Repete, porque no Windows pode haver mais de uma cópia antiga
  // escutando a mesma porta (motores anteriores à 0.3.1 não tinham bind exclusivo).
  async function replaceOutdated(){
    for(let attempt=1;attempt<=5;attempt++){
      if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
      try{await client.shutdown();}catch(_){}
      if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
      await sleep(1200);
      if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
      try{const raw=await client.status();if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');S.checkStatus(raw);trace('versão compatível já responde após '+attempt+' pedido(s) de encerramento');return true;}
      catch(error){if(disposed)throw error;if(!error||error.code!=='outdated'){trace('versão antiga encerrada ('+attempt+' pedido(s))');return false;}trace('versão antiga ainda responde; novo pedido de encerramento ('+attempt+')');}
    }
    throw Error('[trocar versão do motor] Uma versão antiga do motor continua respondendo depois de 5 pedidos de encerramento. Rode motor-rosto\\parar-motor.bat (ou Preparar motor) e tente de novo.');
  }
  function analysisFormat(sequenceFormat,media){
    const m=media&&media.format,pa=n=>Number.isFinite(n)&&n>0?n:1;
    if(!m||!Number.isFinite(m.width)||!Number.isFinite(m.height)||Math.abs(pa(m.pixelAspect)-pa(sequenceFormat.pixelAspect))>1e-9)return sequenceFormat;
    const canvas=require('./motion-geometry.js').sourceCanvas(m,sequenceFormat.width,sequenceFormat.height);
    return canvas.sameAspect?sequenceFormat:{...sequenceFormat,sourceWidth:canvas.width,sourceHeight:canvas.height};
  }
  async function ensureEngine(){
    if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
    try{const raw=await client.status();if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');const st=S.checkStatus(raw);trace('conexão ok '+st.version);return markReady(st);}
    catch(error){
      if(disposed)throw error;
      trace('conexão com o motor: '+E.describe(error));
      if(error&&error.code==='outdated'){trace('versão antiga em execução; trocando');const replaced=await replaceOutdated();if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');if(replaced){const raw=await client.status();if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');return markReady(S.checkStatus(raw));}return markReady(await launch());}
      // No Premiere, uma porta fechada nem sempre volta como "recusada": o pedido fica parado até o
      // tempo acabar. Sem resposta, liga o motor e espera; se um motor já estiver rodando (ocupado),
      // a segunda cópia não consegue abrir a porta e sai, e a espera termina quando ele responder.
      if(error&&(error.code==='offline'||error.code==='timeout'))return markReady(await launch());
      // Permissão de rede, outro programa na porta etc.: abrir o .bat não ajuda.
      throw E.toError(error,'[conexão com o motor]');
    }
  }
  function fail(error){
    if(disposed)return;
    if(error&&error.code==='busy'){
      // 409: o motor ainda roda uma análise que este painel não controla (painel recarregado no meio dela).
      // Descobre o id em /v1/status e oferece cancelar, em vez de deixar o painel sem saída.
      client.status().then(raw=>{const id=raw&&raw.task&&typeof raw.task.id==='string'?raw.task.id:null;if(!disposed&&id){orphanTaskId=id;renderAvailability();}}).catch(()=>{});
    }
    if(error&&error.code==='offline')engineState='offline';
    else if(error&&error.code==='permission')engineState='permission';
    else if(error&&error.step&&/plugin|abrir|aguardar|uxp/.test(error.step))engineState='error';
    else if(error&&/^\[(pasta do plugin|abrir|aguardar)/.test(String(error.message||'')))engineState='error';
    const text=(current&&current.name?'Rosto de '+current.name+': ':'Motor de rosto: ')+E.plain(error);
    trace('falha: '+E.describe(error));
    if(current){setNote(current,text);const n=notes.get(keyOf(current));if(n)n.failure=true;}say(text);
  }
  // Motor pronto de novo: as falhas de motor guardadas por take deixam de valer.
  function clearFailures(){for(const [key,note] of [...notes])if(note.failure)notes.delete(key);}
  async function prepare(){
    if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');
    stepTimes={};sourceLogged=false;
    const selection=await step('seleção',async()=>I.clone(await engine.selection()));current=selection;notice=null;
    // Inicia pelo clique em Analisar, antes das leituras demoradas do Premiere.
    await step('identificação do trecho',()=>T.identity(selection));
      const st=await ensureEngine();if(disposed)throw new S.ServiceError('Painel fechado.','cancelled');engineState='ready';
    const sequenceFormat=await step('formato da sequência',()=>engine.sequenceFormat(selection));
    const media=await step('arquivo do clipe',()=>engine.mediaSource(selection));
    if(!media||!media.mediaPath)throw Error('[arquivo do clipe] O Premiere não informou o arquivo deste clipe. Use um clipe de vídeo comum (não sequência aninhada nem gráfico).');
    if(I.canonical(await engine.selection())!==I.canonical(selection))throw Error('[seleção] O trecho selecionado mudou durante a leitura. Selecione o take e analise de novo. Nada foi analisado.');
    // Proporção da mídia diferente da sequência (ex.: 16:9 numa sequência vertical): o motor analisa no
    // quadro do vídeo (mesma proporção da mídia) e o enquadramento converte para a sequência.
    const format=analysisFormat(sequenceFormat,media);
    const job=await step('pedido',()=>JSON.parse(J.build({selection,format:{...format,width:format.sourceWidth||format.width,height:format.sourceHeight||format.height},media})));
    trace('etapas ok: seleção '+selection.name+', formato '+format.width+'x'+format.height+(format.sourceWidth?' (vídeo '+media.format.width+'x'+media.format.height+')':'')+' '+Number(format.fps).toFixed(3)+' fps, mídia, pedido '+job.requestId);
    trace(st.version+' · '+selection.name+' '+job.inPoint.toFixed(3)+'–'+job.outPoint.toFixed(3)+' s');
    return {selection,format,media,job,version:st.version,status:st};
  }
  // Primeiro quadro do take com rostos, numerados da esquerda para a direita.
  async function findFaces({selection,job}){
    // A escolha inicial usa somente as caixas do detector, mesmo no modo novo.
    let found=await step('rostos do início do take',()=>client.faces(job,{...options,referencia:'caixa'}));
    // Rosto que só aparece depois dos primeiros 4 s: procura no resto do take antes de desistir.
    if(found&&Array.isArray(found.faces)&&!found.faces.length&&Number.isFinite(job.inPoint)&&Number.isFinite(job.outPoint)&&job.outPoint-job.inPoint>4.5){
      say('Nenhum rosto nos primeiros 4 s. Procurando no resto do take…');
      const later=await step('rostos no resto do take',()=>client.faces({...job,searchFrom:job.inPoint+4,searchSeconds:Math.min(600,job.outPoint-job.inPoint-4)},{...options,referencia:'caixa'}));
      if(later&&Array.isArray(later.faces)&&later.faces.length)found=later;
    }
    if(!found||found.requestId!==job.requestId||I.canonical(T.identity(found.selection||{}))!==I.canonical(T.identity(selection)))throw Error('[rostos do início do take] Resposta de outro pedido; nada foi alterado.');
    const faces=(found.faces||[]).slice(0,MAX_FACES);
    if(!faces.length)throw Error('[rostos do início do take] Nenhum rosto encontrado em '+selection.name+'. Escolha um take em que alguém apareça de frente para a câmera.');
    trace('rostos no início de '+selection.name+': '+faces.length+' em '+Number(found.time).toFixed(3)+' s');
    return {...found,faces};
  }
  // O primeiro quadro do take não tem rosto: a referência nova precisa dele no primeiro quadro.
  // Nunca troca o instante sozinho; o editor decide o novo início no Premiere.
  const lateText=(selection,offset)=>'O primeiro quadro de '+selection.name+' não tem rosto'+(Number.isFinite(offset)?'; o primeiro rosto aparece '+sec(offset)+' s depois do início (imagem abaixo)':'')+'. A referência nova acompanha a pessoa a partir do primeiro quadro: no Premiere, ajuste o início do take para quando o rosto já aparece e analise de novo. Nada foi analisado.';
  function targetFrom(face,found,chosenBy){return {id:face.id,count:found.faces.length,x:face.x,y:face.y,nx:face.nx,ny:face.ny,width:face.width,height:face.height,time:found.time,chosenBy,at:new Date().toISOString()};}
  // ---- escolha da pessoa ----
  async function showChooser(selection,found,late=null,allowLate=false){
    const choice={key:keyOf(selection),selection,found:late===null||allowLate?found:{...found,faces:[]}};pendingChoice=choice;
    chooserReturnFocus=$('faceChooser').ownerDocument?.activeElement||null;
    $('faceChooserInfo').textContent=late!==null?(allowLate?'O rosto aparece '+sec(late)+' s depois do início. Confirme quem seguir pelo número. O início do take será preservado, sem medição antes desse rosto aparecer.':lateText(selection,late)):'Selecione um rosto.';
    for(let i=1;i<=MAX_FACES;i++){const b=$('faceChoice'+i),face=choice.found.faces[i-1];b.className='file-button compact-action face-choice'+(face?'':' hidden');b.disabled=!face;b.setAttribute('aria-disabled',String(!face));b.textContent=face?String(face.id):'';b.setAttribute('aria-label',face?'Pessoa '+face.id+'; posição '+i+' de '+found.faces.length+', da esquerda para a direita':'Pessoa indisponível');}
    $('faceChooserImage').setAttribute('alt','Rostos numerados da esquerda para a direita. Escolha a pessoa pelos botões abaixo.');
    await showImage(found.image);
    if(pendingChoice!==choice||keyOf(current)!==choice.key)return;
    revealTaskFor('faceChooser');
    $('faceChooser').className='face-chooser';
    if(found.image&&Number.isFinite(found.image.width)&&found.image.width>0&&Number.isFinite(found.image.height)&&found.image.height>0){const area=$('faceChooserArea');area.style.height=Math.round((area.clientWidth||300)*found.image.height/found.image.width)+'px';}
    if((late===null||allowLate)&&typeof $('faceChoice1').focus==='function')$('faceChoice1').focus();
  }
  function hideChooser(restoreFocus=false){pendingChoice=null;if(disposed)return;$('faceChooser').className='face-chooser hidden';const previous=chooserReturnFocus;chooserReturnFocus=null;if(restoreFocus&&previous&&typeof previous.focus==='function'&&!previous.disabled)previous.focus();}
  async function showImage(image){
    const img=$('faceChooserImage');img.setAttribute('src','');
    if(!image||!image.base64)return;
    const area=$('faceChooserArea'),width=area.clientWidth||300;area.setAttribute('data-image-ratio',String(image.width/image.height));area.style.height=Math.round(width*image.height/image.width)+'px';
    try{
      // Mesmo caminho da prévia de região: arquivo temporário + URL do sistema de arquivos.
      const fs=getUxp().storage.localFileSystem,folder=await fs.getTemporaryFolder(),previous=chooserFile,file=await folder.createFile('anchor-escolha-rosto-'+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36)+'.jpg',{overwrite:true});chooserFile=file;if(previous&&typeof previous.delete==='function')previous.delete().catch(()=>{});
      await file.write(Q.base64Bytes(image.base64).buffer,{format:getUxp().storage.formats.binary});
      img.setAttribute('src',fs.getFsUrl(file));
    }catch(error){trace('imagem da escolha por arquivo indisponível ('+E.describe(error)+'); usando data URI');img.setAttribute('src','data:image/jpeg;base64,'+image.base64);}
  }
  async function choose(index){
    if(!pendingChoice)return;
    const {selection,found}=pendingChoice,face=found.faces[index];if(!face)return;
    if(keyOf(current)!==pendingChoice.key){hideChooser();status('A seleção mudou; escolha a pessoa de novo.',true);return;}
    await saveInfo(selection,{target:targetFrom(face,found,'editor')});hideChooser(true);
    await record('pessoa '+face.id+' de '+found.faces.length+' escolhida pelo editor em '+selection.name);
    await startFlow();
  }
  async function analyzeAndCapture(forceChoose=false){
    if(disposed)return false;
    let hadApplied=false,storedSelection=null;
    running=true;cancelled=false;orphanTaskId=null;say('Preparando a análise do trecho…');renderAvailability();
    const stopIfCancelled=()=>{if(cancelled)throw new S.ServiceError('Análise cancelada. Nada foi aplicado.','cancelled');};
    try{
      // Opções capturadas uma vez: preparo, pedido e registro usam a mesma referência.
      // A preferência gravada termina de carregar antes; o pedido é capturado uma única vez.
      await samplingLoaded;const requested=analysisOptions();
      const ctx=await prepare(),{selection,format,job}=ctx;
      // B19: take que já tem análise guardada = pedido explícito de reanalisar; o motor não reaproveita o cache.
      if(ctx.status.features?.includes('ignorar-cache-v1')&&await loadInfo(selection))requested.ignorar_cache=true;
      if(options.referencia!=='caixa'&&ctx.status.features?.includes('whole-head-v1'))requested.referencia='cabeca';
      else if(options.referencia!=='caixa'&&ctx.status.features?.includes('adaptive-center-v1'))requested.referencia='adaptativo';
      if(requested.passo>1&&!samplingSupported(ctx.status,requested.passo)){
        const mode=Object.values(SAMPLING).find(m=>m.step===requested.passo);
        throw new S.ServiceError('[velocidade] Este motor ainda não faz '+mode.label+'. Use Normal ou atualize o motor. Nada foi analisado.','unsupported-sampling');
      }
      // Motor 0.3.2+: o alvo só é assumido a partir do instante em que a pessoa foi escolhida.
      // A referência nova exige alinhamento no quadro inicial; não pode começar
      // mais tarde no instante em que a escolha de rosto encontrou uma pessoa.
      const timed=S.compareVersion(ctx.version,'0.3.2')>=0&&requested.referencia!=='video15';
      let info=await loadInfo(selection),target=info&&info.target;
      // 0.9.45 (pedido do editor): a pessoa é sempre confirmada no primeiro quadro, mesmo sozinha,
      // antes de analisar o take. Só reaproveita um alvo que o editor já confirmou neste take.
      if(!target||target.chosenBy!=='editor'||forceChoose){
        const found=await findFaces(ctx);stopIfCancelled();
        const offset=Number(found.time)-job.inPoint,late=!Number.isFinite(offset)||offset>0.5/format.fps+1e-6;
        const allowLate=late&&timed&&Number.isFinite(offset)&&offset>=0&&found.time<job.outPoint;
        await showChooser(selection,found,late?offset:null,allowLate);
        const text=late?(allowLate?'O rosto aparece '+sec(offset)+' s depois do início. Confirme quem seguir; o take inteiro será preservado.':lateText(selection,offset)):'';
        say(late?text:'');status(text,late&&!allowLate);if(late)await record('primeiro quadro sem rosto em '+selection.name+'; primeiro rosto em +'+(Number.isFinite(offset)?offset.toFixed(3):'?')+' s; '+(allowLate?'aguardando escolha explícita; início preservado':'nada analisado'));
        return 'choose';
      }
      runningKey=keyOf(selection);progressPct=0;status('Analisando o rosto de '+selection.name+'… (progresso no cartão do take)');card();
      const task=await step('análise',()=>A.analyze({client,job,options:{...requested,alvo:[target.x,target.y],...(timed&&Number.isFinite(target.time)&&target.time>=job.inPoint&&target.time<job.outPoint?{alvo_tempo:target.time}:{})},sleep,statusChecked:true,isCancelled:()=>cancelled||disposed,onProgress:t=>{if(t.source&&!sourceLogged){sourceLogged=true;trace('fonte da análise: '+JSON.stringify(t.source));}say(A.describe(t,job));if(t.state==='running'){progressPct=Math.floor(100*Math.max(0,Math.min(1,t.progress||0)));card();}}}));
      stopIfCancelled();
      await record('referência usada na análise de '+selection.name+': '+referenceLabel(task.result&&task.result.trackingReference&&task.result.trackingReference.method)+' · pedida: '+(requested.referencia==='cabeca'?'cabeça inteira':requested.referencia==='adaptativo'?'adaptativa':referenceLabel(requested.referencia))+' · velocidade: '+(Object.values(SAMPLING).find(m=>m.step===requested.passo)||{label:'passo '+requested.passo}).label);
      const result=task.result,mask=await step('validação do trajeto',()=>X.decode(JSON.stringify(result),selection,format,{confirmed:true}));
      // 0.9.42: perdas tratadas automaticamente (falhas curtas emendadas, longas mantidas
      // com transição). Se não for possível, segue o caminho anterior (trecho principal).
      let filled=null,fillFailure=null;
      if(G.needed(result,mask)){
        try{filled=await step('tratamento automático das perdas',()=>G.autoFill(result,selection,format));}
        catch(error){fillFailure=E.describe(error);trace('tratamento automático das perdas indisponível: '+fillFailure);filled=null;}
      }
      const used=filled||mask;
      stopIfCancelled();
      await step('preservação do trajeto',async()=>{
        await workflow.capture([[used]],[selection],{externalPrototype:true,faceEngine:true,requestId:job.requestId,sourceStamp:await SourceGuard.stampFor(job,getUxp),...(filled?{autoGaps:G.summary(filled.recoveryEvidence)}:{})});
        const old=await workflow.state(selection);
        hadApplied=!!old.managedReceipt&&['verified','adjusted'].includes(old.status);
        // Guardado no estado do take: depois de recarregar, o painel ainda sabe que o
        // trajeto novo não foi aplicado (os keyframes em Movimento são da aplicação anterior).
        const saved=await workflow.saveState(selection,{...old,status:old.status==='verified'?'adjusted':old.status,corrections:[],maskKey:null,finalized:false,pendingNew:hadApplied?{at:new Date().toISOString(),requestId:job.requestId}:(old.pendingNew||null)});
        onStateChanged(selection,saved);
      });
      storedSelection=selection;
      // Novo trajeto sobre um take já aplicado: o Program continua mostrando a aplicação anterior.
      if(hadApplied&&typeof markUnapplied==='function')markUnapplied(selection);
      const details=Q.coverageDetails(result,job),issues=Q.issues(result,job,details),qualityText=Q.summary(result,job,details),previous=(await loadInfo(selection)||{}).appliedTarget||null;
      await saveInfo(selection,{target,requestId:job.requestId,quality:result.quality||null,coverage:filled?filled.recoveryEvidence.availableCoverage:details.selectedCoverage,primaryCoverage:filled?filled.recoveryEvidence.primaryCoverage:details.selectedCoverage,coverageDetails:details,issues,qualityText,recoveryPrepared:false,job:{inPoint:job.inPoint,outPoint:job.outPoint,fps:job.fps}});
      issueIndex=-1;
      const coverage=Q.coverText(details.selectedCoverage);
      trace(JSON.stringify({requestId:job.requestId,clip:selection.name,target:{id:target.id,count:target.count,chosenBy:target.chosenBy},cached:task.cached,panelTiming:task.panelTiming||null,stepMs:{...stepTimes},coverage:result.coverage,stats:result.stats,quality:result.quality&&{mean:result.quality.meanConfidence,min:result.quality.minConfidence,low:(result.quality.lowConfidence||[]).length,ambiguous:(result.quality.ambiguousTimes||[]).length},warnings:result.warnings}));
      const complete=filled?!filled.recoveryEvidence.suspect:Q.canAutoApply(result,job,mask,details);
      const gapText=filled?G.summary(filled.recoveryEvidence):'';
      const lost=details.missing.map(([a,b])=>Q.rangeText(a-job.inPoint,b-job.inPoint,job)).join(' e ');
      // v2: o que foi medido e o que foi reconstruído entre medições aparecem separados.
      const rc=result.referenceCoverage,reconstructed=rc&&Array.isArray(rc.interpolatedFrames)&&rc.interpolatedFrames.length?(filled?'':' · medido em '+Q.coverText(rc.measuredFrames/rc.expectedFrames)+' dos quadros')+' · reconstruído em '+Q.coverText(rc.interpolatedFrames.length/rc.expectedFrames)+' ('+(Object.values(SAMPLING).find(m=>m.step===requested.passo)||{label:''}).label+')':'';
      const detailedHead=(filled?'Rosto de '+selection.name+': trajeto cobre o take inteiro (rosto medido em '+Q.coverText(filled.recoveryEvidence.measuredCoverage)+' dos quadros)'+(gapText?' · '+gapText:'')+' · '+personText(target)+(task.cached?' · análise reaproveitada':''):'Rosto de '+selection.name+': acompanhado em '+coverage+' do take no trajeto selecionado'+(details.otherSegments.length?' · o motor encontrou '+Q.coverText(details.availableCoverage)+' somando trechos separados; os outros trechos estão fora da aplicação':'')+' · '+personText(target)+(task.cached?' · análise reaproveitada':''))+reconstructed;
      await record(detailedHead);
      const head='Análise concluída';
      if(I.canonical(await engine.selection())!==I.canonical(selection)){
        const text=head+'. '+(hadApplied?'NOVO trajeto salvo e ainda NÃO aplicado (o Program continua com a aplicação anterior)':'Trajeto salvo e NÃO aplicado')+': a seleção mudou durante a análise. Selecione '+selection.name+' e clique em Aplicar.';
        setNote(selection,text,true,head+'.');notice={key:keyOf(selection),text,statusPending:true};
        status(text,true);say(text);await record('seleção mudou durante a análise de '+selection.name+'; trajeto salvo, nada aplicado ('+job.requestId+')');
        return false;
      }
      if(cancelled){const text=head+'. Cancelado antes de aplicar; nada foi aplicado. O trajeto ficou salvo.';setNote(selection,text);say(text);status('Cancelado antes de aplicar. Nada foi aplicado.');await record('cancelado antes de aplicar '+selection.name+' ('+job.requestId+')');return false;}
      displayGroups([(await workflow.load(selection)).masks]);
      await refreshDetails();
      // A leitura do trajeto/geometria ainda permite Cancelar. Reconferir
      // depois de todos esses awaits, antes de autorizar a aplicação automática.
      stopIfCancelled();
      if(fillFailure){
        const text=(hadApplied?'Novo trajeto não aplicado. O vídeo mantém a aplicação anterior. ':'')+'Não foi possível reunir todos os trechos. Trajeto principal disponível: '+coverage+'. Veja o registro; a aplicação manual continua disponível.';
        setNote(selection,text,true,head+'.');notes.get(keyOf(selection)).kind='partial';say(text);status(text,true);card();return false;
      }
      if(!complete&&filled){
        const reviewCount=filled.recoveryEvidence.gaps.filter(g=>g.suspect||g.samplingBoundary||g.sparseFailure).length;
        const text='Não aplicado. '+(reviewCount?reviewCount+' trecho'+(reviewCount===1?'':'s')+' com perdas. ':'')+'Revisão opcional.';
        setNote(selection,text,true,head+'.');notes.get(keyOf(selection)).kind='partial';say(text);status(text);card();
        await record('perdas tratadas em '+selection.name+' com retomada a conferir; nada aplicado ('+job.requestId+')');
        return false;
      }
      if(!complete){
        // Perda do alvo: não aplica sozinho só o trecho maior; o editor decide.
        const text=hadApplied?'Novo trajeto não aplicado. O vídeo mantém a aplicação anterior.':'Trajeto parcial: '+coverage+' contínuos. Revisão opcional.';
        setNote(selection,text,true,head+'.');notes.get(keyOf(selection)).kind='partial';say(text);status('Trajeto parcial. Não aplicado.',true);card();
        await record('cobertura parcial em '+selection.name+': '+coverage+(lost?', perdido em '+lost:'')+'; aguardando conferência ('+job.requestId+')');
        return false;
      }
      if(!autoApply()){
        const text='Trajeto pronto e não aplicado. Clique em Aplicar e confira no Monitor do Programa; Ctrl+Z desfaz.';
        setNote(selection,text,true,head+'.');notes.get(keyOf(selection)).kind='ready';say(text);status(text);card();
        await record('100% em '+selection.name+'; aplicação automática desligada pelo editor; nada aplicado ('+job.requestId+')');
        return false;
      }
      const text=head+'. Aplicando…';setNote(selection,text);say(text);status(text);
      lastApplied={selection,head};
      return true;
    }catch(error){
      if(error&&error.code==='cancelled'){
        lastApplied=null;
        const selected=storedSelection||current,name=selected&&selected.name?' de '+selected.name:'';
        const text='Análise de rosto'+name+' cancelada. Nada foi aplicado.'+(storedSelection?' O trajeto medido ficou salvo para revisão e aplicação manual.':'');
        if(storedSelection)setNote(storedSelection,text,true);
        say(text);status(text);await record('análise cancelada'+name+(storedSelection?'; trajeto medido preservado; nada aplicado':''));return false;
      }
      fail(error);await record('falha: '+E.describe(error));
      throw (error instanceof Error&&error.message)?error:E.toError(error);
    }finally{running=false;cancelled=false;runningKey=null;progressPct=null;renderAvailability();card();}
  }
  // ---- qualidade e composição do take selecionado ----
  async function currentFaceMask(selection=current){
    if(!selection)return null;try{const d=await workflow.load(selection);return d&&(d.masks||[]).find(m=>m.type==='external-face')||null;}catch(_){return null;}
  }
  function compositionText(d,e,selection){
    if(!d)return '';
    if(!e)return '';
    if(selection){cuts.set(keyOf(selection),e.cutFraction);card();}
    const pct=n=>Math.round(n*100)+'%',parts=['Com o enquadramento atual: rosto com '+pct(e.faceFraction)+' da altura, topo estimado da cabeça a '+pct(Math.max(-1,e.headTopMin))+' do topo'];
    if(e.variableScale)parts.push('zoom de proteção de '+pct(e.minScale)+' a '+pct(e.scale));
    if(d.trackingReference)parts.push('Referência facial experimental: confira o movimento no vídeo antes de aplicar');
    if(e.cutFrames)parts.push('ATENÇÃO: risco estimado de corte da cabeça em '+pct(e.cutFraction)+' dos quadros; confira a cabeça no Program e ajuste a posição vertical e o zoom');
    if(e.borderFrames)parts.push('bordas em '+pct(e.borderFraction)+' dos quadros');
    const src=F.sourceCut(d);if(src>0.005)parts.push('o topo estimado ultrapassa a borda da imagem original em '+pct(src)+' dos quadros');
    return parts.join('. ')+'. Estimativa pelo rosto detectado.';
  }
  let detailsEpoch=0;
  const framingStamp=d=>I.canonical(framingSpec(d));
  async function refreshDetails(){
    if(disposed)return null;
    const epoch=++detailsEpoch,selection=current;updateAutoText();
    const valid=()=>!disposed&&epoch===detailsEpoch&&selection===current;
    const storedInfo=selection&&await loadInfo(selection);if(!valid())return;
    const d=selection&&await currentFaceMask(selection);if(!valid())return;
    const info=recoveredInfo(d,storedInfo);
    $('faceComposeBox').className='face-compose-box'+(d?'':' hidden');
    if(!info&&!d){$('faceDetails').className='face-details hidden';return;}
    $('faceDetails').className='face-details';
    $('faceQuality').textContent=info&&info.qualityText?(info.target?personText(info.target).replace(/^p/,'P')+' · ':'')+info.qualityText+((info.issues||[]).length?' '+info.issues.length+' trecho(s) para conferir.':' Nada a conferir.'):(info&&info.target?personText(info.target).replace(/^p/,'P')+'.':'');
    $('faceCompositionInfo').textContent=d?'Conferindo o enquadramento do clipe…':'';
    if(d){
      let stamp;
      try{
        stamp=framingStamp(d);
        if(typeof workflow.prepareFraming!=='function')throw Error('Leitura da geometria do clipe indisponível.');
        const prepared=await workflow.prepareFraming(d,framingSpec(d));
        if(!valid()||stamp!==framingStamp(d))return;
        $('faceCompositionInfo').textContent=compositionText(d,F.evaluatePrepared(prepared),selection);
      }catch(error){
        if(!valid()||(stamp&&stamp!==framingStamp(d)))return;
        cuts.delete(keyOf(selection));card();
        trace('composição: '+E.describe(error));$('faceCompositionInfo').textContent='Composição: não foi possível medir ('+((error&&typeof error.message==='string'&&error.message)||E.describe(error))+').';
      }
    }
    setButton('btnFaceNextIssue',!!(info&&(info.issues||[]).length),!running);
    renderCoverage(info);
    setButton('btnFacePick',!running&&!!(info&&info.target),!running&&!$('btnFaceAuto').disabled);
  }
  // A navegação mantém todos os avisos. A barra cresce além dos seis slots
  // antigos; em casos extremos vira visão resumida neutra, sem sugerir cobertura.
  const coverageSegments=[];
  function renderCoverage(info){
    const bar=$('faceCoverage'),job=info&&info.job,list=info&&Array.isArray(info.issues)?info.issues:null;
    if(!job||!list||!(job.outPoint>job.inPoint)){bar.className='coverage-bar hidden';return;}
    const total=job.outPoint-job.inPoint,all=list.filter(i=>['sem rosto','mantido','intervalo sem medição','baixa confiança','outro trecho'].includes(i.kind)),shown=all.slice(0,128);
    bar.className='coverage-bar'+(all.length>shown.length?' condensed':'');
    if(!coverageSegments.length)for(let k=1;k<=6;k++)coverageSegments.push($('covSeg'+k));
    while(coverageSegments.length<shown.length){const seg=bar.ownerDocument.createElement('span');bar.appendChild(seg);coverageSegments.push(seg);}
    // Desenhar as perdas por último, acima de outros trechos e baixa confiança.
    shown.sort((a,b)=>(a.kind==='sem rosto')-(b.kind==='sem rosto'));
    for(let k=0;k<coverageSegments.length;k++){
      const seg=coverageSegments[k],i=shown[k];
      if(!i){seg.className='cov-seg hidden';continue;}
      const a=Math.max(0,(i.start-job.inPoint)/total),b=Math.min(1,(i.end-job.inPoint)/total);
      seg.className='cov-seg '+(i.kind==='sem rosto'?'lost':i.kind==='outro trecho'?'other':i.kind==='mantido'?'held':'weak');
      seg.style.left=(100*a).toFixed(2)+'%';seg.style.width=Math.max(0.6,100*(b-a)).toFixed(2)+'%';
      seg.setAttribute('title',Q.label(i,job));
    }
    // Perdas tratadas não viram cobertura integral: o rótulo diz quanto do rosto foi medido.
    const text=(info.recoveryPrepared?'Rastreamento disponível: '+Q.coverText(info.coverageDetails.availableCoverage)+(Number.isFinite(info.primaryCoverage)?'; segmento contínuo principal: '+Q.coverText(info.primaryCoverage):''):Number.isFinite(info.measuredCoverage)?'Rosto medido em '+Q.coverText(info.measuredCoverage)+' dos quadros':'Cobertura do trajeto selecionado: '+Q.coverText(info.coverage))+(info.coverageDetails&&info.coverageDetails.otherSegments.length?'; rastreamento disponível: '+Q.coverText(info.coverageDetails.availableCoverage):'')+(all.length>shown.length?'; barra resumida: use Conferir próximo trecho para percorrer todos os avisos':'')+(all.length?'; '+all.map(i=>Q.label(i,job)).join('; '):'');
    bar.setAttribute('aria-label',text);bar.setAttribute('title',text);
  }
  // Confere no armazenamento se o take terminou aplicado e verificado.
  async function verifiedAfter(outcome,selection){
    const key=keyOf(selection);
    if(!outcome||!outcome.ok||!(outcome.selections||[]).some(s=>keyOf(s)===key))return false;
    try{return (await workflow.state(selection)).status==='verified';}catch(_){return false;}
  }
  async function startFlow(forceChoose=false){
    if(disposed)return false;
    let ready=false;
    await run(async()=>{ready=await analyzeAndCapture(forceChoose);});
    if(ready!==true||running||!lastApplied)return;
    const {selection,head}=lastApplied;lastApplied=null;
    if(typeof applyTrajectory!=='function'){const text=head+'. Trajeto salvo; clique em Aplicar.';setNote(selection,text,true,head+'.');showCurrent();return;}
    // Aplicação pelo fluxo normal (Movimento gerenciado, uma transação),
    // aguardando a promessa do próprio fluxo, não o evento de clique.
    const outcome=await applyTrajectory();
    const ok=await verifiedAfter(outcome,selection);
    if(ok)await rememberApplied(selection);
    const text=head+(ok?'. Aplicado e conferido.':outcome&&outcome.skipped?'. Trajeto salvo; o painel estava ocupado, clique em Aplicar.':'. A aplicação não foi confirmada; veja a mensagem de status.');
    setNote(selection,text,!ok,head+'.');showCurrent();
    await record((ok?'aplicado ':'aplicação não confirmada ')+selection.name);
    await refreshDetails();
  }
  listen($('btnFaceAuto'),'click',()=>{if(!$('btnFaceAuto').disabled)return startFlow(false);});
  listen($('btnFacePick'),'click',()=>{if(!$('btnFacePick').disabled)return startFlow(true);});
  for(let i=1;i<=MAX_FACES;i++)listen($('faceChoice'+i),'click',()=>{if(!$('faceChoice'+i).disabled)return choose(i-1);});
  listen($('faceChooserArea'),'click',event=>{
    if(!pendingChoice)return;const rect=$('faceChooserArea').getBoundingClientRect();if(!(rect.width>0&&rect.height>0))return;
    const nx=(event.clientX-rect.left)/rect.width,ny=(event.clientY-rect.top)/rect.height,faces=pendingChoice.found.faces;
    let best=-1,dist=Infinity;faces.forEach((f,i)=>{const d=Math.hypot(f.nx-nx,(f.ny-ny)*(rect.height/rect.width));if(d<dist){dist=d;best=i;}});
    const f=faces[best];if(f&&dist<=Math.max(.06,1.2*f.width/pendingChoice.found.width))return choose(best);
  });
  listen($('btnFaceChooserCancel'),'click',()=>{hideChooser(true);showCurrent();status('Escolha da pessoa cancelada. Nada foi alterado.');});
  listen($('btnFaceNextIssue'),'click',()=>run(async()=>{
    // Com perdas tratadas, a lista é a das perdas mantidas/emendadas (a mesma do cartão), sem repetir as perdas brutas.
    const selection=current,info=selection&&recoveredInfo(await currentFaceMask(),await loadInfo(selection)),list=info&&info.issues||[];if(!list.length)throw Error('Nada a conferir neste take.');
    issueIndex=(issueIndex+1)%list.length;const issue=list[issueIndex],job=info.job||selection;
    await step('navegar',()=>engine.navigate(selection,Math.max(selection.inPoint,Math.min(issue.start,selection.outPoint-1e-3))));
    const text='Trecho '+(issueIndex+1)+'/'+list.length+': '+Q.label(issue,job)+'. Cursor posicionado.';$('faceQuality').textContent=text;status(text);
  }));
  // Composição pelo rosto. Duas prioridades, escolhidas pelo editor:
  // 'face' = cabeça inteira, tamanho e folga (aceita bordas, que são informadas);
  // 'fill' = sem bordas (pode cortar a cabeça, o que é informado).
  // Nunca troca os controles por um enquadramento que corte mais a cabeça do que o atual.
  async function compose(priority){
    if(disposed)return null;
    const selection=current,epoch=detailsEpoch,d=await currentFaceMask(selection);if(disposed)return null;if(!d)throw Error('Compor pelo rosto precisa de um trajeto do motor de rosto neste take.');
    if(selection!==current||epoch!==detailsEpoch)throw Error('A seleção ou os controles mudaram; componha novamente.');
    if(typeof setFraming!=='function'||typeof framingSpec!=='function')throw Error('Este painel não permite ajustar a composição.');
    const read=(id,min,max)=>{const n=Number(String($(id).value).replace(',','.'));if(!Number.isFinite(n)||n<min||n>max)throw Error('Confira '+(id==='faceSize'?'o tamanho do rosto (5–80%)':id==='faceHeadroom'?'o espaço acima da cabeça (0–40%)':'o limite de zoom')+'.');return n;};
    const size=read('faceSize',5,80),room=read('faceHeadroom',0,40),limit=read('maxScale',100,1000)/100,offsetX=Number(String($('offsetX').value).replace(',','.'))||0;
    const spec=framingSpec(d),stamp=I.canonical(spec),dataStamp=I.digest(d),state=await workflow.state(selection);if(disposed)return null;const correctionStamp=I.digest(state.corrections||[]);
    const controlsStamp=()=>I.canonical({spec:framingSpec(d),size:$('faceSize').value,room:$('faceHeadroom').value,limit:$('maxScale').value});
    const inputStamp=controlsStamp();
    const assertCurrent=async()=>{
      if(disposed)return false;
      if(selection!==current||controlsStamp()!==inputStamp||keyOf(await engine.selection())!==keyOf(selection))throw Error('A seleção ou os controles mudaram; componha novamente.');
      if(disposed)return false;
      const latest=await currentFaceMask(selection);
      if(disposed)return false;
      const layers=(await workflow.state(selection)).corrections||[];
      if(disposed)return false;
      if(selection!==current||controlsStamp()!==inputStamp||!latest||I.digest(latest)!==dataStamp||I.digest(layers)!==correctionStamp)throw Error('O trajeto ou os controles mudaram; componha novamente.');
      const actual=await engine.selection();
      if(disposed)return false;
      if(selection!==current||controlsStamp()!==inputStamp||keyOf(actual)!==keyOf(selection))throw Error('A seleção ou os controles mudaram; componha novamente.');
      return true;
    };
    if(typeof workflow.prepareFraming!=='function')throw Error('Leitura da geometria do clipe indisponível.');
    const prepared=await workflow.prepareFraming(d,spec);if(disposed)return null;if(!await assertCurrent())return null;
    if(stamp!==framingStamp(d))throw Error('Os controles mudaram; componha novamente.');
    const sug=F.suggestPrepared(prepared,{faceFraction:size/100,headroom:room/100,maxScale:limit,offsetX,priority});
    const now=F.evaluatePrepared(prepared),after=F.evaluatePrepared(prepared,sug.spec);
    const pct=n=>Math.round(100*n)+'%',zoom=(100+sug.scalePercent).toFixed(1).replace('.',',')+'%',name=priority==='fill'?'Preencher quadro':'Priorizar rosto';
    const source=sug.sourceCut>0.005?' A estimativa pelo rosto ultrapassa o topo da imagem original em '+pct(sug.sourceCut)+' dos quadros. Confira a imagem original: a estimativa pode diferir do contorno real da cabeça.':'';
    const logIt=async(applied,why)=>record('composição ('+name+') em '+(current&&current.name)+': '+JSON.stringify({applied,why,size,room,limit,scalePercent:sug.scalePercent,offsetY:sug.offsetY,feasible:sug.feasible,cut:after&&after.cutFraction,cutNow:now&&now.cutFraction,borders:after&&after.borderFraction,sourceCut:sug.sourceCut}));
    if(priority==='fill'&&!sug.feasible){
      const text=name+': com o limite de zoom de '+Math.round(limit*100)+'% não há enquadramento sem bordas para o movimento deste take (precisaria de cerca de '+Math.round(sug.neededScale*100)+'%). Nada foi alterado. Aumente o Limite de zoom ou use Priorizar rosto (com bordas).'+source;
      status(text,true);await refreshDetails();if(disposed)return null;$('faceCompositionInfo').textContent=text+' '+$('faceCompositionInfo').textContent;await logIt(false,'sem enquadramento sem bordas');return;
    }
    if(!sug.feasible){
      const text='Priorizar rosto: os controles de escala não conseguem representar a sugestão dentro do Limite de zoom atual. Nada foi alterado. Confira a escala existente no clipe e aumente o limite se necessário.';
      status(text,true);await refreshDetails();if(disposed)return null;$('faceCompositionInfo').textContent=text+' '+$('faceCompositionInfo').textContent;await logIt(false,'escala não representável');return;
    }
    if(priority==='fill'&&(!after||after.borderFrames>0)){
      const text='Preencher quadro: com a suavização e os controles atuais, a sugestão ainda mostraria bordas. Nada foi alterado. Ajuste o enquadramento e confira no Monitor do Programa.';
      status(text,true);await refreshDetails();if(disposed)return null;$('faceCompositionInfo').textContent=text+' '+$('faceCompositionInfo').textContent;await logIt(false,'bordas depois dos controles');return;
    }
    if(now&&after&&after.cutFraction>now.cutFraction+0.01){
      const text=name+': a sugestão (zoom '+zoom+', vertical '+String(sug.offsetY).replace('.',',')+') cortaria a cabeça em '+pct(after.cutFraction)+' dos quadros, mais do que o enquadramento atual ('+pct(now.cutFraction)+'). Nada foi alterado.'+(priority==='fill'?' Use Priorizar rosto para manter a cabeça, com bordas.':'')+source;
      status(text,true);await refreshDetails();if(disposed)return null;$('faceCompositionInfo').textContent=text+' '+$('faceCompositionInfo').textContent;await logIt(false,'cortaria mais');return;
    }
    if(!await assertCurrent())return null;
    setFraming({mode:sug.scalePercent>0?'fixed':'none',scalePercent:sug.scalePercent,offsetY:sug.offsetY,guardFill:priority==='fill'});
    try{if(repository)await repository.write('face-composition-prefs',{size,room});}catch(_){}if(disposed)return null;
    const notes2=[],got=Math.round(sug.faceFraction*100);
    if(priority==='face'){
      if(sug.limitedByHead&&got<size)notes2.push('para a cabeça caber inteira com '+room+'% de espaço acima, o rosto ficou com '+got+'% em vez de '+size+'%');
      else if(sug.limitedByZoom&&got<size)notes2.push('o limite de zoom ('+Math.round(limit*100)+'%) não deixou o rosto chegar a '+size+'%: ficou com '+got+'%');
      else if(got>size+1)notes2.push('o rosto já ocupa '+got+'% da altura sem zoom');
      if(!sug.headFits)notes2.push('a cabeça é grande demais para caber inteira com essa folga mesmo sem zoom');
    }else if(got>size+1)notes2.push('para não mostrar bordas o zoom precisou ser maior: rosto com '+got+'% em vez de '+size+'%');
    if(after&&after.borderFraction>0)notes2.push('haverá bordas em '+pct(after.borderFraction)+' dos quadros'+(priority==='face'?' (para não ter bordas, use Preencher quadro, que pode cortar a cabeça)':''));
    if(after&&after.cutFraction>0)notes2.push('há risco estimado de corte da cabeça em '+pct(after.cutFraction)+' dos quadros');
    const text=name+' aplicado aos controles (não ao vídeo): zoom '+(sug.scalePercent>0?'fixo '+zoom:'100% (sem zoom)')+', vertical '+String(sug.offsetY).replace('.',',')+'.'+(notes2.length?' Atenção: '+notes2.join('; ')+'.':'')+source+' Confira e clique em Aplicar.';
    status(text,!!notes2.length||!!source);await refreshDetails();if(disposed)return null;$('faceCompositionInfo').textContent=text+' '+$('faceCompositionInfo').textContent;
    await logIt(true,null);
  }
  listen($('btnFaceCompose'),'click',()=>run(()=>compose('face')));
  listen($('btnFaceComposeFill'),'click',()=>run(()=>compose('fill')));
  // Aplicar manual (por exemplo depois de conferir um trajeto parcial): o
  // resultado chega pelo próprio fluxo de aplicação, já concluído.
  if(typeof onApplyFinished==='function')onApplyFinished(async outcome=>{
    if(lastApplied)return;// aplicação automática em andamento: tratada acima
    for(const selection of (outcome&&outcome.selections)||[]){
      const key=keyOf(selection),note=key&&notes.get(key),pendingNotice=!!(notice&&notice.key===key);
      if(!(note&&note.pending)&&!pendingNotice)continue;
      if(!await verifiedAfter(outcome,selection))continue;
      if(notice&&notice.key===key)notice=null;
      await rememberApplied(selection);
      const base=note?note.head:'Rosto de '+selection.name+'.';
      setNote(selection,base+' Aplicado pelo editor e conferido.',false,base);
      await record('aplicado pelo editor '+selection.name);
    }
    showCurrent();await refreshDetails();
  });
  // Chamado pelo painel sempre que a seleção muda (refreshSelection).
  function onSelection(selected,{selectionKnown:known=true,appliedMissing=false,appliedPresent=false,appliedUncertain=false,formatChanged=false}={}){
    if(disposed)return;
    detailsEpoch++;selectionKnown=known!==false;current=Array.isArray(selected)&&selected.length===1?selected[0]:null;
    const staleFailure=!!(formatChanged&&current&&notes.get(keyOf(current))?.failure),staleChoice=!!(formatChanged&&pendingChoice);
    if(staleFailure)notes.delete(keyOf(current));if(staleChoice)hideChooser();
    // Desfeito/removido no Premiere: o resumo deixa de dizer "aplicado".
    if(appliedUncertain&&current){const key=keyOf(current),note=notes.get(key),base=note?note.head:'Rosto de '+current.name+'.';notes.set(key,{text:base+' Não foi possível confirmar a aplicação atual. Confira o clipe no Premiere.',pending:true,uncertain:true,head:base,name:current.name});}
    if(appliedMissing&&current){const key=keyOf(current),note=notes.get(key),base=note?note.head:'Rosto de '+current.name+'.';notes.set(key,{text:'',pending:true,missing:true,head:base,name:current.name});trace('aplicação ausente em '+current.name+' (desfeito ou removido)');}
    if(appliedPresent&&current){const key=keyOf(current),note=notes.get(key);if(note&&(note.missing||note.uncertain)){notes.set(key,{text:note.head+(note.uncertain?' A aplicação atual foi conferida.':' Os keyframes voltaram ao take (refeito) e foram conferidos.'),pending:false,head:note.head,name:current.name});trace('aplicação presente de novo em '+current.name+' (refeito)');}}
    if(pendingChoice&&keyOf(current)!==pendingChoice.key)hideChooser();
    if(notice&&current&&keyOf(current)===notice.key){const n=notes.get(notice.key);if(n&&n.pending&&/Selecione /.test(n.text))notes.set(notice.key,{...n,text:n.head+' Trajeto salvo e ainda não aplicado. Clique em Aplicar.'});}
    issueIndex=-1;showCurrent();refreshDetails().catch(error=>trace('detalhes: '+E.describe(error)));
    if(notice&&notice.statusPending&&keyOf(current)!==notice.key){notice.statusPending=false;status(notice.text,true);}
    renderAvailability();return staleFailure||staleChoice;
  }
  // Preparação guiada: abre preparar-motor.bat numa janela do Windows e espera o motor responder.
  async function prepareEngine(){
    if(disposed||preparing)return;preparing=true;prepareStop=false;renderAvailability();status('Preparando o motor de rosto…');
    try{
      const path=await openTool(PREPARER,'Prepara o motor de rosto do Dynamic Anchor: confere o que ele precisa, instala o que faltar (uma vez) e liga o motor só neste computador.');
      if(disposed)return;
      say('Preparação aberta numa janela do Windows. Acompanhe os passos [OK]/[FALHA] nela. O painel espera o motor responder (até 10 min).');
      await persistLog().catch(()=>{});
      const until=Date.now()+PREPARE_WAIT_MS;let last=null;
      while(!disposed&&!prepareStop&&Date.now()<until){
        await sleep(2000);if(disposed)return;if(prepareStop){say('Espera interrompida. A janela de preparação continua aberta; clique em Preparar motor ou Analisar rosto quando ela terminar.');return;}if(engineState==='ready'&&!preparing)return;
        try{const raw=await client.status();if(disposed)return;const st=markReady(S.checkStatus(raw),', preparado por '+PREPARER);trace('preparação concluída: motor '+st.version);showCurrent();status('Motor de rosto pronto.');await persistLog().catch(()=>{});return;}
        catch(error){last=error;if(error&&error.code==='permission'){fail(error);return;}}
      }
      if(disposed)return;
      engineState='error';const text='O motor não respondeu depois da preparação ('+E.describe(last)+'). Veja o item [FALHA] na janela ou o relatório em %LOCALAPPDATA%\\Dynamic Anchor\\motor-rosto\\diagnostico.txt. Caminho: '+path;
      trace(text);say(text);status(text,true);
    }catch(error){if(!disposed){fail(error);status(E.describe(error),true);}}
    finally{preparing=false;if(!disposed){renderAvailability();await persistLog().catch(()=>{});}}
  }
  function diagnosticText(d){
    const ok=v=>v?'ok':'FALHA';
    return 'Motor '+d.version+' ('+(d.frozen?'empacotado':'Python '+d.python)+', pid '+d.pid+') · OpenCV '+(d.opencv||'?')+' · detector '+ok(d.faceDetector)+' · modelo '+(d.modelOk?'confere':'NÃO confere')+' · cache '+(d.cacheWritable?'gravável':'SEM gravação')+(d.ok?'.':'. Rode Preparar motor.');
  }
  listen($('btnFacePrepare'),'click',()=>{prepareEngine().catch(error=>trace('preparar: '+E.describe(error)));});
  listen($('btnFaceDiagnose'),'click',()=>run(async()=>{
    try{const d=await client.diagnostics();const text=diagnosticText(d);trace('diagnóstico: '+text+' | pasta '+d.dataFolder);say(text);status(d.ok?'Diagnóstico do motor: tudo certo.':'Diagnóstico do motor encontrou problema.',!d.ok);}
    catch(error){fail(error);throw E.toError(error,'[diagnóstico]');}
    finally{renderAvailability();}
  }));
  listen($('btnFaceCancel'),'click',()=>{if(!running){if(preparing){prepareStop=true;renderAvailability();}else if(orphanTaskId){const id=orphanTaskId;orphanTaskId=null;renderAvailability();client.cancel(id).then(()=>say('Análise anterior cancelada. Clique em Analisar rosto de novo.')).catch(e=>say('Não foi possível cancelar a análise anterior: '+E.describe(e)));}return;}cancelled=true;say('Cancelando… nada será aplicado.');renderAvailability();});
  listen($('btnFaceStart'),'click',()=>run(async()=>{
    try{await ensureEngine();showCurrent();status('Motor de rosto ligado.');}
    catch(error){fail(error);throw (error instanceof Error&&error.message)?error:E.toError(error);}
    finally{renderAvailability();}
  }));
  // A medida da composição acompanha os controles de enquadramento.
  let detailsTimer=null;const scheduleDetails=()=>{if(disposed)return;detailsEpoch++;updateAutoText();if(detailsTimer)clearTimeout(detailsTimer);detailsTimer=setTimeout(()=>{detailsTimer=null;if(!disposed)refreshDetails().catch(()=>{});},120);};
  for(const id of ['offsetX','offsetY','scalePercent','maxScale','smoothWin','tremorFilter','useRot','maxRot','deadzone','useTransform','centerTarget','faceSize','faceHeadroom'])for(const type of ['change','input']){try{listen($(id),type,scheduleDetails);}catch(_){}}
  for(const id of ['modeAuto','modeFixed','modeNone','btnResetOffset','btnResetZoom'])try{listen($(id),'click',scheduleDetails);}catch(_){}
  (async()=>{if(disposed)return;try{const p=repository&&await repository.read('face-composition-prefs');if(disposed)return;if(p&&p.payload){$('faceSize').value=String(p.payload.size);$('faceHeadroom').value=String(p.payload.room);}}catch(_){}})();
  for(const [name,m] of Object.entries(SAMPLING))try{listen($(m.id),'click',()=>{if(disposed||$(m.id).disabled||running)return;samplingTouched=true;sampling=name;showSampling();
        (async()=>{try{const sel=current;if(!sel)return;const d=await workflow.load(sel);const msg=speedMismatch(d&&d.masks&&d.masks[0]);if(msg&&!disposed)status(msg);}catch(_){}})();
    (async()=>{try{if(repository)await repository.write(SAMPLING_KEY,{mode:name});}catch(_){}await record('velocidade da próxima análise: '+m.label+' ('+(m.step===1?'todos os quadros':'1 de cada '+m.step)+')');})();});}catch(_){}
  showSampling();
  samplingLoaded=(async()=>{if(disposed)return;try{const p=repository&&await repository.read(SAMPLING_KEY);if(disposed)return;if(!samplingTouched&&p&&p.payload&&Object.hasOwn(SAMPLING,p.payload.mode))sampling=p.payload.mode;}catch(_){}if(!disposed)showSampling();})();
  (async()=>{try{if(repository)await repository.write(AUTO_KEY,{on:false});}catch(_){}updateAutoText();})();
  if(probeOnStart)require('./startup.js').gate.onActive(()=>probe());
  function dispose(){if(disposed)return;disposed=true;if(running)cancelled=true;if(detailsTimer!==null){clearTimeout(detailsTimer);detailsTimer=null;}for(const [target,type,handler,options]of listeners)try{target.removeEventListener(type,handler,options);}catch(_){}listeners.length=0;pendingChoice=null;}
  // Velocidade escolhida diferente da usada no trajeto carregado: aplicar daria o resultado antigo.
  function speedMismatch(d){
    if(!d||d.type!=='external-face')return null;
    const ref=d.trackingReference,step=ref&&ref.sampling&&Number.isInteger(ref.sampling.step)?ref.sampling.step:1,wanted=SAMPLING[sampling].step;
    if(step===wanted)return null;
    const label=s=>(Object.values(SAMPLING).find(m=>m.step===s)||{label:'passo '+s}).label;
    return 'Trajeto atual em '+label(step)+'. Ao aplicar, a análise é refeita em '+label(wanted)+' com a mesma pessoa.';
  }
  // Nova análise do take atual com a pessoa já escolhida (o alvo salvo é reaproveitado; não pergunta de novo).
  async function reanalyze(){if(disposed||running)return false;await analyzeAndCapture(false);return !disposed;}
  function speedLabel(){return SAMPLING[sampling].label;}
  return {speedMismatch,reanalyze,speedLabel,sync,probe,onSelection,refreshDetails,framingChanged:scheduleDetails,updateAutoText,cardState,currentSelection:()=>current,dispose,get disposed(){return disposed;},get running(){return running;}};
}
module.exports={initializeFacePanel};
