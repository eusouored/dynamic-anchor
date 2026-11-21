'use strict';
// Explorador de botões do Dynamic Anchor no simulador (painel real, Premiere e motor simulados).
// 1) Testes de função: cada controle faz o que promete (o efeito é conferido no que o painel
//    entrega ao Premiere simulado, nos .bat abertos ou na tela).
// 2) Varredura: todo controle visível, em cada estado, é clicado numa página nova; não pode haver
//    erro de JavaScript, e o clique precisa mudar algo (tela, pedido, gravação ou .bat).
// Uso: ANCHOR_TEST_ROOT=<pasta plugin> node botoes.js [saida.json]
const fs=require('fs'),path=require('path');
const {launch,open}=require('./harness');
const {SEL}=require('./mapa');
const saida=path.resolve(process.argv[2]||path.join(__dirname,'out','botoes.json'));
const R={funcoes:[],varredura:[],erros:[]};
const ok=(nome,passou,detalhe)=>{R.funcoes.push({nome,ok:!!passou,detalhe});console.log((passou?'ok   ':'FALHA')+' '+nome+(passou?'':'  '+JSON.stringify(detalhe)));};

// ---------- ações no painel ----------
const click=(page,sel)=>page.evaluate(sel=>{const e=document.querySelector(sel);if(!e)throw Error('sem '+sel);e.click();},sel);
async function escolher(page,box,indice){
 await page.evaluate(box=>document.querySelector('#'+box+' .b-dd-btn').click(),box);await page.waitForTimeout(40);
 await page.evaluate(([box,i])=>{const opts=[...document.querySelectorAll('#'+box+' .b-dd-option')];if(!opts[i])throw Error('opção '+i+' ausente em '+box+' ('+opts.length+')');opts[i].click();},[box,indice]);
 await page.waitForTimeout(80);
}
async function aplicar(page){
 const n=await page.evaluate(()=>{const n=__test.hostWrites.length;document.getElementById('btnApply').click();return n;});
 await page.waitForFunction(n=>__test.hostWrites.length>n&&!AnchorIntegration.busy,n,{timeout:10000});await page.waitForTimeout(40);
 return page.evaluate(()=>JSON.parse(JSON.stringify(__test.hostWrites[__test.hostWrites.length-1])));
}
async function editar(page,id,valor){
 await page.evaluate(([id,valor])=>{const t=document.getElementById(id);const box=t.closest('.number-field');box&&box.click();t.value=String(valor);t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));t.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));t.dispatchEvent(new Event('blur',{bubbles:true}));},[id,valor]);
 await page.waitForTimeout(80);
}
const tecla=async(page,id,key,n=1)=>{for(let i=0;i<n;i++)await page.evaluate(([id,key])=>document.getElementById(id).dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true})),[id,key]);await page.waitForTimeout(60);};
const txt=(page,id)=>page.evaluate(id=>(document.getElementById(id)||{}).textContent?.trim(),id);
const visivel=(page,sel)=>page.evaluate(sel=>{const e=document.querySelector(sel);if(!e)return false;for(let n=e;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden')return false;}return e.getBoundingClientRect().height>0;},sel);
const attr=(page,sel,a)=>page.evaluate(([sel,a])=>document.querySelector(sel)?.getAttribute(a),[sel,a]);
const t=(page,expr)=>page.evaluate(new Function('return '+expr));

async function caso(browser,nome,opcoes,fn){
 const {page,errors}=await open(browser,{width:390,height:1400,...opcoes});
 try{await fn(page);}catch(e){ok(nome,false,String(e.message||e));}
 if(errors.length)ok(nome+' (sem erro de JavaScript)',false,errors);
 await page.close();
}
const PRONTO={selection:'single',status:'ready',trajectory:true};
const DESLIGADO={selection:'single',status:'offline'};

async function funcoes(browser){
 await caso(browser,'Iniciar motor',DESLIGADO,async p=>{await click(p,'#btnFaceStart');await p.waitForTimeout(300);const l=await t(p,'__test.launches');ok('Iniciar motor abre motor-rosto\\iniciar-motor.bat',l.some(x=>/\\motor-rosto\\iniciar-motor\.bat$/.test(x)),l);});
 await caso(browser,'Preparar motor',DESLIGADO,async p=>{await click(p,'#btnFacePrepare');await p.waitForTimeout(300);const l=await t(p,'__test.launches');ok('Preparar motor abre motor-rosto\\preparar-motor.bat',l.some(x=>/\\motor-rosto\\preparar-motor\.bat$/.test(x)),l);});
 await caso(browser,'Analisar com motor desligado',DESLIGADO,async p=>{await click(p,'#btnFaceAuto');await p.waitForTimeout(1500);const l=await t(p,'__test.launches');ok('Analisar rosto com motor desligado liga o motor sozinho',l.some(x=>/iniciar-motor\.bat$/.test(x)),{launches:l,status:await txt(p,'status')});});
 await caso(browser,'Analisar com motor sem resposta',{selection:'single',status:'timeout'},async p=>{await click(p,'#btnFaceAuto');await p.waitForTimeout(1500);const l=await t(p,'__test.launches');ok('Analisar rosto com motor sem resposta liga o motor (não fica em ocupado)',l.some(x=>/iniciar-motor\.bat$/.test(x)),{launches:l,status:await txt(p,'status')});});
 await caso(browser,'Velocidade',DESLIGADO,async p=>{
  const itens=await p.evaluate(()=>[...document.querySelectorAll('#taskTrack .b-seg-item')].map(e=>e.textContent.trim()));
  for(const alvo of ['Rápido','Ultra','Normal']){await p.evaluate(a=>[...document.querySelectorAll('#taskTrack .b-seg-item')].find(e=>e.textContent.trim()===a).click(),alvo);await p.waitForTimeout(60);
   const sel=await p.evaluate(()=>[...document.querySelectorAll('#taskTrack .b-seg-item')].filter(e=>e.classList.contains('selected')||e.getAttribute('aria-checked')==='true').map(e=>e.textContent.trim()));
   ok('Velocidade '+alvo+' fica selecionada (e só ela)',sel.length===1&&sel[0]===alvo,{itens,sel});}
 });
 await caso(browser,'Zoom',PRONTO,async p=>{
  const auto=await aplicar(p);ok('Zoom Automático grava scaleMode auto',auto.opt.scaleMode==='auto',auto.opt.scaleMode);
  await escolher(p,'bZoomBox',1);ok('Zoom Fixo mostra o campo de porcentagem',await visivel(p,'#fixedRow'),null);
  let s=await aplicar(p);ok('Zoom Fixo grava scaleMode fixed',s.opt.scaleMode!=='auto'&&/fix/i.test(s.opt.scaleMode),s.opt.scaleMode);
  await editar(p,'scalePercent',30);s=await aplicar(p);ok('Porcentagem do zoom fixo (30) chega à gravação',s.opt.scalePercent===30,s.opt.scalePercent);
  await escolher(p,'bZoomBox',2);ok('Sem zoom esconde o campo de porcentagem',!(await visivel(p,'#fixedRow')),null);
  s=await aplicar(p);ok('Sem zoom grava escala padrão (resetScale, 0 %)',s.resetScale===true&&s.opt.scalePercent===0,{resetScale:s.resetScale,pct:s.opt.scalePercent,mode:s.opt.scaleMode});
 });
 await caso(browser,'Sliders e Voltar ao centro',PRONTO,async p=>{
  await tecla(p,'offsetX','ArrowUp',5);await tecla(p,'offsetY','ArrowUp',3);
  const vx=await txt(p,'bValueX'),vy=await txt(p,'bValueY');let s=await aplicar(p);
  ok('Sliders mudam o valor mostrado',vx!=='0'&&vy!=='0',{vx,vy});
  ok('Deslocamento dos sliders chega à gravação',s.opt.targetOffset.x!==0&&s.opt.targetOffset.y!==0,s.opt.targetOffset);
  await click(p,'#btnResetOffset');await p.waitForTimeout(80);s=await aplicar(p);
  ok('Voltar ao centro zera os dois eixos (tela e gravação)',(await txt(p,'bValueX'))==='0'&&(await txt(p,'bValueY'))==='0'&&s.opt.targetOffset.x===0&&s.opt.targetOffset.y===0,{x:await txt(p,'bValueX'),y:await txt(p,'bValueY'),off:s.opt.targetOffset});
 });
 await caso(browser,'Quadro de enquadramento',PRONTO,async p=>{
  const b=await p.locator('#targetFrame').boundingBox();await p.mouse.click(b.x+b.width*.25,b.y+b.height*.25);await p.waitForTimeout(100);
  const s=await aplicar(p);ok('Clique no quadro move a posição alvo',s.opt.targetOffset.x<0&&s.opt.targetOffset.y<0,{off:s.opt.targetOffset,x:await txt(p,'bValueX'),y:await txt(p,'bValueY')});
  const d=await p.evaluate(()=>{const f=document.getElementById('targetFrame').getBoundingClientRect(),d=document.getElementById('targetDot').getBoundingClientRect();return {dx:(d.x+d.width/2)-(f.x+f.width/2),dy:(d.y+d.height/2)-(f.y+f.height/2)};});
  ok('A bolinha acompanha o clique',d.dx<-5&&d.dy<-5,d);
 });
 await caso(browser,'Eixos liga/desliga',PRONTO,async p=>{
  // A caixa de cada eixo só trava o ajuste manual daquele eixo; o rastreio segue os dois eixos sempre.
  await click(p,'#useX');await p.waitForTimeout(60);
  ok('Desmarcar Horizontal desativa o slider horizontal',(await attr(p,'#offsetX','aria-disabled'))==='true'&&(await attr(p,'#offsetY','aria-disabled'))!=='true',{x:await attr(p,'#offsetX','aria-disabled'),y:await attr(p,'#offsetY','aria-disabled')});
  const b=await p.locator('#targetFrame').boundingBox();await p.mouse.click(b.x+b.width*.25,b.y+b.height*.25);await p.waitForTimeout(100);let s=await aplicar(p);
  ok('Com Horizontal travado, clicar no quadro só move o vertical',s.opt.targetOffset.x===0&&s.opt.targetOffset.y<0&&s.opt.useX&&s.opt.useY,{off:s.opt.targetOffset,useX:s.opt.useX,useY:s.opt.useY});
  await click(p,'#btnResetOffset');await p.waitForTimeout(60);s=await aplicar(p);
  ok('Voltar ao centro respeita o eixo travado (zera só o vertical)',s.opt.targetOffset.y===0,{off:s.opt.targetOffset});
  await click(p,'#useX');await p.waitForTimeout(60);
  ok('Remarcar Horizontal libera o slider',(await attr(p,'#offsetX','aria-disabled'))!=='true',await attr(p,'#offsetX','aria-disabled'));
 });
 await caso(browser,'Destino e desfoque',PRONTO,async p=>{
  ok('Desfoque escondido com destino Movimento',!(await visivel(p,'#bBlur')),null);
  await escolher(p,'bDestinationBox',1);ok('Destino Transformar mostra o desfoque de movimento',await visivel(p,'#bBlur'),null);
  let s=await aplicar(p);ok('Destino Transformar chega à gravação',s.destination!=='motion',s.destination);
  for(const a of [180,360,0]){await p.evaluate(a=>document.querySelector('.b-preset[data-shutter="'+a+'"]').click(),a);await p.waitForTimeout(60);s=await aplicar(p);ok('Obturador '+a+'° chega à gravação',s.shutterAngle===a,s.shutterAngle);}
  await editar(p,'shutterAngle',90);s=await aplicar(p);ok('Ângulo personalizado (90°) chega à gravação',s.shutterAngle===90,s.shutterAngle);
  await escolher(p,'bDestinationBox',0);s=await aplicar(p);ok('Voltar para Movimento',s.destination==='motion'&&!(await visivel(p,'#bBlur')),s.destination);
 });
 await caso(browser,'Filtros de máscara escondidos no rosto',PRONTO,async p=>{await click(p,'#bAdvancedToggle');await p.waitForTimeout(60);ok('Trajeto de rosto: Outros métodos (filtros de máscara) escondido',!(await visivel(p,'#qualitySection')),null);});
 await caso(browser,'Avançados',{...PRONTO,dataType:'mask'},async p=>{
  ok('Avançados começa fechado',!(await visivel(p,'#bAdvancedBody')),null);
  await click(p,'#bAdvancedToggle');await p.waitForTimeout(60);ok('Avançados abre',await visivel(p,'#bAdvancedBody'),null);
  const base=await aplicar(p);
  await click(p,'#tremorFilter');await p.waitForTimeout(60);let s=await aplicar(p);
  ok('Reduzir tremor muda o que é gravado',JSON.stringify(s.quality)!==JSON.stringify(base.quality)||JSON.stringify(s.opt)!==JSON.stringify(base.opt),{antes:base.quality,depois:s.quality});
  const smoothId=await p.evaluate(()=>{const f=[...document.querySelectorAll('#bAdvancedBody .number-field')].find(e=>/Suaviza/.test(e.getAttribute('aria-label')||''));return f&&f.querySelector('sp-textfield').id;});
  await editar(p,smoothId,40);const s2=await aplicar(p);
  ok('Suavização (40 %) muda o que é gravado',JSON.stringify(s2.opt)!==JSON.stringify(s.opt)||JSON.stringify(s2.quality)!==JSON.stringify(s.quality),{smoothWin:[s.opt.smoothWin,s2.opt.smoothWin],campo:smoothId});
  await click(p,'#foldQuality');await p.waitForTimeout(80);
  const metodos=await p.evaluate(()=>[...document.querySelectorAll('#bodyQuality .file-button')].filter(e=>e.getBoundingClientRect().height>0).map(e=>({id:e.id,txt:e.textContent.trim()})));
  ok('Outros métodos lista opções',metodos.length>=2,metodos);
  const vistos=new Set();
  for(const m of metodos){const desativado=(await attr(p,'#'+m.id,'aria-disabled'))==='true';await click(p,'#'+m.id);await p.waitForTimeout(60);
   const pressed=await attr(p,'#'+m.id,'aria-pressed');const g=await aplicar(p);vistos.add(JSON.stringify(g.quality));
   if(desativado)ok('Método "'+m.txt+'" indisponível para rosto não é marcado',pressed!=='true'&&g.quality.center!=='area',{pressed,center:g.quality.center});
   else ok('Método "'+m.txt+'" fica marcado',pressed==='true',pressed);}
  ok('Os métodos gravam configurações diferentes entre si',vistos.size>=Math.min(2,metodos.length),[...vistos]);
 });
 await caso(browser,'Origem Máscara',{selection:'single',status:'ready'},async p=>{
  await escolher(p,'bSourceBox',1);
  ok('Origem Máscara mostra Ler máscara',await visivel(p,'#btnReadMask'),null);
  ok('Origem Máscara esconde Analisar rosto',!(await visivel(p,'#btnFaceAuto')),null);
  await click(p,'#btnReadMask');await p.waitForTimeout(800);const st=await txt(p,'status');
  ok('Ler máscara sem projeto salvo explica o motivo (sem travar)',st&&st.length>5&&!(await t(p,'AnchorIntegration.busy')),st);
  await escolher(p,'bSourceBox',0);ok('Voltar para Rosto mostra Analisar rosto',await visivel(p,'#btnFaceAuto'),null);
 });
 // Relato de uso (1.7.4): com um trajeto de ROSTO já carregado, escolher Máscara voltava sozinho para Rosto.
 await caso(browser,'Origem Máscara com trajeto de rosto carregado',PRONTO,async p=>{
  await escolher(p,'bSourceBox',1);await p.waitForTimeout(700);
  const depois=await p.evaluate(()=>document.getElementById('bSource').selectedIndex);
  ok('Com trajeto de rosto, escolher Máscara fica em Máscara',depois===1&&await visivel(p,'#btnReadMask'),{origem:depois});
  await click(p,'#btnRefreshSelection');await p.waitForTimeout(700);
  ok('Atualizar o mesmo take mantém Máscara',(await p.evaluate(()=>document.getElementById('bSource').selectedIndex))===1&&await visivel(p,'#btnReadMask'),null);
  await escolher(p,'bSourceBox',0);await p.waitForTimeout(400);ok('E dá para voltar para Rosto',await visivel(p,'#btnFaceAuto'),null);
 });
 await caso(browser,'Aplicar',PRONTO,async p=>{
  const s=await aplicar(p);const k=await t(p,'__test.appliedKeys[0].length');
  ok('Aplicar grava keyframes para todo o trecho',k>=30,{keys:k});
  ok('Cartão do take mostra Trajeto aplicado',/aplicado/i.test(await txt(p,'trajectoryState')),await txt(p,'trajectoryState'));
  ok('Status informa o resultado',/aplicado/i.test(await txt(p,'status')),await txt(p,'status'));
 });
 await caso(browser,'Sem take selecionado',{selection:'none',status:'ready'},async p=>{
  ok('Sem take: Aplicar desativado',(await attr(p,'#btnApply','aria-disabled'))==='true',null);
  ok('Sem take: o cartão pede para selecionar',/Nenhum take|Selecione/i.test(await txt(p,'takeName')+' '+await txt(p,'takeMeta')),await txt(p,'takeName'));
 });
 await caso(browser,'Tema ao vivo',PRONTO,async p=>{
  await p.evaluate(()=>__test.setTheme('light'));await p.waitForTimeout(80);const l=await p.evaluate(()=>document.getElementById('bancada').classList.contains('light'));
  await p.evaluate(()=>__test.setTheme('dark'));await p.waitForTimeout(80);const d=await p.evaluate(()=>!document.getElementById('bancada').classList.contains('light'));
  ok('Troca de tema do Premiere muda o painel na hora',l&&d,{l,d});
 });
 await caso(browser,'Teclado',PRONTO,async p=>{
  await p.evaluate(()=>{const b=document.getElementById('bAdvancedToggle');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});await p.waitForTimeout(80);
  ok('Enter num botão aciona o botão (Avançados)',await visivel(p,'#bAdvancedBody'),null);
  await p.evaluate(()=>{const b=document.getElementById('useX');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true}));});await p.waitForTimeout(80);
  ok('Espaço numa caixa de marcar alterna',(await attr(p,'#useX','aria-checked'))==='false',await attr(p,'#useX','aria-checked'));
 });
}

