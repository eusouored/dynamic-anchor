'use strict';
// Rasteriza SVGs do painel no tamanho de exibição (2x) com fundo transparente, pelo Chromium.
// Uso: node rasterizar.js <svg> <largura-css> <altura-css> <saida.png> [escala=2]
const fs=require('fs'),path=require('path');
const {chromium}=require(process.env.PLAYWRIGHT||'playwright');
const [svg,w,h,out,escala='2']=process.argv.slice(2);
(async()=>{const b=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
 try{const p=await b.newPage({viewport:{width:Number(w)+20,height:Number(h)+20},deviceScaleFactor:Number(escala)});
  const data='data:image/svg+xml;base64,'+fs.readFileSync(svg).toString('base64');
  await p.setContent(`<html><body style="margin:0;background:transparent"><img id="i" src="${data}" style="display:block;width:${w}px;height:${h}px"></body></html>`);
  await p.waitForFunction(()=>document.getElementById('i').complete);
  await p.locator('#i').screenshot({path:out,omitBackground:true});
 }finally{await b.close();}
 console.log('ok',out);})();
