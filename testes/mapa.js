'use strict';
// Lista os controles interativos visíveis do painel em cada estado (para o explorador de botões).
const {launch,open}=require('./harness');
const SEL='[role=button],[role=checkbox],[role=slider],[role=radio],[role=switch],[role=tab],.b-dd-btn,.b-seg-item,.b-preset,[role=textbox]';
async function mapa(page){return page.evaluate(SEL=>{
 const vis=e=>{for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden')return false;}const b=e.getBoundingClientRect();return b.width>0&&b.height>0;};
 return [...document.querySelectorAll(SEL)].filter(vis).map(e=>({id:e.id||null,cls:(e.className||'').toString().split(' ').slice(0,2).join('.'),role:e.getAttribute('role'),label:(e.getAttribute('aria-label')||e.textContent||'').trim().replace(/\s+/g,' ').slice(0,40),disabled:e.getAttribute('aria-disabled')==='true'}));
},SEL);}
if(require.main===module)(async()=>{const browser=await launch();const out={};try{
 for(const [nome,o] of [['sem-projeto',{selection:'no-project',status:'offline'}],['take-motor-desligado',{selection:'single',status:'offline'}],['com-trajeto',{selection:'single',status:'ready',trajectory:true}]]){
  const {page}=await open(browser,{width:390,height:1400,...o});
  await page.evaluate(()=>{const t=document.getElementById('bAdvancedToggle');t&&t.click();});await page.waitForTimeout(80);
  out[nome]=await mapa(page);await page.close();
 }
}finally{await browser.close();}
for(const [k,v] of Object.entries(out)){console.log('== '+k+' ('+v.length+')');for(const c of v)console.log((c.disabled?'  [x] ':'      ')+(c.id||'.'+c.cls)+' <'+c.role+'> '+c.label);}
})();
module.exports={SEL,mapa};
