'use strict';
// 1.7.6: Analisar lê o take, o formato e o arquivo numa leitura só do Premiere (analysisSource).
const assert=require('assert/strict');
const {launch,open}=require('./harness');
(async()=>{const browser=await launch();try{
 const {page,errors}=await open(browser,{selection:'single',status:'ready'});
 await page.evaluate(()=>{const t=__test;t.separate=0;for(const k of ['selection','sequenceFormat','mediaSource']){const f=t.engine[k].bind(t.engine);t.engine[k]=async(...a)=>{if(!t.inSource)t.separate++;return f(...a);};}
  const src=t.engine.analysisSource.bind(t.engine);t.engine.analysisSource=async()=>{t.inSource=true;try{return await src();}finally{t.inSource=false;}};});
 await page.click('#btnFaceAuto');
 await page.waitForFunction(()=>__test.analysisSourceCalls>0,{},{timeout:8000});
 await page.waitForTimeout(800);
 const r=await page.evaluate(()=>({calls:__test.analysisSourceCalls,separate:__test.separate}));
 assert.equal(r.calls,1);assert.equal(r.separate,0,'Analisar não deve fazer leituras separadas do take');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks:['Analisar usa uma leitura só do Premiere','nenhuma leitura separada de take, formato ou arquivo','sem erro JavaScript'],passed:3}));
}finally{await browser.close();}})().catch(e=>{console.error(e.message||e);process.exitCode=1;});
