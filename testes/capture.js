'use strict';
const fs=require('fs'),path=require('path');
const {launch,open}=require('./harness');
const OUT=path.join(__dirname,'out');const report={environment:'SIMULAÇÃO: painel real em Chromium; Premiere, motor, seleção e gravação simulados pelo harness.',shots:[],checks:[],errors:[]};
const check=(name,ok,detail)=>report.checks.push({name,ok:!!ok,detail});
async function shot(page,file,el){const p=path.join(OUT,file);if(el)await page.locator(el).screenshot({path:p});else await page.screenshot({path:p});report.shots.push(file);}
async function geom(page){return page.evaluate(()=>{const r=e=>{const b=document.getElementById(e)?.getBoundingClientRect();return b&&{x:b.x,y:b.y,w:b.width,h:b.height};};return {frame:r('targetFrame'),dot:r('targetDot'),overflow:document.body.scrollWidth>innerWidth+1,take:document.getElementById('takeName').textContent.trim(),face:document.getElementById('faceState').textContent.trim(),status:document.getElementById('status').textContent.trim(),apply:document.getElementById('btnApply').disabled,analyze:document.getElementById('btnFaceAuto').disabled,trajectory:document.getElementById('trajectoryState').textContent.trim()};});}
function centered(g){if(!g.frame||!g.dot)return {ok:false};const dx=(g.dot.x+g.dot.w/2)-(g.frame.x+g.frame.w/2),dy=(g.dot.y+g.dot.h/2)-(g.frame.y+g.frame.h/2);return {ok:Math.abs(dx)<=1&&Math.abs(dy)<=1,dx,dy,ratio:g.frame.w/g.frame.h};}
(async()=>{const browser=await launch();try{
 for(const theme of ['dark','light'])for(const [w,h,tag] of [[390,760,'normal-390x760'],[280,620,'estreito-280x620']]){
  const states=[['01-sem-projeto','no-project','offline',false],['02-take-motor-desligado','single','offline',false],['03-apos-analise','single','ready',true]];
  for(const [name,selection,status,trajectory] of states){
   const {page,errors}=await open(browser,{width:w,height:h,theme,selection,status,trajectory});
   const g=await geom(page);report[`${name}-${theme}-${tag}`]=g;
   await shot(page,`${name}-${theme}-${tag}.png`);
   const c=centered(g);check(`${name} ${theme} ${tag}: bolinha centralizada no Enquadrar`,c.ok,c);check(`${name} ${theme} ${tag}: sem rolagem horizontal`,!g.overflow);check(`${name} ${theme} ${tag}: sem erro de página`,errors.length===0,errors);
   if(name==='03-apos-analise'){
    const n=await page.evaluate(()=>{const n=__test.hostWrites.length+1;document.getElementById('btnApply').click();return n;});
    await page.waitForFunction(n=>!AnchorIntegration.busy&&__test.hostWrites.length===n,n,{timeout:10000});await page.waitForTimeout(50);
    const g2=await geom(page);report[`04-apos-aplicar-${theme}-${tag}`]=g2;await shot(page,`04-apos-aplicar-${theme}-${tag}.png`);
    check(`04-apos-aplicar ${theme} ${tag}: uma gravação simulada`,(await page.evaluate(()=>__test.hostWrites.length))===1);
    if(theme==='dark'&&w===390){
     await shot(page,`05-enquadrar-inteiro-${theme}.png`,'#taskFrame');
     await page.evaluate(()=>{document.getElementById('modeAuto').click();});await page.waitForTimeout(50);
     await shot(page,`06-zoom-automatico-${theme}.png`,'#taskFrame');
     const zoom=await page.evaluate(()=>({auto:document.getElementById('modeAuto').getAttribute('aria-checked')||document.getElementById('modeAuto').className,hint:document.getElementById('scaleHint').textContent.trim(),result:document.getElementById('scaleResult').textContent.trim()}));report.zoomAuto=zoom;
     await page.evaluate(()=>document.getElementById('bAdvancedToggle').click());await page.waitForTimeout(50);
     await page.locator('#bAdvancedBody').scrollIntoViewIfNeeded();await shot(page,`07-avancados-${theme}.png`,'#bAdvancedBody');
    }
   }
   await page.close();
  }
 }
 // seleção sem sequência (formato 16:9 de reserva) e sequência vertical, só para checar a proporção do Enquadrar
 for(const [label,format] of [['vertical-1080x1920',{width:1080,height:1920,pixelAspect:1}],['horizontal-3840x2160',{width:3840,height:2160,pixelAspect:1}]]){
  const {page,errors}=await open(browser,{selection:'single',status:'ready',trajectory:true,format});const g=await geom(page);const c=centered(g);
  check(`Enquadrar ${label}: proporção ${c.ratio&&c.ratio.toFixed(3)} e bolinha centralizada`,c.ok&&Math.abs(c.ratio-format.width/format.height)<.02,c);
  await shot(page,`08-enquadrar-${label}-dark.png`,'#targetFrame');await page.close();
 }
}catch(e){report.errors.push(String(e.stack||e));}finally{await browser.close();fs.writeFileSync(path.join(OUT,'capturas-simuladas.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({shots:report.shots.length,failed:report.checks.filter(c=>!c.ok),errors:report.errors,zoom:report.zoomAuto,sample:report['03-apos-analise-dark-normal-390x760'],after:report['04-apos-aplicar-dark-normal-390x760']},null,1));})();
