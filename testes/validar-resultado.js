'use strict';
// Passa resultados do motor (JSON da bancada) pela validação real do painel (face-auto.verify)
// e pela leitura do trajeto (external-track.decode). Uso: node validar-resultado.js <arquivo.json>...
const path=require('path');
const plugin=path.resolve(__dirname,'../plugin');
const A=require(path.join(plugin,'face-auto.js'));
let falhas=0;
const fs=require('fs');
const arquivos=process.argv.slice(2).flatMap(a=>fs.statSync(a).isDirectory()?fs.readdirSync(a).filter(n=>n.endsWith('.json')).map(n=>path.join(a,n)):[a]);
for(const arquivo of arquivos){
 const task=require(path.resolve(arquivo)),result=task.result;
 if(!result){console.log('sem resultado  ',path.basename(arquivo),task.state,task.message||'');continue;}
 // A bancada manda só um nome de seleção; o motor devolve a seleção recebida. Aqui vai a identidade completa, como o painel manda.
 result.selection={name:'Take de teste',start:0,end:result.outPoint-result.inPoint,inPoint:result.inPoint,outPoint:result.outPoint,trackIndex:0,sequenceId:'s',projectGuid:'p',projectPath:'C:/Teste.prproj',projectItemId:'i'};
 const job={requestId:result.requestId,selection:{...result.selection},inPoint:result.inPoint,outPoint:result.outPoint,fps:result.fps,width:result.width,height:result.height,mediaPath:result.mediaPath};
 const passo=result.stats&&result.stats.step;
 try{
  A.verify(result,job,{referencia:'cabeca',passo});
  // Mesma leitura que o painel faz logo depois ('validação do trajeto').
  require(path.join(plugin,'external-track.js')).decode(JSON.stringify(result),job.selection,{width:result.width,height:result.height,fps:result.fps},{confirmed:true});
  const ref=result.trackingReference||{};
  console.log('aceito         ',path.basename(arquivo),'·',ref.method,ref.headFallback?'· rosto no lugar da cabeça':'','· cobertura',result.coverage,'·',result.rows.length,'linhas');
 }catch(error){falhas++;console.log('RECUSADO       ',path.basename(arquivo),'·',error.message);}
}
process.exitCode=falhas?1:0;
