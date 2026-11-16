'use strict';
// Estado do print do usuário: eixo horizontal desmarcado, vertical em -10, zoom Fixo 30 %.
// Mede as caixas de marcar dos dois eixos (devem ter o mesmo tamanho e ficar centradas sob o slider).
const fs=require('fs'),path=require('path');
const {launch,open}=require('./harness');
const out=path.resolve(process.argv[2]||path.join(__dirname,'out','eixos'));fs.mkdirSync(out,{recursive:true});
(async()=>{const browser=await launch();const res={};try{
 for(const theme of ['dark','light']){
  const {page,errors}=await open(browser,{width:390,height:900,theme,selection:'single',status:'ready',trajectory:true});
  await page.evaluate(()=>{document.getElementById('useX').click();});
  await page.waitForTimeout(80);
  res[theme]=await page.evaluate(()=>{
   const r=e=>{const b=e.getBoundingClientRect();return {x:+b.x.toFixed(1),y:+b.y.toFixed(1),w:+b.width.toFixed(1),h:+b.height.toFixed(1),cx:+(b.x+b.width/2).toFixed(1)};};
   const q=s=>document.querySelector(s);
   const bg=e=>getComputedStyle(e).backgroundImage.replace(/^.*icons\//,'').replace(/["')]+$/,'');
   return {xChecked:q('#useX').getAttribute('aria-checked'),yChecked:q('#useY').getAttribute('aria-checked'),
    boxX:r(q('#useX .check-visual')),boxY:r(q('#useY .check-visual')),sliderX:r(q('#offsetX')),sliderY:r(q('#offsetY')),
    imgX:bg(q('#useX .check-visual')),imgY:bg(q('#useY .check-visual'))};
  });
  await page.locator('#taskFrame').screenshot({path:path.join(out,`enquadrar-${theme}.png`)});
  if(errors.length)res[theme].errors=errors;
  await page.close();
 }
}finally{await browser.close();}
console.log(JSON.stringify(res,null,1));})();
