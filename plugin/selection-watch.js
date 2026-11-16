'use strict';
function watchSelection(ppro,{onChange,onDirty,onError=()=>{},delay=150,schedule=setTimeout,unschedule=clearTimeout}){
  const manager=ppro.EventManager,c=ppro.Constants;let timer=null,disposed=false,revision=0,running=false,pending=false;
  const listeners=[];
  const queue=()=>{if(timer!==null)unschedule(timer);timer=schedule(flush,delay);};
  async function flush(){
    timer=null;if(disposed)return;
    if(running){pending=true;return;}
    running=true;pending=false;const current=revision;
    try{await onChange(()=>!disposed&&revision===current);}catch(e){if(!disposed)onError(e);}
    finally{running=false;if(pending&&!disposed)queue();}
  }
  const changed=()=>{if(disposed)return;revision++;pending=true;if(!running)queue();};
  const dirty=()=>{if(!disposed)Promise.resolve(onDirty()).catch(onError);};
  function add(event,fn){if(event===undefined||!manager?.addGlobalEventListener)return;manager.addGlobalEventListener(event,fn,false);listeners.push([event,fn]);}
  try{add(c?.SequenceEvent?.SELECTION_CHANGED,changed);add(c?.SequenceEvent?.ACTIVATED,changed);add(c?.ProjectEvent?.ACTIVATED,changed);add(c?.ProjectEvent?.CLOSED,changed);add(c?.ProjectEvent?.DIRTY,dirty);}catch(e){onError(e);}
  if(listeners.length)changed();
  return {supported:listeners.length>0,refresh:changed,dispose(){disposed=true;revision++;if(timer!==null)unschedule(timer);for(const [event,fn]of listeners)manager.removeGlobalEventListener(event,fn);listeners.length=0;}};
}
module.exports={watchSelection};
