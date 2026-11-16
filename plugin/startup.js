'use strict';
// Restoring a workspace must not start native reads or frame exports.
function createStartupGate(doc){
  let active=false,disposed=false;
  const waiting=new Set();
  const events=['mousedown','keydown','mouseover'];
  function detach(){for(const event of events)doc.removeEventListener(event,activate,true);}
  function activate(){
    if(active||disposed)return;
    active=true;detach();
    // Let the input handler finish before starting background work.
    for(const callback of waiting)Promise.resolve().then(()=>{if(!disposed)return callback();}).catch(error=>console.warn('[Dynamic Anchor] ativação',error));
    waiting.clear();
  }
  for(const event of events)doc.addEventListener(event,activate,true);
  return {
    get active(){return active&&!disposed;},
    onActive(callback){
      if(disposed)return;
      if(active)Promise.resolve().then(()=>{if(!disposed)return callback();}).catch(error=>console.warn('[Dynamic Anchor] ativação',error));
      else waiting.add(callback);
    },
    dispose(){disposed=true;detach();waiting.clear();}
  };
}
const gate=typeof document==='undefined'?null:createStartupGate(document);
if(gate&&typeof window!=='undefined')window.addEventListener('unload',()=>gate.dispose());
module.exports={createStartupGate,gate};
