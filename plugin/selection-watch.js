'use strict';
// A small selection fingerprint: no effects, keyframes, media reads or frame exports.
async function selectionStamp(ppro){
  const project=await ppro.Project.getActiveProject();if(!project)return 'no-project';
  const seq=await project.getActiveSequence();if(!seq)return 'no-sequence:'+String(project.guid||project.path||'');
  const items=await(await seq.getSelection()).getTrackItems(),clips=[];
  for(const item of items||[]){
    const [name,track,start,end,input,output,media]=await Promise.all([
      item.getName(),item.getTrackIndex(),item.getStartTime(),item.getEndTime(),item.getInPoint(),item.getOutPoint(),item.getProjectItem()
    ]);
    clips.push([String(await media.getId()),name,track,String(start.ticks??start.seconds),String(end.ticks??end.seconds),String(input.ticks??input.seconds),String(output.ticks??output.seconds)]);
  }
  return JSON.stringify([String(project.guid||project.path||''),String(seq.guid),clips.map(c=>JSON.stringify(c)).sort()]);
}
function watchSelection(ppro,{onChange,onDirty,onError=()=>{},delay=150,schedule=setTimeout,unschedule=clearTimeout,
  canRefresh=()=>true,needsRefresh=()=>false,probe=()=>selectionStamp(ppro),recoveryMs=2500,
  repeat=setInterval,stopRepeat=clearInterval,target=typeof window==='undefined'?null:window,doc=typeof document==='undefined'?null:document}={}){
  const manager=ppro.EventManager,c=ppro.Constants;let timer=null,disposed=false,revision=0,running=false,pending=false;
  const listeners=[];
  const queue=()=>{if(timer!==null)unschedule(timer);timer=schedule(flush,delay);};
  async function flush(){
    timer=null;if(disposed)return;
    if(!canRefresh()){pending=true;return;}
    if(running){pending=true;return;}
    running=true;pending=false;const current=revision;
    try{await onChange(()=>!disposed&&revision===current);}catch(e){if(!disposed)onError(e);}
    finally{running=false;if(pending&&!disposed)queue();}
  }
  const changed=()=>{if(disposed)return;revision++;pending=true;if(!running)queue();};
  const dirty=()=>{if(!disposed)Promise.resolve(onDirty()).catch(onError);};
  function add(event,fn){if(event===undefined||!manager?.addGlobalEventListener)return;try{manager.addGlobalEventListener(event,fn,false);listeners.push([event,fn]);}catch(e){onError(e);}}
  add(c?.SequenceEvent?.SELECTION_CHANGED,changed);add(c?.SequenceEvent?.ACTIVATED,changed);add(c?.ProjectEvent?.ACTIVATED,changed);add(c?.ProjectEvent?.CLOSED,changed);add(c?.ProjectEvent?.DIRTY,dirty);
  let probing=false,lastStamp,probeError=null;
  async function recover(force=false){
    if(disposed||running||probing||!canRefresh())return;
    const current=revision;probing=true;
    try{
      const next=await probe();
      if(disposed||current!==revision||!canRefresh())return;
      probeError=null;
      if(force||pending||needsRefresh()||next!==lastStamp){lastStamp=next;changed();}
    }catch(e){if(!disposed&&String(e.message)!==probeError){probeError=String(e.message);onError(e);}}
    finally{probing=false;}
  }
  const resume=()=>{recover(true);};
  if(target?.addEventListener)target.addEventListener('focus',resume);
  if(doc?.addEventListener)doc.addEventListener('visibilitychange',resume);
  const recoveryTimer=recoveryMs>0?repeat(()=>{recover();},recoveryMs):null;
  // Initial selection also works when this host cannot register selection events.
  changed();
  return {supported:listeners.length>0,refresh:changed,recover,dispose(){if(disposed)return;disposed=true;revision++;if(timer!==null)unschedule(timer);if(recoveryTimer!==null)stopRepeat(recoveryTimer);if(target?.removeEventListener)target.removeEventListener('focus',resume);if(doc?.removeEventListener)doc.removeEventListener('visibilitychange',resume);for(const [event,fn]of listeners)try{manager.removeGlobalEventListener(event,fn,false);}catch(e){onError(e);}listeners.length=0;}};
}
module.exports={watchSelection,selectionStamp};
