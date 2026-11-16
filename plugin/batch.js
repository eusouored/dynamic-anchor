'use strict';
const I=require('./integrity.js'),T=require('./trajectory.js');
function createBatch(repository){
  async function execute(jobs,{apply,skip,onProgress=()=>{},canceled=()=>false}){
    if(!Array.isArray(jobs)||!jobs.length)throw Error('Nenhum take no lote.');
    const identify=s=>{try{return T.key(s);}catch(_){return 'session:'+I.digest(s);}};
    const id=I.digest(jobs.map(j=>({selection:j.d.selection,settings:j.s,mask:j.d.maskKey||j.d.name})));
    const key='batch:'+id,record={schema:1,id,startedAt:new Date().toISOString(),status:'running',items:jobs.map(j=>({key:identify(j.d.selection),selection:j.d.selection,mask:j.d.maskKey||j.d.name,override:!!j.override,status:'pending'}))};
    let pointerPublished=false;
    const publish=async()=>{record.updatedAt=new Date().toISOString();await repository.write(key,record);if(!pointerPublished){await repository.write('batch:last',{schema:1,key});pointerPublished=true;}await onProgress(I.clone(record));};
    await publish();
    for(let i=0;i<jobs.length;i++){
      if(canceled()){record.status='canceled';break;}
      const item=record.items[i],job=jobs[i];item.status='running';item.stage='conferindo';await publish();
      try{
        if(await skip(job)){item.status='verified';item.reused=true;item.stage='conferido sem regravar';}
        else{item.stage='aplicando e verificando';await publish();const result=await apply(job);item.status=result?.needsReview?'needs-review':'verified';item.warning=result?.warning||null;item.stage=result?.needsReview?'revisão necessária':'conferido';}
      }catch(error){item.status='failed';item.stage='revisão necessária';item.error=String(error.message||error);}
      await publish();
    }
    if(record.status==='running')record.status=record.items.some(i=>['failed','needs-review'].includes(i.status))?'finished-with-errors':'finished';
    await publish();return I.clone(record);
  }
  async function last(){const pointer=await repository.read('batch:last');if(!pointer)return null;const stored=await repository.read(pointer.payload.key);if(!stored)return null;const record=I.clone(stored.payload);if(record.schema!==1||!Array.isArray(record.items))throw Error('Registro do lote incompatível.');if(record.status==='running'){record.status='interrupted';for(const item of record.items)if(item.status==='running')item.status='needs-review';}return record;}
  return {execute,last};
}
module.exports={createBatch};
