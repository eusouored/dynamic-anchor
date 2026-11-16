'use strict';
// Mensagem de erro longa no rodapé: precisa aparecer inteira e a área de rolagem não pode ficar embaixo do rodapé.
const {launch,open}=require('./harness');
(async()=>{const browser=await launch();const out=[];try{
 for(const w of [280,390]){
  const {page,errors}=await open(browser,{width:w,height:760,selection:'single',status:'ready',trajectory:true});
  // força o erro real do zoom: limite de zoom baixo e enquadramento que exige mais
  const r=await page.evaluate(async()=>{
   const msg='0 de 1 conferidos. 1 precisa de revisão. O zoom necessário para cobrir o quadro (309%) passa do limite de 250%. Aumente o limite ou mude o enquadramento. Nada foi gravado.';
   const s=document.getElementById('status');s.textContent=msg;s.className='status-line error';window.AnchorBancada.reflow();
   await new Promise(r=>setTimeout(r,50));
   const f=document.querySelector('footer').getBoundingClientRect(),sc=document.getElementById('scroller').getBoundingClientRect();
   return {cortado:s.scrollHeight>s.clientHeight+1,altura:s.clientHeight,rodapeTopo:Math.round(f.top),rolagemFim:Math.round(sc.bottom)};
  });
  out.push({w,...r,sobreposto:r.rolagemFim>r.rodapeTopo+1,errors});
  await page.screenshot({path:require('path').join(__dirname,'out','status-'+w+'.png')});
  await page.close();
 }
}finally{await browser.close();}
console.log(JSON.stringify(out,null,1));})();
