'use strict';
// Capturas rápidas do painel no simulador: tela inteira e trechos, nos dois temas.
// Uso: ANCHOR_TEST_ROOT=<pasta plugin> node olhar.js <pasta-saida> [largura] [altura]
const fs=require('fs'),path=require('path');
const {launch,open}=require('./harness');
const out=path.resolve(process.argv[2]||path.join(__dirname,'out','olhar'));fs.mkdirSync(out,{recursive:true});
const W=Number(process.argv[3]||390),H=Number(process.argv[4]||900);
(async()=>{const browser=await launch();try{
 for(const theme of ['dark','light']){
  const {page,errors}=await open(browser,{width:W,height:H,theme,selection:'single',status:'ready',trajectory:true});
  await page.evaluate(()=>{const b=document.getElementById('modeFixed')||null;});
  await page.screenshot({path:path.join(out,`painel-${theme}-${W}.png`),fullPage:true});
  for(const [sel,nome] of [['.b-header','cabecalho'],['#taskFrame','enquadrar'],['#takeCard','take'],['#taskTrack','rastrear'],['.b-footer','rodape']]){
   const el=page.locator(sel).first();if(await el.count())await el.screenshot({path:path.join(out,`${nome}-${theme}-${W}.png`)});
  }
  if(errors.length)console.log(theme,'erros',errors);
  await page.close();
 }
}finally{await browser.close();}
console.log('ok',out);})();
