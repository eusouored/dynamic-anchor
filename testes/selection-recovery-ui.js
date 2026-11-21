'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const {launch,open}=require('./harness');
(async()=>{const browser=await launch();const report=[];try{
 const {page,errors}=await open(browser,{selection:'none',status:'ready'});
 await page.evaluate(()=>{
  const t=__test,p=require('premierepro');t.probes=0;
  p.Project.getActiveProject=async()=>{t.probes++;return {guid:'project',getActiveSequence:async()=>({guid:'sequence',getSelection:async()=>({getTrackItems:async()=>t.selection==='single'?[{
   getName:async()=>t.take.name,getTrackIndex:async()=>0,getStartTime:async()=>({seconds:t.take.start}),getEndTime:async()=>({seconds:t.take.end}),getInPoint:async()=>({seconds:t.take.inPoint}),getOutPoint:async()=>({seconds:t.take.outPoint}),getProjectItem:async()=>({getId:()=>t.take.projectItemId})
  }]:[]})})};};
  t.selection='single';t.take.name='Take A';t.take.projectItemId='item-a';
 });
 await page.waitForFunction(()=>document.getElementById('takeName').textContent.includes('Take A'),{},{timeout:7000});report.push('seleção recuperada sem evento do host');
 await page.evaluate(()=>{__test.take.name='Take B';__test.take.projectItemId='item-b';});
 await page.waitForFunction(()=>document.getElementById('takeName').textContent.includes('Take B'),{},{timeout:7000});report.push('troca de take recuperada sem evento do host');
 await page.evaluate(()=>document.getElementById('bancada').style.display='none');await page.waitForTimeout(200);
 const before=await page.evaluate(()=>__test.probes);await page.waitForTimeout(3000);assert.equal(await page.evaluate(()=>__test.probes),before);report.push('nenhuma consulta nativa com painel oculto');
 await page.evaluate(()=>{__test.take.name='Take C';__test.take.projectItemId='item-c';document.getElementById('bancada').style.display='flex';window.dispatchEvent(new Event('focus'));});
 await page.waitForFunction(()=>document.getElementById('takeName').textContent.includes('Take C'),{},{timeout:7000});report.push('retorno ao painel recupera a seleção');
 assert.deepEqual(errors,[]);report.push('sem erro JavaScript');
 console.log(JSON.stringify({checks:report,passed:report.length}));
 if(process.argv[2])fs.writeFileSync(path.resolve(process.argv[2]),JSON.stringify({checks:report,errors},null,2));
 await page.close();
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
