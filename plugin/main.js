(() => {
  'use strict';
  const $=id=>document.getElementById(id),native=typeof require==='function';
  const startup=require('./startup.js').gate;
  const ui=require('./ui.js').initializeUI(document);
  const navigateTask=id=>{if(ui.selectTask)ui.selectTask(id);};
  const revealTaskFor=id=>{if(ui.revealTaskFor)ui.revealTaskFor(id);};
  const layout=require('./layout.js');
  const C=native?require('./core.js'):window.AnchorCore;
  const I=require('./integrity.js'),E=require('./editing.js');
  let dataRepository=null,selectionWatcher=null,trajectoryNeedsConfirmation=false,selectionReadEpoch=0,selectionLoading=false;
  const metrics={};let tools=null,fillFraming=false,selectionStamp=null,draftTimer=null,restoring=false,preferencesTouched=false,batchRunning=false,operationPhase=null,taskRevision=0,panelDisposed=false;const drafts=new Map();
  const timed=async(name,fn,accumulate=false)=>{const start=Date.now();try{return await fn();}finally{metrics[name]=(accumulate?(metrics[name]||0):0)+Date.now()-start;}};
  let adjustedKeys=new Set(),applicationUncertain=false,appliedKnown=null,lastSelected=null,unapplied=new Set(),appliedSelection=null,busy=false,mode='auto',masks=[],selectedMask=0,projectFile=null,journalFile=null,journalError=null,history='',batchMasks=[];
  $('log').value='';
  let selectedTrackingSource=null,statusMessage='',statusIsError=false;
  function sourceConflict(){
    if(selectedTrackingSource===null||batchMasks.length||!masks[selectedMask])return '';
    const face=masks[selectedMask].type==='external-face';
    return selectedTrackingSource===1&&face?'Há um trajeto de rosto carregado. Selecione Rosto ou leia uma máscara antes de aplicar.':selectedTrackingSource===0&&!face?'Há uma máscara carregada. Selecione Máscara do Premiere ou analise o rosto antes de aplicar.':'';
  }
  function renderStatus(){
    if(panelDisposed)return;
    const notice=!busy&&sourceConflict(),summary=selectedTrackingSource===1?'Trajeto de rosto carregado. Origem escolhida: Máscara.':'Máscara carregada. Origem escolhida: Rosto.';
    $('status').textContent=notice?summary+(statusIsError?' '+statusMessage:''):statusMessage;
    $('status').className='status-line'+(statusIsError?' error':'');$('status').setAttribute('title',notice?notice+(statusIsError?' '+statusMessage:''):statusMessage);
    // O rodapé cresce com a mensagem: a área de rolagem é recalculada para ele não cobrir o conteúdo.
    if(typeof window!=='undefined'&&window.AnchorBancada)window.AnchorBancada.reflow();
  }
  const status=(s,error=false)=>{if(panelDisposed)return;statusMessage=s;statusIsError=error;renderStatus();};
  function maskInfoText(d){return d.type==='external-face'?(selectedTrackingSource===1?'Trajeto salvo é de Rosto. Leia a máscara para usar a Máscara.':'Trajeto de rosto carregado · '+d.rows.length+' quadros'):'Trecho selecionado · Máscara '+d.name;}
  function selectTrackingSource(index){if(index!==0&&index!==1)throw Error('Origem inválida.');selectedTrackingSource=index;controls();try{const d=masks[selectedMask];if(d)$('maskInfo').textContent=maskInfoText(d);}catch(_){}}
  const log=s=>{if(panelDisposed)return;const line=new Date().toISOString()+' '+s;$('log').value=($('log').value+line+'\n').slice(-60000);$('log').scrollTop=$('log').scrollHeight;console.log('[Dynamic Anchor] '+line);};
  const rotationAllowed=()=>false;
  function clearMasks(){
    fillFraming=false;
    if(tools)tools.setContext(null);
    masks=[];batchMasks=[];selectedMask=0;
    trajectoryNeedsConfirmation=false;appliedSelection=null;applicationUncertain=false;
    $('sourceInfo').textContent='Nenhum trecho carregado';$('maskInfo').textContent='Selecione o clipe com a máscara rastreada.';
    $('formatInfo').textContent='';$('dataCount').textContent='';$('maskChooser').className='hidden';$('properties').className='hidden';
  }
  const ready=(async()=>{if(!native)return;try{const folder=await require('uxp').storage.localFileSystem.getDataFolder();dataRepository=require('./repository.js').createRepository(folder);try{history=await(await folder.getEntry('anchor-session.log')).read();}catch(_){}journalFile=await folder.createFile('anchor-session.log',{overwrite:true});await journalFile.write(history.slice(-18000)+'\n=== Dynamic Anchor 1.7.5 ===\n');}catch(e){journalError=e;}})();
  // Grava o registro em disco sem interromper nada (eventos do motor de rosto).
  async function persistLog(){await ready;if(!native||journalError||!journalFile)return false;try{await journalFile.write((history.slice(-18000)+'\n=== Dynamic Anchor 1.7.5 ===\n'+$('log').value).slice(-60000));return true;}catch(_){return false;}}
  async function checkpoint(s){if(busy){const phase=ui.describePhase(s);if(phase){operationPhase=phase;status(phase);updateCard();}}await ready;log(s);if(native){if(journalError||!journalFile)throw new Error('Registro de diagnóstico indisponível. Aplicação interrompida.');await journalFile.write((history.slice(-18000)+'\n=== Dynamic Anchor 1.7.5 ===\n'+$('log').value).slice(-60000));}}
  const nativePoints=native?require('./linear-point-keyframes.js').createLinearPointKeyframes({ppro:require('premierepro'),loadTemplate:require('./native-linear-template.js').createNativeLinearTemplate({ppro:require('premierepro'),uxp:require('uxp')})}):null;
  const engine=native?require('./engine.js').createEngine(require('premierepro'),C,checkpoint,{pointKeyframes:nativePoints}):null;
  const repository={read:async key=>{await ready;if(!dataRepository)throw Error('Armazenamento indisponível.');return dataRepository.read(key);},write:async(key,value)=>{await ready;if(!dataRepository)throw Error('Armazenamento indisponível.');return dataRepository.write(key,value);}};
  const workflow=require('./workflow.js').createWorkflow({engine,repository,report:log});
  const normalize=s=>{s=String(s);if(s.startsWith('\\\\?\\'))s=s.slice(4);return s.replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();};
  const fieldNames={smoothWin:'Suavização',scalePercent:'Aumento de escala',maxScale:'Limite de zoom',offsetX:'Deslocamento horizontal',offsetY:'Deslocamento vertical',shutterAngle:'Ângulo do obturador'};
  function numeric(id,min,max,integer=false){const s=String($(id).value).trim().replace(',','.'),n=/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)?Number(s):NaN;if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))throw new Error('Confira '+(fieldNames[id]||id)+': use '+(integer?'um inteiro':'um número')+' entre '+min+' e '+max+'.');return n;}
  // Resumo legível do enquadramento atual (usado no aviso antes de aplicar sozinho).
  function framingSummary(){
    const n=id=>{const v=Number(String($(id).value).trim().replace(',','.'));return Number.isFinite(v)?v:null;};
    const fmt=v=>(v<0?'−':'')+String(Math.round(Math.abs(v)*10)/10).replace('.',',');
    const parts=[];const y=n('offsetY'),x=n('offsetX'),smooth=n('smoothWin');
    if(y!==null)parts.push('vertical '+fmt(y));
    if(x!==null&&x!==0)parts.push('horizontal '+fmt(x));
    if(mode==='auto')parts.push('zoom automático mínimo sem bordas');
    else if(mode==='fixed'){const z=n('scalePercent');parts.push(z?'zoom fixo '+fmt(100+z)+'%':'sem zoom');}
    else parts.push('sem zoom (100%)');
    const movement=ui.describeMovement({quality:tools?tools.getQuality():{},smooth,tremor:$('tremorFilter').checked,rotation:$('useRot').checked});
    if(movement!=='sem suavização adicional')parts.push(movement);
    return parts.join(' · ');
  }
  function finishingSummary(){
    const rot=$('useRot').checked?'rotação até '+String($('maxRot').value).replace('.',',')+'°':'rotação desligada';
    return rot.charAt(0).toUpperCase()+rot.slice(1);
  }
  // Cartão do take: um lugar só para o estado do take e o próximo passo.
  const secs=v=>(Math.round(v*10)/10).toFixed(1).replace('.',',')+' s';
  function cardSelection(){
    if(lastSelected&&lastSelected.length)return lastSelected;
    if(batchMasks.length)return batchMasks.map(m=>m.selection).filter(Boolean);
    const d=masks[selectedMask];if(d&&d.selection)return [d.selection];
    try{const face=tools&&tools.currentSelection?tools.currentSelection():null;if(face)return [face];}catch(_){}
    return null;
  }
  function baseCard(){
    const sel=cardSelection();
    if(!sel||!sel.length)return {name:'Nenhum take selecionado',meta:'',chip:'Sem take',tone:'',next:'Selecione um take na timeline do Premiere.'};
    if(sel.length>1)return {name:sel.length+' takes selecionados',meta:sel.map(t=>t.name).join(' · '),chip:'Lote',tone:'info',next:masks.length?'Clique em Aplicar para aplicar aos '+sel.length+' takes.':'Leia as máscaras dos '+sel.length+' takes. O rosto funciona um take por vez.'};
    const t=sel[0],dur=Number.isFinite(t.end)&&Number.isFinite(t.start)?t.end-t.start:Number.isFinite(t.outPoint)&&Number.isFinite(t.inPoint)?t.outPoint-t.inPoint:null;
    const d=masks[selectedMask],meta=[dur!==null?secs(dur):null,d&&Number.isFinite(d.fps)?String(Math.round(d.fps*100)/100).replace('.',',')+' fps':null].filter(Boolean).join(' · ');
    const card={name:t.name||'Take',meta};
    const key=I.canonical(t);
    if(busy)return {...card,chip:'Processando…',tone:'run',next:operationPhase||'Aguarde o fim da operação.'};
    if(!masks.length)return {...card,chip:'Sem rastreamento',tone:'',next:'Rastreie o rosto ou leia a máscara deste take.'};
    if(applicationUncertain)return {...card,chip:'Aplicação precisa de revisão',tone:'warn',next:'Não foi possível confirmar os valores atuais no Premiere. Confira o clipe antes de reaplicar.',strong:true};
    if(adjustedKeys.has(key)&&!unapplied.has(key))return {...card,chip:'Ajustado · não aplicado',tone:'warn',next:'Os ajustes mudaram depois da última aplicação. Clique em Aplicar para atualizar o Program.',strong:true};
    if(unapplied.has(key))return {...card,chip:'Novo trajeto · não aplicado',tone:'warn',next:'O Program ainda mostra a aplicação anterior. Clique em Aplicar novo trajeto quando quiser.',strong:true};
    if(appliedKnown===false)return {...card,chip:'Resultado alterado',tone:'warn',next:'O resultado aplicado foi alterado ou desfeito no Premiere. Clique em Aplicar para aplicar estes ajustes de novo.',strong:true};
    if(appliedSelection===key)return {...card,chip:'Aplicado',tone:'ok',next:'Confira no Program. Ajuste com Atualizar enquadramento.',strong:true,applied:true};
    if(trajectoryNeedsConfirmation)return {...card,chip:'Trajeto salvo',tone:'info',next:'Clique em Aplicar trajeto salvo, ou leia de novo se a máscara mudou.'};
    if(d&&d.recoveryEvidence&&d.recoveryEvidence.kind==='auto-gaps-v1')return {...card,chip:'Perdas tratadas',tone:d.recoveryEvidence.suspect?'warn':'info',next:d.recoveryEvidence.suspect?'Confira as retomadas marcadas e clique em Aplicar.':'Falhas curtas emendadas e perdas longas mantidas. Confira e clique em Aplicar.'};
    if(d&&d.recoveryEvidence)return {...card,chip:'Trechos revisados',tone:'warn',next:'Nas perdas, mantém o último enquadramento. Confira e clique em Aplicar.'};
    if(d&&d.partial)return {...card,chip:'Trajeto parcial',tone:'warn',next:'Aplica só onde há rastreamento. Confira e clique em Aplicar.'};
    return {...card,chip:'Trajeto pronto',tone:'info',next:'Clique em Aplicar e confira no Monitor do Programa; Ctrl+Z desfaz.'};
  }
  function updateCard(){
    let card=baseCard();
    try{const face=tools&&tools.cardState?tools.cardState(cardSelection(),card):null;if(face)card={...card,...face};}catch(_){}
    if(!busy){const notes=(cardSelection()||[]).map(s=>legacyNotices.get(I.canonical(s))).filter(Boolean);if(notes.length)card.next+=' '+notes.join(' ');}
    if(busy&&(operationPhase||card.tone!=='run'))card={...card,chip:'Processando…',tone:'run',next:operationPhase||'Aguarde o fim da operação.'};
    try{$('takeName').textContent=card.name;$('takeName').setAttribute('title',card.name);$('takeName').setAttribute('aria-label',card.name);$('takeMeta').textContent=card.meta||'';$('takeChip').textContent=card.chip;$('takeChip').setAttribute('data-tone',card.tone||'');$('takeNext').textContent=card.next;}catch(_){}
  }
  // Facial references already carry their starting point. Keep that first measurement on reapply.
  const preparedReference=d=>require('./video-reference.js').isVideo15(d?.trackingReference)||require('./adaptive-reference.js').isAdaptive(d?.trackingReference);
  const legacyNotices=new Map(),motionDestinations=new Set(),transformDestinations=new Set();
  function rememberLegacyNotice(selection,saved,inBatch=false){
    const key=I.canonical(selection),receipt=saved.managedReceipt;
    if(receipt&&receipt.version===2&&receipt.destination==='motion'&&receipt.layout==='native-motion-v1'&&receipt.match==='AE.ADBE Motion')motionDestinations.add(key);else motionDestinations.delete(key);
    // B24: take com Transformar do Dynamic Anchor; aplicar em Movimento migra o efeito (aviso antes de aplicar).
    if(receipt&&Array.isArray(receipt.matches)&&receipt.matches[receipt.index]==='AE.ADBE Geometry2'&&!motionDestinations.has(key))transformDestinations.add(key);else transformDestinations.delete(key);
    if(transformDestinations.size>64)transformDestinations.delete(transformDestinations.values().next().value);
    if(motionDestinations.size>64)motionDestinations.delete(motionDestinations.values().next().value);
    const notes=[];
    if(saved.corrections?.length)notes.push('correções antigas');
    if(inBatch&&saved.override===true)notes.push('ajustes próprios antigos');
    legacyNotices.set(I.canonical(selection),notes.length?selection.name+': '+notes.join(' e ')+' continuam em uso.':'');
  }
  function onStateChanged(selection,saved){rememberLegacyNotice(selection,saved,(cardSelection()||[]).length>1);updateCard();}
  function controls(){
    if(panelDisposed)return;
    for(const e of document.querySelectorAll('[role=button],[role=checkbox],[role=slider],sp-textfield,sp-dropdown'))e.disabled=busy;
    if(!busy){$('useRot').disabled=!rotationAllowed();if($('useRot').disabled)$('useRot').checked=false;$('maxRot').disabled=$('deadzone').disabled=$('maxRotSlider').disabled=$('deadzoneSlider').disabled=!$('useRot').checked;$('btnProperties').disabled=!masks.length;$('btnApply').disabled=!masks.length;$('smoothWin').disabled=false;}
    $('tremorHint').className='help compact'+($('tremorFilter').checked?'':' hidden');
    for(const [group,check]of [['rotationControl','useRot'],['maxRotControl','useRot'],['deadzoneControl','useRot']])$(group).setAttribute('data-inactive',String(!$(check).checked));
    try{$('finishingSummary').textContent=finishingSummary();}catch(_){}
    const trajectories=batchMasks.length?batchMasks:[masks[selectedMask]];
    const maskTrajectory=trajectories.some(d=>d&&!preparedReference(d));
    for(const id of ['movementControls','finishingSection'])$(id).classList.toggle('hidden',!maskTrajectory);
    const hasTrajectory=trajectories.some(Boolean);
    // Filtros de máscara (saltos isolados, centro do polígono) não têm efeito no trajeto do rosto, que já sai suavizado do motor.
    const faceOnly=trajectories.filter(Boolean).length>0&&trajectories.filter(Boolean).every(d=>d.type==='external-face');
    $('qualitySection').classList.toggle('hidden',!hasTrajectory||faceOnly);
    $('maskCenterMethods').classList.toggle('hidden',!maskTrajectory);
    $('movementSummary').textContent='Ativo: '+ui.describeMovement({quality:tools?tools.getQuality():{},smooth:$('smoothWin').value,tremor:$('tremorFilter').checked,rotation:$('useRot').checked})+'.';
    if(tools&&tools.framingChanged)try{tools.framingChanged();}catch(_){}
    updateCard();
    updateZoom();
    $('fixedRow').className='field'+(mode==='fixed'?'':' hidden');
    $('applyLabel').textContent=busy?'Processando…':'Aplicar';
    $('newEffectHint').className='help effect-note'+($('useTransform').checked?'':' hidden');$('btnTransformTarget').textContent=$('useTransform').checked?'Transformar':'Movimento';
    $('offsetX').disabled=busy||!$('useX').checked;$('offsetY').disabled=busy||!$('useY').checked;
    $('targetFrame').disabled=busy;$('btnCancelBatch').disabled=!busy||!batchRunning;$('btnCancelBatch').className='file-button compact-action'+(busy&&batchRunning?'':' hidden');
    if(!busy){$('btnApply').disabled=!masks.length;}
    $('btnUseSaved').disabled=busy||!masks.length||!trajectoryNeedsConfirmation;$('btnUseSaved').className='file-button compact-action'+(masks.length&&trajectoryNeedsConfirmation?'':' hidden');
    const readTitle=$('btnReadMask').querySelector('.file-title'),maskLoaded=masks.length&&(batchMasks.length?batchMasks:[masks[selectedMask]]).every(d=>d.type!=='external-face');if(readTitle)readTitle.textContent=maskLoaded?'Ler máscara de novo (salva o projeto)':'Ler máscara (salva o projeto)';
    // Novo trajeto (motor de rosto) sobre um take já aplicado: deixar claro que ainda não foi aplicado.
    const pendingNew=!batchMasks.length&&!!masks[selectedMask]&&!!masks[selectedMask].selection&&unapplied.has(I.canonical(masks[selectedMask].selection));
    if(!busy&&masks.length)$('applyLabel').textContent=pendingNew?'Aplicar novo trajeto':appliedSelection?'Atualizar enquadramento':trajectoryNeedsConfirmation?'Aplicar trajeto salvo':'Aplicar';
    const destinationBlocked=!busy&&!batchMasks.length&&$('useTransform').checked&&masks[selectedMask]?.selection&&motionDestinations.has(I.canonical(masks[selectedMask].selection));
    const migrationBlocked=!busy&&!batchMasks.length&&!$('useTransform').checked&&masks[selectedMask]?.selection&&transformDestinations.has(I.canonical(masks[selectedMask].selection));
    const migrationNotice='Este take tem um Transformar do Dynamic Anchor. Ao aplicar em Movimento, o rastreamento passa para Movimento e esse Transformar é migrado. Confira o resultado; Ctrl+Z desfaz.';
    const destinationNotice='Este take já usa Movimento. Selecione Movimento em Destino para atualizar o rastreamento.';
    const sourceNotice=sourceConflict();
    if(!busy&&sourceNotice){$('btnApply').disabled=true;$('applyLabel').textContent=selectedTrackingSource===1?'Leia uma máscara':'Analise o rosto';}
    else if(destinationBlocked){$('btnApply').disabled=true;$('applyLabel').textContent='Selecione Movimento';}
    $('newEffectHint').textContent=destinationBlocked?destinationNotice:'Grava num Transformar próprio; Movimento intacto.';
    // Linha abaixo do botão principal: o que a aplicação altera.
    try{const d0=masks[selectedMask],n=batchMasks.length,dest=$('useTransform').checked?'no efeito Transformar do Dynamic Anchor':'em Movimento',undo=$('useTransform').checked?'Transformar novo: 2× Ctrl+Z; atualização: 1×.':'Ctrl+Z desfaz.';
      $('applyEffect').textContent=busy?'':sourceNotice||destinationBlocked&&destinationNotice||migrationBlocked&&migrationNotice||(!masks.length?'Primeiro rastreie o rosto ou leia uma máscara.':
        n?'Grava '+dest+' de cada um dos '+n+' takes. Pode cancelar entre takes. Desfaça uma etapa por vez.':
        pendingNew?'Substitui '+dest+' a aplicação anterior deste take. '+undo:
        appliedSelection?($('useTransform').checked?undo:'Atualiza Movimento com estes ajustes, sem analisar de novo.'):
        (d0&&d0.recoveryEvidence&&d0.recoveryEvidence.kind==='auto-gaps-v1'?(d0.recoveryEvidence.keyframeInterpolation==='between-analyzed-instants-v1'?'Usa os trechos encontrados. Nas perdas, o Premiere interpola entre os instantes analisados. ':'Usa o take inteiro: falhas curtas emendadas e, nas perdas longas, mantém o enquadramento com transição suave. '):d0&&d0.recoveryEvidence?'Usa os trechos revisados e mantém o último enquadramento nas perdas; pode haver salto na retomada. ':d0&&d0.partial?'Aplica só onde há rastreamento; fora dele, o enquadramento fica como está. ':'Grava Posição e Escala '+dest+' deste take. ')+undo);$('applyEffect').setAttribute('title',$('applyEffect').textContent);}catch(_){}
    $('trajectoryState').textContent=busy?'Processando…':!masks.length?'Sem trajeto':pendingNew?'Novo trajeto · não aplicado':trajectoryNeedsConfirmation?'Trajeto salvo':appliedSelection?'Trajeto aplicado':'Trajeto disponível';
    $('selectionContext').textContent=batchMasks.length?batchMasks.length+' takes · ajustes próprios têm prioridade':masks.length?'1 take · ajuste e reaplique sem reler':'Selecione um take na timeline';
    $('btnApply').setAttribute('aria-busy',String(busy));
    $('scroller').setAttribute('aria-busy',String(busy));
    if(tools)tools.syncAvailability(busy,masks.length>0&&!batchMasks.length);
    renderStatus();ui.sync();if(typeof window!=='undefined'&&window.AnchorBancada)window.AnchorBancada.sync();
  }
  // O UXP pode rejeitar com valores que não são Error; nunca mostrar "undefined".
  function errorText(e){if(e&&typeof e.message==='string'&&e.message)return e.message;if(typeof e==='string'&&e)return e;try{const j=JSON.stringify(e,e&&typeof e==='object'?Object.getOwnPropertyNames(e):undefined);if(j&&j!=='{}')return 'Erro sem mensagem: '+j.slice(0,400);}catch(_){}return 'Erro sem mensagem ('+String(e)+').';}
  async function run(fn){if(panelDisposed||busy)return;const scroll=$('scroller').scrollTop,taskAtStart=taskRevision;busy=true;operationPhase=null;controls();try{await fn();}catch(e){if(!panelDisposed){const message=errorText(e);status(message,true);log('ERRO: '+message+(e&&e.stack?' | '+e.stack:''));if(journalFile)try{await journalFile.write((history.slice(-18000)+'\n'+$('log').value).slice(-60000));}catch(_){} }}finally{busy=false;batchRunning=false;operationPhase=null;if(!panelDisposed){controls();if(taskAtStart===taskRevision)$('scroller').scrollTop=scroll;if(selectionWatcher)selectionWatcher.refresh();}}}
  function updateZoom(){
    const amount=Number(String($('scalePercent').value).replace(',','.'));
    $('scaleResult').textContent=mode==='auto'?'Automático (Sem bordas)':mode==='none'?'Escala padrão':amount===0?'Escala atual':Number.isFinite(amount)&&amount>=0?(100+amount).toFixed(1).replace('.',','):'—';
  }
  function chooseMode(m){mode=m;for(const [id,v]of[['modeAuto','auto'],['modeFixed','fixed'],['modeNone','none']]){ $(id).className=m===v?'selected':'';$(id).setAttribute('aria-pressed',String(m===v));}updateZoom();controls();}
  function updateTarget(){
    // Bancada owns host-sized layout and sequence display aspect (including PAR).
    // The legacy renderer must not replace those dimensions on control changes.
    if(typeof window!=='undefined'){
      ui.sync();if(window.AnchorBancada)window.AnchorBancada.reflow();return;
    }
    if(document.documentElement&&document.documentElement.clientWidth){
      const g=layout.panelGeometry(document.documentElement.clientWidth),panel=document.querySelectorAll('.panel')[0];
      panel.style.width=g.width+'px';panel.style.marginLeft=g.left+'px';panel.style.marginRight='0px';
    }
    const d=masks[selectedMask]||{W:16,H:9},available=Number(document.querySelectorAll('.target-wrap')[0].clientWidth)||240;
    // Explicit width plus zero native margin matches the other full-width controls.
    $('log').style.width='100%';
    const frame=layout.previewGeometry(d.W,d.H,available);
    $('targetFrame').style.width=frame.width+'px';$('targetFrame').style.height=frame.height+'px';
    $('targetFrame').style.marginLeft=Math.max(0,Math.floor((available-frame.width)/2))+'px';
    $('targetDot').style.left=layout.markerPosition($('offsetX').value,frame.width-2)+'px';
    $('targetDot').style.top=layout.markerPosition($('offsetY').value,frame.height-2)+'px';ui.sync();if(typeof window!=='undefined'&&window.AnchorBancada)window.AnchorBancada.reflow();
  }
  function showMask(){const d=masks[selectedMask];if(!d)return;if(tools)tools.setContext(d);const name=d.selection&&d.selection.name||'Clipe selecionado';$('sourceInfo').textContent=name;$('maskInfo').textContent=maskInfoText(d);$('formatInfo').textContent=d.W+' × '+d.H+' · '+d.fps.toFixed(3).replace('.',',')+' fps';$('dataCount').textContent=d.rows.length+' quadros'+(d.recoveryEvidence?' · '+d.recoveryEvidence.heldFrames+' mantidos sem detecção':d.partial?' · máscara de '+d.times[0].toFixed(2).replace('.',',')+' a '+d.lastTrackedTime.toFixed(2).replace('.',',')+' s':'');updateTarget();}
  async function resolveObjectMasks(groups,fs,storage,projectKey){
    const objects=groups.flat().filter(d=>d.type==='object');if(!objects.length)return groups;
    const O=require('./object-mask.js'),folderKey='anchor-object-folder:'+projectKey;
    let folder=null;
    try{const token=localStorage.getItem(folderKey);if(token)folder=await fs.getEntryForPersistentToken(token);}catch(_){}
    if(!folder){
      status('Selecione a pasta de máscaras de objeto deste projeto…');
      folder=await fs.getFolder();
    }
    if(!folder)throw new Error('Leitura cancelada. Selecione a pasta de máscaras de objeto do projeto.');
    const expected=normalize(projectFile.nativePath).replace(/\.prproj$/i,' masks');
    if(normalize(folder.nativePath)!==expected)throw new Error('Escolha a pasta “'+projectFile.name.replace(/\.prproj$/i,'')+' Masks” ao lado do projeto.');
    try{localStorage.setItem(folderKey,await fs.createPersistentToken(folder));}catch(_){}
    status('Lendo os quadros das máscaras de objeto…');
    const objectRefs=new Set(objects.flatMap(d=>d.objectRefs||[]));
    const entries=(await folder.getEntries()).filter(e=>/\.prmf$/i.test(e.name)&&objectRefs.has(e.name.slice(0,-5).toLowerCase()));
    if(!entries.length)throw new Error('Os arquivos vinculados a esta máscara não estão na pasta escolhida. Complete o rastreamento e salve o projeto no Premiere.');
    const sources=[];
    for(const entry of entries){
      try{let rangeFS=null;try{rangeFS=require('fs');}catch(_){}const index=await timed('lerEInterpretarPRMF',()=>O.indexFile(entry,{fs:rangeFS,localFileSystem:fs,binary:storage.formats.binary,onFallback:message=>log('LEITURA PRMF: '+message)}),true);sources.push({id:entry.name.slice(0,-5).toLowerCase(),index});if(index.rangeRead)log('PRMF: '+index.readBytes+' de '+index.fileBytes+' bytes lidos; pixels comprimidos dispensados.');if(index.skippedRecords)log('AVISO: '+entry.name+': '+index.skippedRecords+' registro(s) inválido(s) ignorado(s); '+index.frames.length+' quadro(s) válidos disponíveis.');if(index.duplicateFrames)log('AVISO: '+entry.name+': '+index.duplicateFrames+' quadro(s) repetido(s) ignorado(s).');}
      catch(error){log('Máscara de objeto ignorada ('+entry.name+'): '+error.message);}
    }
    if(!sources.length)throw new Error('Nenhum arquivo de máscara de objeto pôde ser lido.');
    return groups.map(group=>group.map(d=>{
      if(d.type!=='object')return d;
      const result=O.forSources(sources,d);if(result.repairedFrames)log('AVISO: '+d.selection.name+': '+result.repairedFrames+' quadro(s) ausente(s) interpolado(s).');if(result.partial)log('RASTREIO PARCIAL: '+d.selection.name+': máscara salva até '+result.lastTrackedTime.toFixed(2)+' s; '+result.rows.length+' quadros utilizáveis. O enquadramento anterior será preservado fora da máscara.');return result;
    }));
  }
  async function readSavedMasks(forceChoose=false){
    if(!engine)throw new Error('Abra este painel dentro do Premiere.');
    const oldName=masks[selectedMask]&&masks[selectedMask].name;
    const selections=engine.selections?await engine.selections():[await engine.selection()],selection=selections[0],fs=require('uxp').storage.localFileSystem,storage=require('uxp').storage;
    const key='anchor-project:'+normalize(selection.projectPath);
    if(forceChoose||!projectFile||normalize(projectFile.nativePath)!==normalize(selection.projectPath)){
      projectFile=null;
      if(!forceChoose)try{const token=localStorage.getItem(key);if(token)projectFile=await fs.getEntryForPersistentToken(token);}catch(_){}
      if(!projectFile)projectFile=await fs.getFileForOpening({types:['prproj'],allowMultiple:false});
      if(!projectFile)throw new Error('Leitura cancelada. Escolha o arquivo do projeto ativo para ler a máscara.');
      if(normalize(projectFile.nativePath)!==normalize(selection.projectPath)){projectFile=null;throw new Error('Escolha o mesmo arquivo .prproj que está aberto no Premiere.');}
      try{localStorage.setItem(key,await fs.createPersistentToken(projectFile));}catch(_){}
    }
    // Só limpa depois de ter o arquivo do projeto: cancelar o diálogo não apaga o trajeto nem o estado "Aplicado".
    for(const key of Object.keys(metrics))delete metrics[key];
    clearMasks();
    status('Salvando o projeto e lendo o rastreamento…');
    await timed('salvar',()=>engine.saveForRead(selections.length>1?selections:selection));
    let bytes=new Uint8Array(await timed('lerProjeto',()=>projectFile.read({format:storage.formats.binary})));
    const P=require('./project-mask.js');let xml,groups=[];
    batchMasks=[];masks=[];
    try{
      xml=await timed('interpretarProjeto',async()=>P.prepareProject(P.unpackProject(bytes)));
      bytes=null;
      await timed('decodificarMascarasVetoriais',async()=>{for(const selected of selections){try{const parsed=P.parseProject(xml,selected);groups.push(parsed);}catch(error){throw new Error(selected.name+': '+error.message+' Nenhum rastreamento deste lote foi aplicado.');}}});
    }finally{bytes=null;xml=null;} // Release the project tree before PRMF dialogs and trajectory storage.
    groups=await timed('lerMascaras',()=>resolveObjectMasks(groups,fs,storage,key));
    let metadata=null;try{metadata=await projectFile.getMetadata();}catch(_){}
    await timed('preservarTrajetos',()=>workflow.capture(groups,selections,{project:metadata?{size:metadata.size,modified:String(metadata.dateModified)}:null}));
    groups=await batchChoices(await Promise.all(selections.map(async selected=>(await workflow.load(selected)).masks)));
    trajectoryNeedsConfirmation=false;selectionStamp=I.canonical(selections);
    const result=I.clone(groups[0]);batchMasks=selections.length>1?I.clone(groups.map(group=>group[0])):[];
    if(appliedSelection&&appliedSelection!==I.canonical(selection))appliedSelection=null;
    masks=result;selectedMask=Math.max(0,masks.findIndex(m=>m.name===oldName));
    if(!rotationAllowed())$('useRot').checked=false;
    const options=$('maskOptions');
    if(masks.length>1){while(options.firstChild)options.removeChild(options.firstChild);for(const m of masks){const item=document.createElement('sp-menu-item');item.textContent=m.name;options.appendChild(item);}$('maskSelect').selectedIndex=selectedMask;}
    $('maskChooser').className=masks.length>1?'':'hidden';
    showMask();if(batchMasks.length){const partialCount=batchMasks.filter(d=>d.partial).length;$('sourceInfo').textContent=batchMasks.length+' trechos selecionados';$('maskInfo').textContent='Uma máscara por trecho · configurações comuns';$('dataCount').textContent=batchMasks.reduce((n,d)=>n+d.rows.length,0)+' quadros no total'+(partialCount?' · '+partialCount+' parcial'+(partialCount===1?'':'is'):'');}await checkpoint('MÁSCARA REAL: '+masks[selectedMask].name+'; '+masks[selectedMask].rows.length+' quadros; '+masks[selectedMask].W+'x'+masks[selectedMask].H+'; tempos da fonte preservados.');
    return masks[selectedMask];
  }
  // Usados pelo motor de rosto: medir o enquadramento atual e aplicar uma
  // composição sugerida aos controles (o editor confere e clica em Aplicar).
  function markUnapplied(selection){const key=I.canonical(selection);unapplied.add(key);if(appliedSelection===key)appliedSelection=null;log('NOVO TRAJETO NÃO APLICADO: '+selection.name+' (o Program continua com a aplicação anterior).');controls();}
  function framingSpec(d){return settings(d);}
  function setFraming({mode:nextMode,scalePercent,offsetX,offsetY,guardFill=false}={}){
    fillFraming=false;
    if(nextMode)chooseMode(nextMode);
    if(scalePercent!==undefined)$('scalePercent').value=String(scalePercent);
    if(offsetX!==undefined)$('offsetX').value=String(offsetX);
    if(offsetY!==undefined)$('offsetY').value=String(offsetY);
    fillFraming=guardFill===true;$('centerTarget').checked=false;controls();updateTarget();
    // Também durante uma ação em andamento: guarda o rascunho deste take já,
    // para uma atualização da seleção não restaurar os valores antigos.
    const stamp=selectionStamp||(masks.length&&!batchMasks.length&&masks[selectedMask]&&masks[selectedMask].selection?I.canonical([masks[selectedMask].selection]):null);
    if(stamp){try{drafts.set(stamp,E.validateSettings(settingsSnapshot()));preferencesTouched=true;}catch(_){}}
    persistDraft();
  }
  function settings(d){
    // Axis checkboxes lock framing controls only; tracking always follows both axes.
    const prepared=preparedReference(d);
    const refIndex=0,smoothPercent=numeric('smoothWin',0,100),amount=mode==='fixed'?numeric('scalePercent',0,900):mode==='none'?0:20;
    const resetScale=mode==='none';
    const effectiveMode=mode==='none'?'fixed':mode==='fixed'&&amount===0?'none':mode;
    const quality=d&&d.type==='external-face'?{center:'original',filter:'none'}:tools?tools.getQuality():{center:'original',filter:'none'};
    return {destination:$('useTransform').checked?'transform':'motion',W:d.W,H:d.H,fps:d.fps,refIndex,quality:prepared?{center:'original',filter:quality.filter,ignoreFirst:false}:{...quality,ignoreFirst:true},sourceTimes:d.times,sourceSelection:d.selection,replace:true,createNew:false,resetScale,replaceThroughEnd:d.partial===true,limitToTrackedRange:d.partial===true,
      shutterAngle:$('useTransform').checked?numeric('shutterAngle',0,360):0,
      opt:{useX:true,useY:true,...(fillFraming?{guardFill:true}:{}),rotation:false,
        // The preview is absolute frame space. Centering is a UI shortcut, not a tracking reference switch.
        target:{x:d.W/2,y:d.H/2},
        targetOffset:{x:d.W*numeric('offsetX',-50,50)/100,y:d.H*numeric('offsetY',-50,50)/100},
        maxRot:0,deadzone:0,
        smoothWin:C.smoothWindow(smoothPercent,d.fps),anchor:{x:(d.SW||d.W)/2,y:(d.SH||d.H)/2},
        // Quadro do vídeo (rastreio); difere da sequência quando as proporções diferem.
        source:{w:d.SW||d.W,h:d.SH||d.H},
        // EXPERIMENTAL e desligado por padrão: só existe na especificação quando ligado (assinaturas antigas inalteradas).
        ...($('tremorFilter').checked?{tremor:C.tremorOptions({fps:d.fps,frameHeight:d.SH||d.H,times:d.times,sampling:d})}:{}),
        scaleMode:effectiveMode,scalePercent:amount,...(mode==='auto'?{minimumCover:true,autoLimit:false,maxScale:10}:{maxScale:10}),frame:{w:d.W,h:d.H}}};
  }
  function showResult(keys){updateZoom();for(const warning of keys.meta.verificationWarnings||[])log('AVISO DE CONFERÊNCIA: '+warning);if(keys.meta.clamped)log('AVISO: limite de zoom atingido; confira o enquadramento.');if(keys.meta.diagnosticWarning)log('AVISO: rastreamento aplicado e conferido, mas o registro não pôde ser salvo: '+keys.meta.diagnosticWarning);}
  const boundaryNotice=d=>E.analyze(d).warnings.filter(w=>w.end>d.times[1]+1e-7).slice(0,2).map(w=>w.kind+' em '+Math.max(0,w.end-(d.selection?.inPoint??d.times[0])).toFixed(2).replace('.',',')+' s do trecho').join('; ');
  const readNotice=d=>(d.partial?'Máscara lida de '+d.times[0].toFixed(2).replace('.',',')+' a '+d.lastTrackedTime.toFixed(2).replace('.',',')+' s.':'Máscara lida. Clique em Aplicar e confira no Monitor do Programa; Ctrl+Z desfaz.')+(boundaryNotice(d)?' Aviso: '+boundaryNotice(d)+'. Confira no vídeo.':'');
  $('btnReadMask').addEventListener('click',()=>run(async()=>{const d=await readSavedMasks();const partialCount=batchMasks.filter(m=>m.partial).length;navigateTask('frame');status(partialCount?'Máscaras parciais em '+partialCount+' de '+batchMasks.length+' trechos.':readNotice(d));}));
  $('maskSelect').addEventListener('change',()=>run(async()=>{selectedMask=$('maskSelect').selectedIndex;const selected=masks[selectedMask];if(selected){const stored=await workflow.load(selected.selection);trajectoryNeedsConfirmation=!stored?.confirmed;const old=await workflow.state(selected.selection);await workflow.saveState(selected.selection,{...old,chosenMaskKey:selected.maskKey||selected.maskId||selected.name});}showMask();}));
  // Aplicação como promessa: quem precisa saber o fim real (motor de rosto)
  // aguarda applyNow() ou recebe o resultado em onApplyFinished; não depende de
  // click()/eventos DOM, que no UXP não esperam o handler.
  const applyListeners=[];let applyOutcome=null;
  async function applyNow(){
    if(busy)return {ok:false,skipped:true,selections:[],items:[]};
    applyOutcome=null;await run(applyFlow);
    const outcome=applyOutcome||{ok:false,error:true,selections:[],items:[]};
    for(const fn of applyListeners){try{await fn(outcome);}catch(_){}}
    return outcome;
  }
  $('btnApply').addEventListener('click',()=>applyNow());
  async function applyFlow(){
    let first=await ensureTrajectories();
    const sourceNotice=sourceConflict();if(sourceNotice)throw Error(sourceNotice);
    // Velocidade trocada depois da análise: refaz a análise na velocidade escolhida, com a mesma pessoa, e aplica o trajeto novo.
    if(tools&&typeof tools.speedMismatch==='function'){
      const pending=(batchMasks.length?batchMasks:[first]).filter(d=>tools.speedMismatch(d));
      if(pending.length&&batchMasks.length)throw Error(tools.speedMismatch(pending[0]));
      if(pending.length){
        status('Refazendo a análise em '+tools.speedLabel()+' com a mesma pessoa…');log('VELOCIDADE: trajeto analisado em outra velocidade; nova análise antes de aplicar.');
        await tools.reanalyze();
        first=await ensureTrajectories();
        if(tools.speedMismatch(first))throw Error('A nova análise não terminou. Confira o aviso e aplique de novo.');
      }
    }
    if(trajectoryNeedsConfirmation){const selected=batchMasks.length?batchMasks:[first];for(const d of selected)await workflow.confirm(d.selection);trajectoryNeedsConfirmation=false;log('ORIGEM: aplicar o trajeto salvo escolhido pelo botão de aplicação.');}
    const jobs=[],globalSettings=settingsSnapshot();
    for(const d of batchMasks.length?batchMasks:[first]){
      const saved=await workflow.state(d.selection),individual=!!(batchMasks.length&&saved.override&&saved.settings);
      const snapshot=individual?E.validateSettings(saved.settings):globalSettings;
      try{if(individual)restoreSettings(snapshot);
      const spec=settings(d);
      jobs.push({d,s:spec,ui:I.clone(snapshot),override:individual});}finally{restoreSettings(globalSettings);}
    }
    workflow.resetCancel();batchRunning=true;controls();const batchStarted=Date.now();
    const result=await require('./batch.js').createBatch(repository).execute(jobs,{
      canceled:()=>workflow.canceled,
      skip:async({d,s,ui})=>{if(!await workflow.shouldSkip(d,s))return false;const saved=await workflow.state(d.selection);await workflow.saveState(d.selection,{...saved,settings:ui});log('RETOMADA: '+d.selection.name+' conferido sem regravar.');return true;},
      onProgress:record=>{const done=record.items.filter(i=>i.status==='verified').length;status('Lote: '+done+'/'+record.items.length+' conferidos.');},
      apply:async({d,s,ui})=>{
        // A falha do take vai para o lote só com a mensagem; a pilha fica no registro para localizar a origem.
        const keys=await timed('aplicarEVerificar',()=>workflow.apply(d,s,ui)).catch(error=>{if(error?.code==='ANCHOR_DESTINATION_SWITCH')error.message='Este take já usa Movimento. Selecione Movimento em Destino para atualizar o rastreamento. Nada foi alterado.';if(error?.anchor?.needsReview){applicationUncertain=true;appliedSelection=null;appliedKnown=null;}log('ERRO NO TAKE '+d.selection.name+': '+(error&&error.message)+(error&&error.code?' ['+error.code+']':'')+(error&&error.stack?' | '+String(error.stack).split('\n').slice(0,6).join(' / '):''));throw error;});showResult(keys);
        if(keys.meta.managementWarning)log('AVISO: '+keys.meta.managementWarning);
        if(keys.meta.timings)log('TEMPOS DO TAKE (ms): '+JSON.stringify(keys.meta.timings));if(keys.meta.keyframeMetrics)log('KEYFRAMES DO TAKE: '+JSON.stringify(keys.meta.keyframeMetrics));
        const appliedState=await workflow.state(d.selection);rememberLegacyNotice(d.selection,appliedState,batchMasks.length>0);const verified=appliedState.status==='verified';applicationUncertain=!verified;appliedSelection=verified?I.canonical(d.selection):null;unapplied.delete(I.canonical(d.selection));appliedKnown=verified?true:null;// aplicação normal: não é "refeito"
        let residual=0;(keys.meta.measuredRows||d.rows).forEach((row,i)=>{const actual=C.applyTransform([row],keys[i])[0],target=keys.meta.target;residual=Math.max(residual,Math.abs(actual.x-target.x),Math.abs(actual.y-target.y));});
        try{await checkpoint('VERIFICAÇÃO DO ALVO: '+keys.meta.target.x.toFixed(2)+', '+keys.meta.target.y.toFixed(2)+' px; desvio calculado máximo '+residual.toFixed(4)+' px; suavização '+s.opt.smoothWin+(s.opt.tremor?'; redução de tremor (experimental) na posição, '+s.opt.tremor.breaks.length+' quebra(s) de tempo':'')+'.');}catch(error){log('AVISO: aplicado, mas o registro final falhou: '+error.message);}
        return {needsReview:(await workflow.state(d.selection)).status!=='verified',warning:[keys.meta.managementWarning,keys.meta.diagnosticWarning,...(keys.meta.verificationWarnings||[]),keys.meta.clamped?'Limite de zoom atingido':null,boundaryNotice(d)?'Máscara: '+boundaryNotice(d)+'. Confira no vídeo.':null].filter(Boolean).join(' ')||null};
      }
    });
    metrics.loteTotal=Date.now()-batchStarted;log('LOTE: '+JSON.stringify(result));
    const done=result.items.filter(i=>i.status==='verified').length,failed=result.items.filter(i=>['failed','needs-review'].includes(i.status));
    applyOutcome={ok:!failed.length&&result.status!=='canceled'&&done===jobs.length,status:result.status,done,total:jobs.length,selections:jobs.map(job=>job.d.selection),items:result.items};
    if(result.status==='canceled')status('Lote cancelado entre takes: '+done+' de '+jobs.length+' conferidos.');
    // Mensagens curtas: com um take só, o erro dele basta; com vários, a contagem vem antes.
    else if(failed.length){const motivo=failed[0].error||failed[0].warning||'Veja o registro.';status(jobs.length===1?motivo:failed.length+' de '+jobs.length+' trechos não aplicados. '+motivo,true);}
    else status(jobs.length===1&&jobs[0].d.partial?'Aplicado de '+jobs[0].d.times[0].toFixed(2).replace('.',',')+' a '+jobs[0].d.lastTrackedTime.toFixed(2).replace('.',',')+' s; fora disso, enquadramento mantido.':'Rastreamento aplicado'+(done>1?' em '+done+' trechos':'')+'.');
    if(!failed.length&&result.status!=='canceled'){const avisos=result.items.filter(i=>i.warning);if(avisos.length)status($('status').textContent+' Aviso: '+avisos[0].warning);}
  }
  $('modeAuto').addEventListener('click',()=>chooseMode('auto'));$('modeFixed').addEventListener('click',()=>chooseMode('fixed'));$('modeNone').addEventListener('click',()=>chooseMode('none'));
  for(const id of ['useRot','useTransform','tremorFilter','useX','useY'])$(id).addEventListener('change',controls);
  $('centerTarget').addEventListener('change',()=>{if($('centerTarget').checked){$('offsetX').value='0';$('offsetY').value='0';}updateTarget();});
  $('btnResetOffset').addEventListener('click',()=>{if($('useX').checked)$('offsetX').value='0';if($('useY').checked)$('offsetY').value='0';$('centerTarget').checked=false;controls();updateTarget();status('Alvo centralizado. Reaplique para atualizar o vídeo.');});
  $('btnResetZoom').addEventListener('click',()=>{chooseMode('auto');status('Zoom restaurado para Automático. Reaplique para atualizar.');});
  const limitSmoothing=()=>{const value=Number(String($('smoothWin').value).trim().replace(',','.'));if(Number.isFinite(value)&&String($('smoothWin').value).trim()!=='')$('smoothWin').value=String(Math.max(0,Math.min(100,value)));ui.sync();};
  $('smoothWin').addEventListener('input',limitSmoothing);$('smoothWin').addEventListener('change',limitSmoothing);$('smoothWin').addEventListener('blur',limitSmoothing);
  $('scalePercent').addEventListener('input',updateZoom);$('scalePercent').addEventListener('change',updateZoom);
  for(const id of ['offsetX','offsetY']){const moved=()=>{$('centerTarget').checked=false;updateTarget();};$(id).addEventListener('input',moved);$(id).addEventListener('change',moved);}
  function selectTarget(e){if(busy||$('targetFrame').disabled)return;fillFraming=false;const r=$('targetFrame').getBoundingClientRect();if(!Number.isFinite(e.clientX)||!Number.isFinite(e.clientY))return;$('centerTarget').checked=false;if($('useX').checked)$('offsetX').value=String(Math.max(-50,Math.min(50,Math.round((e.clientX-r.left)/r.width*100-50))));if($('useY').checked)$('offsetY').value=String(Math.max(-50,Math.min(50,Math.round((e.clientY-r.top)/r.height*100-50))));updateTarget();persistDraft();if(tools&&tools.framingChanged)try{tools.framingChanged();}catch(_){}}
  let draggingTarget=false;
  $('targetFrame').addEventListener('click',selectTarget);
  $('targetFrame').addEventListener('mousedown',e=>{if(busy||$('targetFrame').disabled)return;e.preventDefault();draggingTarget=true;selectTarget(e);});
  document.addEventListener('mousemove',e=>{if(e.buttons===0)draggingTarget=false;else if(draggingTarget)selectTarget(e);});
  document.addEventListener('mouseup',()=>{draggingTarget=false;});
  document.addEventListener('mouseleave',()=>{draggingTarget=false;});
  if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('blur',()=>{draggingTarget=false;});
  if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('resize',updateTarget);
  document.addEventListener('anchor-task-change',event=>{taskRevision++;if(event.detail?.id==='frame')updateTarget();});// 0.9.45: página única; a rolagem vai até a seção (ui.js)
  for(const id of ['maxRot','deadzone']){
    $(id+'Slider').addEventListener('input',()=>{$(id).value=$(id+'Slider').value;ui.sync();});
    const syncRotation=()=>{const n=Number(String($(id).value).replace(',','.'));if(Number.isFinite(n))$(id+'Slider').value=String(Math.max(0,Math.min(180,n)));ui.sync();};
    $(id).addEventListener('input',syncRotation);$(id).addEventListener('change',syncRotation);
  }
  $('btnProperties').addEventListener('click',()=>{$('properties').className=$('properties').className.includes('hidden')?'':'hidden';});
  $('btnAdvanced').addEventListener('click',()=>{const expanded=$('advanced').className.includes('hidden');$('advanced').className=expanded?'section':'section hidden';$('btnAdvanced').setAttribute('aria-expanded',String(expanded));$('btnAdvanced').querySelector('.chevron').setAttribute('src',expanded?'icons/chevron-down.svg':'icons/chevron-right.svg');});
  $('btnTransformTarget').addEventListener('click',async()=>{const info=$('transformTarget'),button=$('btnTransformTarget');if(!info.className.includes('hidden')){info.className='help target-info hidden';button.setAttribute('aria-expanded','false');return;}info.className='help target-info';button.setAttribute('aria-expanded','true');info.textContent='Verificando trecho…';try{const selectedItems=engine.selections?await engine.selections():[await engine.selection()];const selected={name:selectedItems.map(item=>item.name).join(', ')};info.textContent='(Trecho — '+selected.name+')';}catch(error){info.textContent=error.message;}});
  $('btnCopyLog').addEventListener('click',async()=>{try{await navigator.clipboard.setContent({'text/plain':$('log').value||''});status('Registro copiado para a área de transferência.');}catch(error){status('Não foi possível copiar o registro: '+error.message,true);}});

  const manualFraming=()=>{if(!restoring)fillFraming=false;};
  for(const id of ['offsetX','offsetY','smoothWin','scalePercent','maxScale','maxRot','deadzone','useRot','tremorFilter','useTransform','centerTarget'])for(const type of ['input','change'])$(id).addEventListener(type,manualFraming);
  for(const id of ['modeAuto','modeFixed','modeNone','btnResetOffset','btnResetZoom','targetFrame'])$(id).addEventListener('click',manualFraming);
  // 1.4.1: travas de eixo e obturador saíram da tela. O formato salvo continua igual (eixos livres,
  // obturador 0), para predefinições e ajustes antigos seguirem válidos nos dois sentidos.
  const settingIds=['offsetX','offsetY','smoothWin','scalePercent','maxScale','maxRot','deadzone','shutterAngle'];
  const checkIds=['useRot','centerTarget','useX','useY'];
  const FIXED_FIELDS={},FIXED_CHECKS={setShutter:false,useRot:false};
  // tremorFilter só entra no instantâneo quando ligado: ajustes antigos e os de agora com ele desligado ficam idênticos.
  function settingsSnapshot(){return {version:1,mode,...(fillFraming?{guardFill:true}:{}),fields:{...Object.fromEntries(settingIds.map(id=>[id,$(id).value])),...FIXED_FIELDS},checks:{...Object.fromEntries(checkIds.map(id=>[id,$(id).checked])),...FIXED_CHECKS,...($('tremorFilter').checked?{tremorFilter:true}:{})},quality:tools?tools.getQuality():{center:'original',filter:'none'}};}
  function restoreSettings(snapshot){if(!snapshot||snapshot.version!==1)return;restoring=true;try{if(tools)tools.setQuality(snapshot.quality);for(const id of settingIds)if(snapshot.fields&&snapshot.fields[id]!==undefined)$(id).value=String(snapshot.fields[id]);for(const id of checkIds)if(snapshot.checks&&typeof snapshot.checks[id]==='boolean')$(id).checked=snapshot.checks[id];$('useRot').checked=false;$('tremorFilter').checked=snapshot.checks?.tremorFilter===true;if(['auto','fixed','none'].includes(snapshot.mode))chooseMode(snapshot.mode);for(const id of ['maxRot','deadzone'])$(id+'Slider').value=String(Math.max(0,Math.min(180,Number(String($(id).value).replace(',','.')))));fillFraming=snapshot.guardFill===true;controls();updateTarget();}finally{restoring=false;}}
  function displayGroups(groups){
    fillFraming=false;
    trajectoryNeedsConfirmation=false;
    masks=groups[0];batchMasks=groups.length>1?groups.map(g=>g[0]):[];selectedMask=Math.min(selectedMask,Math.max(0,masks.length-1));
    const options=$('maskOptions');
    if(masks.length>1&&document.createElement){while(options.firstChild)options.removeChild(options.firstChild);for(const mask of masks){const item=document.createElement('sp-menu-item');item.textContent=mask.name;options.appendChild(item);}$('maskSelect').selectedIndex=selectedMask;}
    $('maskChooser').className=masks.length>1?'':'hidden';showMask();
    if(batchMasks.length){$('sourceInfo').textContent=batchMasks.length+' trechos selecionados';$('maskInfo').textContent='Trajetos armazenados · configurações comuns';}
  }
  async function batchChoices(groups){
    const selected=[];
    for(const group of groups){
      const saved=await workflow.state(group[0].selection);
      rememberLegacyNotice(group[0].selection,saved,groups.length>1);
      if(groups.length===1||group.length===1){selected.push(group);continue;}
      const key=saved.chosenMaskKey||saved.maskKey,mask=group.find(m=>(m.maskKey||m.maskId||m.name)===key);if(!mask)throw Error(group[0].selection.name+': há mais de uma máscara. Selecione este take sozinho e escolha a máscara antes de montar o lote.');selected.push([mask]);
    }
    return selected;
  }
  function restoreMaskChoice(saved){const key=saved.chosenMaskKey||saved.maskKey;if(!key||masks.length<2)return;const index=masks.findIndex(m=>(m.maskKey||m.maskId||m.name)===key);if(index<0){trajectoryNeedsConfirmation=true;throw Error('A máscara usada anteriormente não pôde ser identificada. Escolha a máscara novamente.');}selectedMask=index;$('maskSelect').selectedIndex=index;showMask();}
  async function ensureTrajectories(){
    const selected=engine.selections?await engine.selections():[await engine.selection()];
    const existing=batchMasks.length?batchMasks.map(d=>d.selection):masks.length?[masks[selectedMask].selection]:[];
    if(existing.length===selected.length&&I.canonical(existing)===I.canonical(selected))return masks[selectedMask];
    throw Error('A seleção mudou. Aguarde o reconhecimento do take e aplique novamente.');
  }

  async function refreshSelection(isCurrent=()=>true,force=false){
    if(!startup.active||busy||!engine)return;
    const callerCurrent=isCurrent,request=++selectionReadEpoch;isCurrent=()=>callerCurrent()&&request===selectionReadEpoch;
    let selected,appliedMissing=false;
    try{selected=engine.selections?await engine.selections():[await engine.selection()];}catch(e){if(isCurrent()){lastSelected=null;if(selectionStamp&&masks.length)drafts.set(selectionStamp,settingsSnapshot());selectionStamp=null;clearMasks();controls();status(e.message);if(tools&&tools.selectionChanged){const text=String(e&&e.message||e).trim(),selectionKnown=/^(Abra um projeto no Premiere\.|Abra uma sequência\.|Selecione um take na timeline\.|Selecione pelo menos um clipe de vídeo\.|Selecione um clipe de vídeo(?: com Movimento na timeline)?\.)$/i.test(text);tools.selectionChanged(null,{selectionKnown});}}return;}
    const stamp=I.canonical(selected);
    if(!isCurrent())return;
    if(!force&&stamp===selectionStamp&&!selectionLoading)return;
    appliedKnown=null;// só depois de saber que é outra leitura (a mesma seleção não apaga o que já se sabe)
    if(selectionStamp&&masks.length)drafts.set(selectionStamp,settingsSnapshot());
    const stored=await Promise.all(selected.map(s=>workflow.load(s)));
    if(!isCurrent()||busy)return;
    selectionLoading=true;selectionStamp=stamp;clearMasks();
    $('sourceInfo').textContent=selected.length===1?selected[0].name:selected.length+' trechos selecionados';
    if(stored.every(Boolean)){
      const chosen=await batchChoices(stored.map(d=>d.masks));if(!isCurrent()||busy)return;displayGroups(chosen);
      trajectoryNeedsConfirmation=stored.some(d=>!d.confirmed);
      const saved=await workflow.state(selected[0]);if(!isCurrent()||busy)return;
      if(selected.length===1&&['needs-review','running'].includes(saved.status))applicationUncertain=true;
      if(selected.length===1)restoreMaskChoice(saved);
      if(selected.length===1&&saved.status==='verified')appliedSelection=I.canonical(selected[0]);
      adjustedKeys.clear();if(selected.length===1&&saved.status==='adjusted'&&saved.managedReceipt)adjustedKeys.add(I.canonical(selected[0]));
      // Trajeto novo guardado e ainda não aplicado (vale também depois de recarregar o painel).
      if(selected.length===1&&saved.pendingNew&&saved.managedReceipt&&saved.status!=='verified')unapplied.add(I.canonical(selected[0]));
      // Ctrl+Z não avisa o painel: confere se os keyframes ainda estão no efeito.
      if(selected.length===1&&saved.status==='verified'&&saved.managedReceipt&&engine.appliedCheck){
        let check=null;try{check=await engine.appliedCheck(selected[0],saved.managedReceipt,saved.lastRun&&saved.lastRun.keyframes&&saved.lastRun.keyframes.after);}catch(_){check=null;}
        if(!isCurrent()||busy)return;
        appliedKnown=check&&typeof check.present==='boolean'?check.present:null;applicationUncertain=appliedKnown===null;if(applicationUncertain)appliedSelection=null;if(check&&check.present===false){appliedSelection=null;appliedMissing=true;log('APLICAÇÃO AUSENTE: '+selected[0].name+' · '+presenceDetail(check,saved.lastRun&&saved.lastRun.keyframes&&saved.lastRun.keyframes.after)+' (desfeito ou removido).');}
      }
      if(drafts.has(stamp))restoreSettings(drafts.get(stamp));else if(selected.length===1&&saved.settings)restoreSettings(saved.settings);
      if(!(tools&&tools.running))status(applicationUncertain?'Não foi possível confirmar a aplicação atual. Confira o clipe no Premiere.':appliedMissing?'O resultado aplicado foi alterado ou desfeito no Premiere. Clique em Aplicar para aplicar estes ajustes de novo.':stored.some(d=>!d.confirmed)?(masks[selectedMask]?.type==='external-face'?'Trajeto salvo. Analise de novo se o trecho mudou.':'Trajeto salvo. Releia a máscara se ela mudou.'):'Trajeto disponível nesta sessão.',appliedMissing||applicationUncertain);
    }else{let visible=null;if(engine.selectionSummary)try{visible=await engine.selectionSummary();}catch(_){}if(!isCurrent()||busy)return;$('maskInfo').textContent=visible&&visible.some(item=>item.visibleMasks>0)?'Há máscara exposta pela API. Clique em Ler máscara para extrair o movimento.':'Máscaras ainda não conferidas. Clique em Ler máscara.';if(!(tools&&tools.running))status('Seleção reconhecida. Nenhum projeto foi salvo para esta consulta.');}
    selectionLoading=false;lastSelected=selected;controls();
    if(tools&&tools.selectionChanged)tools.selectionChanged(selected,{appliedMissing,appliedUncertain:applicationUncertain,appliedPresent:!appliedMissing&&appliedKnown===true});
  }
  // Ctrl+Z/Ctrl+Shift+Z no Premiere não geram evento para o painel. Ao voltar o
  // ponteiro para o painel, confere o recibo dos canais gerenciados
  // do take (leitura, sem alterar nada). Se o evento não existir no
  // host, a conferência acontece ao selecionar o take de novo ou em "Conferir seleção sem salvar" (Opções de leitura).
  let recheckAt=0,recheckRunning=false;
  const presenceDetail=(check,expected)=>check.reason==='effect'?'efeito anterior ausente':check.keys==null?(check.present?'valores conferidos':'estado anterior conferido'):'keyframes '+check.keys+(expected?' de '+expected:'');
  async function recheckApplied(){
    const now=Date.now();if(!startup.active||busy||recheckRunning||!engine||!engine.appliedCheck||now-recheckAt<1500)return;
    recheckAt=now;recheckRunning=true;
    try{
      // The host can miss activation/selection events while the panel is
      // hidden or a project is reopening. Re-read identity on panel entry;
      // an unchanged selection keeps its draft and avoids another load.
      const previousStamp=selectionStamp;await refreshSelection();
      if(busy||selectionStamp!==previousStamp)return;
      const selected=lastSelected;if(!selected||selected.length!==1||I.canonical(selected)!==selectionStamp)return;
      const saved=await workflow.state(selected[0]);if(busy||I.canonical(selected)!==selectionStamp||saved.status!=='verified'||!saved.managedReceipt)return;
      const expected=saved.lastRun&&saved.lastRun.keyframes&&saved.lastRun.keyframes.after;
      let check=null;try{check=await engine.appliedCheck(selected[0],saved.managedReceipt,expected);}catch(_){check={present:null,reason:'host'};}
      if(busy||I.canonical(selected)!==selectionStamp)return;
      if(!check||typeof check.present!=='boolean'){
        if(applicationUncertain)return;
        applicationUncertain=true;appliedKnown=null;appliedSelection=null;
        status('Não foi possível confirmar a aplicação atual. Confira o clipe no Premiere.',true);controls();
        if(tools&&tools.selectionChanged)tools.selectionChanged(selected,{appliedUncertain:true});
        return;
      }
      if(check.present===appliedKnown&&!applicationUncertain)return;
      const wasUncertain=applicationUncertain;applicationUncertain=false;
      // "Refeito" só quando os keyframes tinham sumido (desfazer) e voltaram.
      if(check.present&&appliedKnown!==false&&!wasUncertain){appliedKnown=true;return;}
      appliedKnown=check.present;
      if(!check.present){appliedSelection=null;log('APLICAÇÃO DIVERGENTE: '+selected[0].name+' · '+presenceDetail(check,expected)+' (alterada ou desfeita).');status('O resultado aplicado foi alterado ou desfeito no Premiere. Clique em Aplicar para aplicar estes ajustes de novo.',true);}
      else{appliedSelection=I.canonical(selected[0]);log('APLICAÇÃO PRESENTE DE NOVO: '+selected[0].name+' · '+presenceDetail(check)+(wasUncertain?' (conferido).':' (refeito).'));status(wasUncertain?'Aplicação atual conferida.':'O rastreamento deste take voltou ao take (refeito).');}
      controls();persistLog().catch(()=>{});
      if(tools&&tools.selectionChanged)tools.selectionChanged(selected,{appliedMissing:!check.present,appliedPresent:check.present});
    }finally{recheckRunning=false;}
  }
  try{document.addEventListener('mouseover',event=>{
    const from=event&&event.relatedTarget;
    if(from&&document.documentElement&&document.documentElement.contains(from))return;
    recheckApplied().catch(error=>log('SELEÇÃO: '+error.message));
  });}catch(_){}
  try{window.addEventListener('focus',()=>recheckApplied().catch(error=>log('SELEÇÃO: '+error.message)));}catch(_){}
  $('btnUseSaved').addEventListener('click',()=>run(async()=>{
    const selected=await engine.selections(),stored=await Promise.all(selected.map(s=>workflow.confirm(s)));
    displayGroups(await batchChoices(stored.map(d=>d.masks)));const saved=await workflow.state(selected[0]);if(selected.length===1)restoreMaskChoice(saved);
    trajectoryNeedsConfirmation=false;
    status('Usando o trajeto salvo por sua escolha. Alterações posteriores na máscara não estão incluídas.');
  }));
  $('btnRefreshSelection').addEventListener('click',async()=>{if(busy)return;try{await refreshSelection(()=>true,true);}catch(error){clearMasks();controls();status(error.message,true);log('SELEÇÃO: '+error.message);}});
  $('btnChooseProject').addEventListener('click',()=>run(async()=>{const d=await readSavedMasks(true);navigateTask('frame');status(readNotice(d));}));
  $('btnCancelBatch').addEventListener('click',()=>{workflow.cancel();status('Cancelamento solicitado. O take atual será concluído e conferido.');});
  $('btnDiagnose').addEventListener('click',()=>run(async()=>{const result=await require('./diagnostics.js').collectSelection(engine,workflow);await checkpoint('DIAGNÓSTICO: '+JSON.stringify({...result.data,temposMs:metrics}));status('Diagnóstico de '+result.data.takes+' take(s) registrado. Veja Diagnóstico e registro no fim do painel.');}));

  function currentMask(){const d=masks[selectedMask];if(!d||batchMasks.length)throw Error('Selecione e carregue um único take para esta ferramenta.');return d;}

  tools=require('./tools-panel.js').initializeTools({$,document,engine,workflow,repository,run,status,log,navigateTask,revealTaskFor,faceOptions:typeof AnchorFaceOptions!=='undefined'?AnchorFaceOptions:undefined,persistLog,applyTrajectory:applyNow,onStateChanged,onApplyFinished:fn=>applyListeners.push(fn),framingSpec,setFraming,markUnapplied,framingSummary,invalidateFraming:()=>{fillFraming=false;},updateCard:()=>updateCard(),currentMask,settingsSnapshot,restoreSettings,displayGroups,restoreMaskChoice,refreshControls:controls,refreshSelection,readMetrics:()=>({...metrics}),projectMetadata:async()=>{if(!projectFile)return {};try{const metadata=await projectFile.getMetadata();return {projectFileBytes:metadata.size};}catch(_){return {};}}});
  function disposePanel(){if(panelDisposed)return;panelDisposed=true;if(draftTimer!==null){clearTimeout(draftTimer);draftTimer=null;}if(selectionWatcher){selectionWatcher.dispose();selectionWatcher=null;}if(tools&&typeof tools.dispose==='function')tools.dispose();}
  if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('unload',disposePanel);
  function persistDraft(){
    if(panelDisposed||restoring||busy)return;preferencesTouched=true;
    if(tools){tools.syncAvailability(false,masks.length>0&&!batchMasks.length);ui.sync();}
    if(draftTimer)clearTimeout(draftTimer);
    let value;try{value=E.validateSettings(settingsSnapshot());}catch(_){return;}
    // Capture this take and its values now; the user may switch takes before the timer fires.
    const stamp=selectionStamp;if(stamp)drafts.set(stamp,value);
    draftTimer=setTimeout(async()=>{draftTimer=null;if(panelDisposed)return;try{await repository.write('preferences:framing:v1',value);}catch(error){log('PREFERÊNCIAS: '+error.message);}},300);
  }
  for(const id of [...settingIds,...checkIds,'tremorFilter','maxRotSlider','deadzoneSlider','btnResetOffset','btnResetZoom','modeAuto','modeFixed','modeNone','centerOriginal','centerArea','qualityOriginal','qualityAdaptive','qualityOutliers']){ $(id).addEventListener('change',persistDraft);$(id).addEventListener('input',persistDraft);$(id).addEventListener('click',persistDraft);}

  // 0.9.45: destino de aplicação (desligado = Movimento). Fica gravado como preferência do editor.
  const TRANSFORM_KEY='preferences:apply-transform';let transformTouched=false;
  $('useTransform').addEventListener('change',()=>{transformTouched=true;const on=$('useTransform').checked;log('DESTINO: '+(on?'efeito Transformar do Dynamic Anchor':'Movimento')+' (próximas aplicações).');repository.write(TRANSFORM_KEY,{on}).catch(error=>log('PREFERÊNCIAS: '+error.message));});
  ready.then(async()=>{try{const saved=await repository.read(TRANSFORM_KEY);if(panelDisposed)return;if(!transformTouched&&saved&&saved.payload&&saved.payload.on===true){$('useTransform').checked=true;$('useTransform').setAttribute('aria-checked','true');controls();}}catch(_){}});
  ready.then(async()=>{try{const saved=await repository.read('preferences:framing:v1');if(panelDisposed)return;if(saved&&!busy&&!selectionStamp&&!preferencesTouched)restoreSettings(E.validateSettings(saved.payload));}catch(error){log('PREFERÊNCIAS: '+error.message);}});


  if(native&&typeof setTimeout==='function')startup.onActive(()=>{
    selectionWatcher=require('./selection-watch.js').watchSelection(require('premierepro'),{onChange:async isCurrent=>{await refreshSelection(isCurrent);if(isCurrent()&&window.AnchorBancada)await window.AnchorBancada.refresh();},onDirty:async()=>{if(busy)return;workflow.invalidateAll();if(masks.length){trajectoryNeedsConfirmation=true;controls();status('Projeto alterado. Aplicar usará o trajeto salvo; atualize a leitura se mudou a máscara.');}},onError:e=>log('SELEÇÃO: '+e.message)});
  });

  function notifySequenceFormat(){if(busy||!lastSelected)return;if(tools&&tools.selectionChanged(lastSelected,{formatChanged:true}))status('O formato da sequência mudou. Clique em Analisar rosto para tentar novamente.');controls();}
  if(typeof window!=='undefined')window.AnchorIntegration={get busy(){return busy;},loadedSourceKind(){const d=masks[selectedMask];return d?(d.type==='external-face'?0:1):null;},settingsSnapshot,settingsForTest:settings,updateTarget,refreshSelection,notifySequenceFormat,selectTrackingSource};
  chooseMode('auto');updateTarget();log('Dynamic Anchor 1.7.5. Entrada: máscara rastreada do projeto salvo.');
})();




