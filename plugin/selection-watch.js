'use strict';
// 1.7.6: uma chamada do Premiere que nunca responde (exportar o quadro da prévia enquanto
// o clipe é arrastado, por exemplo) não pode prender o painel. A espera tem limite; o que
// chegar depois é descartado pelas conferências de seleção atual de quem chamou.
const HOST_LIMIT_MS=15000;
function bounded(promise,ms,message,schedule=setTimeout,unschedule=clearTimeout){
  let timer=null;
  const limit=new Promise((_,reject)=>{timer=schedule(()=>{timer=null;const error=new Error(message);error.code='host-timeout';reject(error);},ms);});
  return Promise.race([Promise.resolve(promise),limit]).finally(()=>{if(timer!==null)unschedule(timer);});
}
// A small selection fingerprint: no effects, keyframes, media reads or frame exports.
async function selectionStamp(ppro){
  const project=await ppro.Project.getActiveProject();if(!project)return 'no-project';
  const seq=await project.getActiveSequence();if(!seq)return 'no-sequence:'+String(project.guid||project.path||'');
  const items=await(await seq.getSelection()).getTrackItems();
  // Todos os clipes selecionados ao mesmo tempo (vídeo e áudio vinculado), não um depois do outro.
  const clips=await Promise.all((items||[]).map(async item=>{
    const [name,track,start,end,input,output,media]=await Promise.all([
      item.getName(),item.getTrackIndex(),item.getStartTime(),item.getEndTime(),item.getInPoint(),item.getOutPoint(),item.getProjectItem()
    ]);
    return [String(await media.getId()),name,track,String(start.ticks??start.seconds),String(end.ticks??end.seconds),String(input.ticks??input.seconds),String(output.ticks??output.seconds)];
  }));
  return JSON.stringify([String(project.guid||project.path||''),String(seq.guid),clips.map(c=>JSON.stringify(c)).sort()]);
}
// 1.7.7: com o Premiere ocupado (salvando um projeto grande, por exemplo), cada consulta demora.
// Esgotada a espera, a consulta continua na fila dele; perguntar de novo só aumentava a fila,
// que deixava de esvaziar. Agora há uma leitura por vez: a próxima só sai quando a pendente
// termina, ou depois do limite duro (uma chamada que nunca volta não prende o painel para sempre).
const HARD_LIMIT_MS=60000,SLOW_MS=3000;
function watchSelection(ppro,{onChange,onDirty,onError=()=>{},onStall=()=>{},onSlow=()=>{},delay=150,schedule=setTimeout,unschedule=clearTimeout,
  canRefresh=()=>true,needsRefresh=()=>false,probe=()=>selectionStamp(ppro),recoveryMs=2500,hostLimitMs=HOST_LIMIT_MS,hardLimitMs=HARD_LIMIT_MS,slowMs=SLOW_MS,now=()=>Date.now(),
  repeat=setInterval,stopRepeat=clearInterval,target=typeof window==='undefined'?null:window,doc=typeof document==='undefined'?null:document}={}){
  const manager=ppro.EventManager,c=ppro.Constants;let timer=null,disposed=false,revision=0,running=false,pending=false,stalled=false,quietUntil=0;
  const listeners=[];
  const queue=()=>{if(timer!==null)unschedule(timer);timer=schedule(flush,delay);};
  // O limite usa o relógio real; schedule/unschedule ficam só para o agrupamento dos eventos.
  const wait=(promise,what)=>hostLimitMs>0?bounded(promise,hostLimitMs,'O Premiere não respondeu à '+what+' em '+Math.round(hostLimitMs/1000)+' s. O painel segue acompanhando a seleção.'):promise;
  const setStalled=value=>{if(disposed||stalled===value)return;stalled=value;try{onStall(value);}catch(_){}};
  // Avisa uma vez por sequência de esperas esgotadas; a próxima leitura que responder zera o aviso.
  const failed=e=>{if(disposed)return;if(e&&e.code==='host-timeout'&&stalled)return;onError(e);};
  async function host(what,start){
    const began=now();let job,timedOut=false;
    try{job=Promise.resolve(start());}catch(error){job=Promise.reject(error);}
    try{return await wait(job,what);}
    catch(e){
      if(!(e&&e.code==='host-timeout'))throw e;
      timedOut=true;failed(e);setStalled(true);
      // A consulta pendente ainda ocupa o Premiere: espera por ela antes de liberar outra.
      try{return await bounded(job,Math.max(0,hardLimitMs-hostLimitMs),e.message);}catch(late){throw late&&late.code==='host-timeout'?e:late;}
    }
    finally{const spent=now()-began;if(!disposed&&spent>=slowMs)try{onSlow({what,ms:spent,timedOut});}catch(_){}}
  }
  async function flush(){
    timer=null;if(disposed)return;
    if(!canRefresh()){pending=true;return;}
    if(running){pending=true;return;}
    running=true;pending=false;const current=revision;
    // Se a leitura responder depois do aviso e nada tiver mudado, ela ainda vale;
    // se a seleção mudou, a revisão nova a invalida.
    try{await host('leitura da seleção',()=>onChange(()=>!disposed&&revision===current));setStalled(false);}
    catch(e){if(!(e&&e.code==='host-timeout'))failed(e);}
    finally{running=false;if(pending&&!disposed)queue();}
  }
  const changed=()=>{if(disposed)return;revision++;pending=true;if(!running)queue();};
  const dirty=()=>{if(!disposed)Promise.resolve(onDirty()).catch(onError);};
  function add(event,fn){if(event===undefined||!manager?.addGlobalEventListener)return;try{manager.addGlobalEventListener(event,fn,false);listeners.push([event,fn]);}catch(e){onError(e);}}
  add(c?.SequenceEvent?.SELECTION_CHANGED,changed);add(c?.SequenceEvent?.ACTIVATED,changed);add(c?.ProjectEvent?.ACTIVATED,changed);add(c?.ProjectEvent?.CLOSED,changed);add(c?.ProjectEvent?.DIRTY,dirty);
  let probing=false,lastStamp,probeError=null;
  // true: a seleção mudou, já há uma leitura em andamento ou não deu para conferir (quem chama não lê de novo).
  async function recover(force=false){
    if(disposed||running||probing||!canRefresh())return true;
    // Premiere lento: as conferências periódicas se espaçam (o foco no painel ainda confere na hora).
    if(!force&&now()<quietUntil)return true;
    const current=revision,began=now();probing=true;
    try{
      const next=await host('conferência da seleção',probe);setStalled(false);
      if(disposed||current!==revision||!canRefresh())return true;
      probeError=null;
      if(force||pending||needsRefresh()||next!==lastStamp){lastStamp=next;changed();return true;}
      return false;
    }catch(e){if(!disposed&&!(e&&e.code==='host-timeout')&&String(e.message)!==probeError){probeError=String(e.message);failed(e);}return true;}
    finally{probing=false;const spent=now()-began;quietUntil=spent>500?now()+Math.min(30000,5*spent):0;}
  }
  const resume=()=>{recover(true);};
  if(target?.addEventListener)target.addEventListener('focus',resume);
  if(doc?.addEventListener)doc.addEventListener('visibilitychange',resume);
  const recoveryTimer=recoveryMs>0?repeat(()=>{recover();},recoveryMs):null;
  // Initial selection also works when this host cannot register selection events.
  changed();
  return {supported:listeners.length>0,refresh:changed,recover,get stalled(){return stalled;},get reading(){return running||probing;},dispose(){if(disposed)return;disposed=true;revision++;if(timer!==null)unschedule(timer);if(recoveryTimer!==null)stopRepeat(recoveryTimer);if(target?.removeEventListener)target.removeEventListener('focus',resume);if(doc?.removeEventListener)doc.removeEventListener('visibilitychange',resume);for(const [event,fn]of listeners)try{manager.removeGlobalEventListener(event,fn,false);}catch(e){onError(e);}listeners.length=0;}};
}
module.exports={watchSelection,selectionStamp,bounded,HOST_LIMIT_MS,HARD_LIMIT_MS};