async function varredura(browser){
 for(const [estado,o] of [['sem-projeto',{selection:'no-project',status:'offline'}],['take-motor-desligado',DESLIGADO],['com-trajeto',PRONTO]]){
  const {page}=await open(browser,{width:390,height:1400,...o});
  await page.evaluate(()=>document.getElementById('bAdvancedToggle').click());await page.waitForTimeout(60);
  const n=await page.evaluate(SEL=>document.querySelectorAll(SEL).length,SEL);await page.close();
  for(let i=0;i<n;i++){
   const {page:p,errors}=await open(browser,{width:390,height:1400,...o});
   await p.evaluate(()=>document.getElementById('bAdvancedToggle').click());await p.waitForTimeout(60);
   const info=await p.evaluate(([SEL,i])=>{
    const e=document.querySelectorAll(SEL)[i];if(!e)return null;
    const vis=x=>{for(let n=x;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden')return false;}return x.getBoundingClientRect().height>0;};
    if(!vis(e))return null;
    const id=e.id||(e.closest('[id]')||{}).id+' > '+(e.className||'').toString().split(' ')[0]+':'+(e.textContent||'').trim().slice(0,20);
    window.__mut=0;new MutationObserver(m=>window.__mut+=m.length).observe(document.getElementById('bancada'),{subtree:true,childList:true,attributes:true,characterData:true});
    window.__antes={r:__test.requests.length,l:__test.launches.length,w:__test.hostWrites.length};
    return {id,disabled:e.getAttribute('aria-disabled')==='true',label:(e.getAttribute('aria-label')||e.textContent||'').trim().replace(/\s+/g,' ').slice(0,40)};
   },[SEL,i]);
   if(!info){await p.close();continue;}
   await p.evaluate(([SEL,i])=>document.querySelectorAll(SEL)[i].click(),[SEL,i]);await p.waitForTimeout(400);
   const efeito=await p.evaluate(()=>({mutacoes:window.__mut,pedidos:__test.requests.length-__antes.r,bats:__test.launches.length-__antes.l,gravacoes:__test.hostWrites.length-__antes.w}));
   const mudou=efeito.mutacoes+efeito.pedidos+efeito.bats+efeito.gravacoes>0;
   R.varredura.push({estado,...info,...efeito,mudou,erros:errors.slice()});
   await p.close();
  }
 }
}

(async()=>{const browser=await launch();try{await funcoes(browser);await varredura(browser);}catch(e){R.erros.push(String(e.stack||e));}finally{await browser.close();}
 const falhas=R.funcoes.filter(f=>!f.ok);
 const semEfeito=R.varredura.filter(v=>!v.mudou&&!v.disabled),comErro=R.varredura.filter(v=>v.erros.length);
 fs.mkdirSync(path.dirname(saida),{recursive:true});fs.writeFileSync(saida,JSON.stringify(R,null,1));
 console.log(JSON.stringify({funcoes:R.funcoes.length,falhas:falhas.length,varridos:R.varredura.length,semEfeito:semEfeito.map(v=>v.estado+': '+v.id+' ('+v.label+')'),comErro:comErro.map(v=>({c:v.estado+': '+v.id,e:v.erros})),erros:R.erros},null,1));
})();
