'use strict';
const I=require('./integrity.js');
const T=require('./trajectory.js');
function selectionIdentity(selection){
  const one=s=>{try{return T.identity(s);}catch(_){return s;}};
  return Array.isArray(selection)?selection.map(one).sort((a,b)=>I.canonical(a).localeCompare(I.canonical(b))):one(selection);
}
async function collectSelection(engine,workflow){
  const selections=engine.selections?await engine.selections():[await engine.selection()],host=await engine.diagnose(),items=[];
  for(const selection of selections)items.push({selection,...await workflow.diagnostic(selection,{verifyEffect:true})});
  const current=engine.selections?await engine.selections():[await engine.selection()];
  if(I.canonical(selectionIdentity(current))!==I.canonical(selectionIdentity(selections)))throw Error('A seleção mudou durante o diagnóstico. Consulte novamente.');
  const data={...host,hostItems:host.items||[],takes:items.length,trajectories:0,samples:0,activeTrajectoryBytes:0,managedTransformsVerified:0,managementConflicts:0,items,cache:workflow.cacheInfo?workflow.cacheInfo():null};
  for(const item of items){for(const key of ['trajectories','samples','activeTrajectoryBytes'])data[key]+=item[key]||0;if(item.managedVerified===true)data.managedTransformsVerified++;if(item.managedVerified===false)data.managementConflicts++;}
  return {selection:selections.length===1?selections[0]:selections,data};
}
function compare(before,after){
  const delta={};for(const key of ['takes','transforms','managedTransformsVerified','keyframes','animated','accessibleMasks','samples','activeTrajectoryBytes','projectFileBytes'])if(Number.isFinite(before?.[key])&&Number.isFinite(after?.[key]))delta[key]=after[key]-before[key];
  return {before:before||null,after,delta,note:'Contagens e tempos observados. Não medem FPS, memória ou ganho de reprodução. O tamanho corresponde ao arquivo salvo, sem forçar salvamento.'};
}
function createDiagnostics(repository){
  const key=s=>'diagnostic:'+I.digest(selectionIdentity(s));
  return {async snapshot(selection,data){const value={...data,at:new Date().toISOString()};await repository.write(key(selection),{schema:1,data:value});return value;},async compare(selection,data){const old=await repository.read(key(selection))||await repository.read('diagnostic:'+I.digest(selection));return compare(old?.payload?.data,{...data,at:new Date().toISOString()});}};
}
module.exports={compare,createDiagnostics,collectSelection};
