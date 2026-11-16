'use strict';
// Caixas de marcar (ligada/desligada), rádios, bolinhas, logo e seletor aberto, nos dois temas e
// em escala 125% (Windows). Mede contorno de foco e borda do seletor aberto; salva recortes ampliados.
const fs=require('fs'),path=require('path');
const {launch,open}=require('./harness');
const out=path.resolve(process.argv[2]||path.join(__dirname,'out','controles'));fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await launch();const r={};try{
 for(const theme of ['dark','light'])for(const dpr of [1.25,1.5]){
  const {page,errors}=await open(browser,{width:390,height:1300,theme,selection:'single',status:'ready',trajectory:true,dpr});
  const tag=theme+'-'+dpr;
  await page.evaluate(()=>{document.getElementById('useX').click();document.getElementById('bAdvancedToggle').click();});await page.waitForTimeout(80);
  await page.evaluate(()=>document.getElementById('foldQuality').click());await page.waitForTimeout(80);
  await page.locator('.b-header').screenshot({path:path.join(out,`logo-${tag}.png`)});
  await page.locator('.b-axes').screenshot({path:path.join(out,`eixos-${tag}.png`)});
  await page.locator('#tremorFilter').screenshot({path:path.join(out,`tremor-off-${tag}.png`)});
  await page.evaluate(()=>document.getElementById('tremorFilter').click());await page.waitForTimeout(60);
  await page.locator('#tremorFilter').screenshot({path:path.join(out,`tremor-on-${tag}.png`)});
  await page.locator('#bodyQuality').screenshot({path:path.join(out,`metodos-${tag}.png`)});
  // seletor aberto + foco: nada amarelo em volta
  await page.evaluate(()=>{const b=document.querySelector('#bZoomBox .b-dd-btn');b.focus();b.click();});await page.waitForTimeout(80);
  r[tag]=await page.evaluate(()=>{const box=document.getElementById('bZoomBox'),btn=box.querySelector('.b-dd-btn'),cs=getComputedStyle(box),bs=getComputedStyle(btn);
   return {aberto:box.classList.contains('open'),fundoCaixa:cs.backgroundColor,contornoBotao:bs.outlineStyle+' '+bs.outlineColor,contornoCaixa:cs.outlineStyle};});
  await page.locator('#taskFrame').screenshot({path:path.join(out,`seletor-aberto-${tag}.png`)});
  if(errors.length)r[tag].errors=errors;
  await page.close();
 }
}finally{await browser.close();}
console.log(JSON.stringify(r,null,1));})();
