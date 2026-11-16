'use strict';
// 0.9.47: painel enxuto. Ficaram só a ponte com o painel de rosto, os métodos de movimento
// da máscara e a revisão de operação interrompida (contextual). Conferir resultado, correção
// localizada, lote, transferência, predefinições e suporte saíram da tela; dados salvos ficam.
const Q=require('./quality.js');
function initializeTools({$,engine,workflow,repository,run,status,log,refreshControls,faceOptions,persistLog,applyTrajectory,onApplyFinished,onStateChanged,framingSpec,setFraming,markUnapplied,framingSummary,invalidateFraming=()=>{},updateCard,revealTaskFor=()=>{},displayGroups}){
  let disposed=false;const listeners=[];
  const listen=(target,type,handler)=>{target.addEventListener(type,handler);listeners.push([target,type,handler]);};
  const facePanel=require('./face-panel.js').initializeFacePanel({$,engine,workflow,repository,run,status,log,displayGroups,persistLog,applyTrajectory,onApplyFinished,onStateChanged,framingSpec,setFraming,markUnapplied,framingSummary,updateCard,revealTaskFor,...(faceOptions||{})});
  let quality={center:'original',filter:'none'},context=null;
  const METHODS=[['centerOriginal','center','original'],['centerArea','center','area'],['qualityOriginal','filter','none'],['qualityAdaptive','filter','adaptive'],['qualityOutliers','filter','outliers']];
  function qualityUI(){if(disposed)return;for(const [id,k,v]of METHODS){$(id).setAttribute('aria-pressed',String(quality[k]===v));$(id).className='compact-action file-button'+(quality[k]===v?' selected-tool':'');}}
  for(const [id,k,v]of METHODS)listen($(id),'click',()=>{if(disposed)return;invalidateFraming();quality={...quality,[k]:v};qualityUI();refreshControls();status('Método de movimento alterado. Reaplique para atualizar.');});
  listen($('btnRecoverOperation'),'click',()=>{if(disposed)return;return run(async()=>{const selected=await engine.selection(),result=await workflow.recoverOperation(selected);if(!disposed)status(result.message);});});
  function invalidateResults(){if(disposed)return;invalidateFraming();facePanel.framingChanged();}
  function syncAvailability(busy){
    if(disposed)return;
    facePanel.sync(busy);
    $('centerArea').disabled=!!busy||!context||!context.rows.every(row=>Number.isFinite(row.centroidX)&&Number.isFinite(row.centroidY));
  }
  qualityUI();
  function dispose(){if(disposed)return;disposed=true;facePanel.dispose();for(const [target,type,handler]of listeners)try{target.removeEventListener(type,handler);}catch(_){}listeners.length=0;}
  return {selectionChanged:(selected,extra)=>{if(!disposed)facePanel.onSelection(selected,extra);},framingChanged:()=>{if(!disposed)facePanel.framingChanged();},cardState:(selected,base)=>disposed?null:facePanel.cardState(selected,base),currentSelection:()=>facePanel.currentSelection(),dispose,
    getQuality:()=>({...quality}),setQuality(value){if(disposed)return;quality=Q.options(value);qualityUI();},syncAvailability,invalidateResults,
    setContext(data){if(disposed)return;if(data!==context){context=data;invalidateResults();}}};
}
module.exports={initializeTools};
