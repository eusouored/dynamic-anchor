'use strict';
// 1.7.6: o Premiere às vezes não devolve uma chamada (exportar o quadro da prévia enquanto um
// clipe é arrastado, por exemplo). O painel tem de continuar reconhecendo a seleção.
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const {launch,open}=require('./harness');
const nome=()=>document.getElementById('takeName').textContent;
(async()=>{const browser=await launch();const report=[];try{
 const {page,errors}=await open(browser,{selection:'none',status:'ready'});
 await page.evaluate(()=>{
  const t=__test,p=require('premierepro'),preview=require('./preview-host.js');t.captures=[];
  p.Project.getActiveProject=async()=>({guid:'project',getActiveSequence:async()=>({guid:'sequence',getSelection:async()=>({getTrackItems:async()=>t.selection==='single'?[{
   getName:async()=>t.take.name,getTrackIndex:async()=>0,getStartTime:async()=>({seconds:t.take.start}),getEndTime:async()=>({seconds:t.take.end}),getInPoint:async()=>({seconds:t.take.inPoint}),getOutPoint:async()=>({seconds:t.take.outPoint}),getProjectItem:async()=>({getId:()=>t.take.projectItemId})
  }]:[]})})});
  const read=preview.read;preview.read=async(...args)=>({...await read(...args),key:t.selection==='single'?t.take.projectItemId:null});
  // A exportação do primeiro quadro nunca volta.
  preview.capture=async()=>{t.captures.push(t.take.name);return new Promise(()=>{});};
  const selections=t.engine.selections.bind(t.engine);
  // A leitura da seleção nunca volta para o Take C.
  t.engine.selections=async()=>t.take.name==='Take C'&&!t.hungOnce?(t.hungOnce=true,new Promise(()=>{})):selections();
  t.selection='single';t.take.name='Take A';t.take.projectItemId='item-a';
 });
 await page.waitForFunction(()=>document.getElementById('takeName').textContent.includes('Take A')&&__test.captures.includes('Take A'),{},{timeout:8000});
 report.push('take A reconhecido; a exportação do quadro dele não volta');
 await page.evaluate(()=>{__test.take.name='Take B';__test.take.projectItemId='item-b';});
 await page.waitForFunction(()=>document.getElementById('takeName').textContent.includes('Take B'),{},{timeout:8000});
 report.push('take B reconhecido com a exportação anterior presa');
 await page.waitForFunction(()=>__test.captures.includes('Take B'),{},{timeout:8000});
 report.push('a prévia do take B foi pedida');
 await page.waitForFunction(()=>document.getElementById('bFirstMessage').textContent.includes('Prévia indisponível')&&document.getElementById('log').value.includes('PRÉVIA: O Premiere não exportou'),{},{timeout:16000});
 report.push('prévia presa vira "Prévia indisponível" e fica no registro');
 await page.evaluate(()=>{__test.take.name='Take C';__test.take.projectItemId='item-c';});
 await page.waitForFunction(()=>__test.hungOnce===true,{},{timeout:8000});
 await page.evaluate(()=>{__test.take.name='Take D';__test.take.projectItemId='item-d';});
 const t0=Date.now();
 await page.waitForFunction(()=>document.getElementById('takeName').textContent.includes('Take D'),{},{timeout:25000});
 report.push('leitura presa do take C liberada; take D reconhecido em '+((Date.now()-t0)/1000).toFixed(1)+' s');
 assert(await page.evaluate(()=>document.getElementById('log').value.includes('SELEÇÃO: O Premiere não respondeu à leitura da seleção')));
 report.push('espera esgotada registrada');
 await page.evaluate(()=>{__test.take.name='Take E';__test.take.projectItemId='item-e';});
 await page.waitForFunction(()=>document.getElementById('takeName').textContent.includes('Take E'),{},{timeout:8000});
 report.push('trocas seguintes normais');
 assert.deepEqual(errors,[]);report.push('sem erro JavaScript');
 console.log(JSON.stringify({checks:report,passed:report.length}));
 if(process.argv[2])fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify({checks:report,errors},null,2));
 await page.close();
}catch(e){console.log(JSON.stringify({checks:report,failedAfter:report.length}));throw e;}finally{await browser.close();}})().catch(e=>{console.error(e.message||e);process.exitCode=1;});
