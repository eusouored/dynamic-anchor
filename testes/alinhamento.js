'use strict';
// Auditoria de alinhamento no simulador: em cada linha flex (cabeçalhos de seção, faixa do take,
// linhas de botões), os filhos visíveis devem ter o mesmo centro vertical (tolerância 1,5 px);
// nenhum elemento pode passar da borda direita do painel.
const {launch,open}=require('./harness');
const ROWS=['.b-header','.take-row','.b-heading','.b-zoom','.b-blur-row','.b-seg','.face-actions','.b-footer .apply-row','.b-dest-row'];
(async()=>{const browser=await launch();const falhas=[];let linhas=0;try{
 for(const [w,h] of [[280,700],[390,900],[520,900]])for(const theme of ['dark','light'])for(const zoom of ['auto','fixo']){
  const {page,errors}=await open(browser,{width:w,height:h,theme,selection:'single',status:'ready',trajectory:true});
  if(zoom==='fixo')await page.evaluate(()=>{const f=document.getElementById('fixedRow');f&&f.classList.remove('hidden');});
  const r=await page.evaluate(ROWS=>{
   const vis=e=>{const s=getComputedStyle(e),b=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&b.width>0&&b.height>0;};
   const out=[];let n=0;
   for(const sel of ROWS)for(const row of document.querySelectorAll(sel)){
    if(!vis(row)||getComputedStyle(row).display!=='flex'||getComputedStyle(row).flexDirection!=='row')continue;
    const kids=[...row.children].filter(vis).filter(k=>getComputedStyle(k).position!=='absolute');if(kids.length<2)continue;n++;
    const cs=kids.map(k=>{const b=k.getBoundingClientRect();return {id:k.id||k.className.split(' ')[0]||k.tagName,cy:b.y+b.height/2,top:b.y,h:b.height};});
    // só filhos na mesma linha visual (quebra de linha em painel estreito é permitida)
    const base=cs[0].top;const mesma=cs.filter(c=>Math.abs(c.top-base)<c.h);
    const ys=mesma.map(c=>c.cy),d=Math.max(...ys)-Math.min(...ys);
    if(d>1.5)out.push({sel,row:row.id||row.className,desvio:+d.toFixed(1),filhos:mesma.map(c=>c.id+':'+c.cy.toFixed(1))});
   }
   const W=document.documentElement.clientWidth;const fora=[...document.querySelectorAll('#bancada *')].filter(vis).filter(e=>e.getBoundingClientRect().right>W+0.5).map(e=>e.id||e.className).slice(0,8);
   return {out,n,fora};
  },ROWS);
  linhas+=r.n;for(const f of r.out)falhas.push({w,theme,zoom,...f});if(r.fora.length)falhas.push({w,theme,zoom,foraDaTela:r.fora});
  if(errors.length)falhas.push({w,theme,zoom,errors});
  await page.close();
 }
}finally{await browser.close();}
console.log(JSON.stringify({linhasConferidas:linhas,falhas},null,1));})();
