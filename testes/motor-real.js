'use strict';
// Ponta a ponta com o motor REAL: painel no simulador, motor anchor-motor.exe de verdade pelo HTTP,
// take real em 4K. Clica Analisar rosto, escolhe a pessoa (maior rosto), espera o trajeto, confere a
// tela de Conferir e aplica (o Premiere é simulado: recebe as configurações e gera os keyframes).
// Uso: ANCHOR_TEST_ROOT=<pasta plugin> node motor-real.js <anchor-motor.exe> <video> <inicio> <fim> <saida-dir>
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),{spawn}=require('child_process');
const {launch,open}=require('./harness');
const [exe,video,ini,fim,outDir]=process.argv.slice(2);fs.mkdirSync(outDir,{recursive:true});
const PORT=47833;
// sequência: ANCHOR_SEQ=LxA (padrão 3840x2160, a mesma do vídeo)
const [SW_,SH_]=(process.env.ANCHOR_SEQ||'3840x2160').split('x').map(Number),SEQ={width:SW_,height:SH_,pixelAspect:1,fps:60000/1001};
const get=p=>new Promise(ok=>{http.get({host:'127.0.0.1',port:PORT,path:p,timeout:2000},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{try{ok(JSON.parse(b));}catch(_){ok(null);}});}).on('error',()=>ok(null));});
const post=p=>new Promise(ok=>{const r=http.request({host:'127.0.0.1',port:PORT,path:p,method:'POST',headers:{'Content-Type':'application/json'}},s=>{s.resume();s.on('end',ok);});r.on('error',()=>ok());r.end('{}');});
(async()=>{
 const rel={};
 if(await get('/v1/status'))throw Error('a porta '+PORT+' já tem um motor respondendo; desligue-o antes');
 const perfil=fs.mkdtempSync(path.join(os.tmpdir(),'anchor-e2e-'));for(const d of ['local','roaming','temp'])fs.mkdirSync(path.join(perfil,d));
 const env={...process.env,LOCALAPPDATA:path.join(perfil,'local'),APPDATA:path.join(perfil,'roaming'),TEMP:path.join(perfil,'temp'),TMP:path.join(perfil,'temp')};
 const motor=spawn(exe,[],{cwd:perfil,env,stdio:'ignore'});
 let st=null;for(let i=0;i<240&&!st;i++){await new Promise(r=>setTimeout(r,500));st=await get('/v1/status');}
 if(!st)throw Error('motor não respondeu');rel.status={service:st.service,version:st.version,samplingModes:st.samplingModes};
 const browser=await launch();
 try{
  const take={name:path.basename(video),inPoint:Number(ini),outPoint:Number(fim),start:0,end:Number(fim)-Number(ini)};
  const {page,errors}=await open(browser,{width:390,height:1100,selection:'single',status:'ready',realMotor:true,take,media:{mediaPath:video,format:{width:3840,height:2160,pixelAspect:1}},format:SEQ});
  const rostos=[];page.on('response',async r=>{if(r.url().includes('/v1/rostos'))try{rostos.push(await r.json());}catch(_){}});
  await page.waitForFunction(()=>/Motor de rosto \d/.test(document.getElementById('faceState').textContent),null,{timeout:30000}).catch(()=>{});
  rel.antes={faceState:await page.evaluate(()=>document.getElementById('faceState').textContent.trim()),velocidades:await page.evaluate(()=>[...document.querySelectorAll('#taskTrack .b-seg-item')].map(e=>e.textContent.trim()+(e.classList.contains('unavailable')?' (indisponível)':'')))};
  const t0=Date.now();
  await page.evaluate(()=>document.getElementById('btnFaceAuto').click());
  let escolheu=false;
  for(let i=0;i<720;i++){
   await page.waitForTimeout(250);
   const estado=await page.evaluate(()=>({chooser:(()=>{const e=document.getElementById('faceChooser');return !!e&&!e.classList.contains('hidden')&&e.getBoundingClientRect().height>0;})(),traj:document.getElementById('trajectoryState').textContent.trim(),busy:!!(window.AnchorIntegration&&AnchorIntegration.busy),status:document.getElementById('status').textContent.trim()}));
   if(estado.chooser&&!escolheu){
    const faces=(rostos[rostos.length-1]||{}).faces||[];
    const maior=faces.reduce((a,f,i)=>f.width*f.height>(faces[a]?faces[a].width*faces[a].height:-1)?i:a,0);
    await page.screenshot({path:path.join(outDir,'escolha-pessoa.png'),fullPage:true});
    const botoes=await page.evaluate(()=>[...document.querySelectorAll('#faceChooser .face-choice-row .file-button')].map(e=>e.textContent.trim()));
    rel.escolha={rostos:faces.length,botoes,escolhido:maior};
    await page.evaluate(i=>document.querySelectorAll('#faceChooser .face-choice-row .file-button')[i].click(),maior);await page.waitForTimeout(150);
    const confirmar=await page.evaluate(()=>{const b=[...document.querySelectorAll('#faceChooser .face-actions .file-button')].find(e=>e.getBoundingClientRect().height>0&&e.getAttribute('aria-disabled')!=='true');if(b){b.click();return b.textContent.trim();}return null;});
    rel.escolha.confirmou=confirmar;escolheu=true;continue;
   }
   if(!estado.busy&&/pronto|dispon|salvo/i.test(estado.traj)){rel.analise={segundos:(Date.now()-t0)/1000,...estado};break;}
   if(!estado.busy&&i>8&&/erro|falh|não foi|nada foi/i.test(estado.status)){rel.analise={segundos:(Date.now()-t0)/1000,falhou:true,...estado};break;}
  }
  rel.conferir=await page.evaluate(()=>({faceState:document.getElementById('faceState').textContent.trim(),detalhes:(document.getElementById('faceDetails')||{}).innerText||'',log:document.getElementById('log').value.split('\n').filter(l=>/refer|motor|quadros|cobert|aplic|rastre/i.test(l)).slice(-12)}));
  await page.screenshot({path:path.join(outDir,'apos-analise.png'),fullPage:true});
  if(rel.analise&&!rel.analise.falhou){
   const antes=await page.evaluate(()=>document.getElementById('status').textContent.trim());
   await page.evaluate(()=>document.getElementById('btnFaceNextIssue').click());await page.waitForTimeout(800);
   rel.conferirTrecho=await page.evaluate(()=>({navegou:__test.navigations||[],status:document.getElementById('status').textContent.trim()}));rel.conferirTrecho.mudouStatus=rel.conferirTrecho.status!==antes;
   await page.evaluate(()=>document.getElementById('btnFacePick').click());await page.waitForTimeout(1500);
   rel.trocarPessoa=await page.evaluate(()=>{const e=document.getElementById('faceChooser');return {abriu:!!e&&!e.classList.contains('hidden')&&e.getBoundingClientRect().height>0,botoes:[...document.querySelectorAll('#faceChooser .face-choice-row .file-button')].filter(b=>b.getBoundingClientRect().height>0).length};});
   await page.screenshot({path:path.join(outDir,'trocar-pessoa.png'),fullPage:true});
   // fecha a escolha sem trocar (Cancelar, se houver)
   await page.evaluate(()=>{const b=[...document.querySelectorAll('#faceChooser .face-actions .file-button')].find(e=>/cancel|fechar|manter/i.test(e.textContent));b&&b.click();});await page.waitForTimeout(300);
  }
  if(rel.analise&&!rel.analise.falhou){
   const n=await page.evaluate(()=>{const n=__test.hostWrites.length;document.getElementById('btnApply').click();return n;});
   await page.waitForFunction(n=>__test.hostWrites.length>n&&!AnchorIntegration.busy,n,{timeout:60000});
   const r=await page.evaluate(()=>{const s=__test.hostWrites[__test.hostWrites.length-1],k=__test.appliedKeys[__test.appliedKeys.length-1];const xs=k.map(v=>v[0]),ys=k.map(v=>v[1]);
    return {destino:s.destination,quadrosOrigem:s.sourceTimes.length,keyframes:k.length,W:s.W,H:s.H,fps:s.fps,faixaX:[Math.min(...xs),Math.max(...xs)].map(v=>+v.toFixed(1)),faixaY:[Math.min(...ys),Math.max(...ys)].map(v=>+v.toFixed(1)),escala:[...new Set(k.map(v=>+v[2].toFixed(3)))].slice(0,5),trajeto:document.getElementById('trajectoryState').textContent.trim(),status:document.getElementById('status').textContent.trim()};});
   rel.aplicar=r;await page.screenshot({path:path.join(outDir,'apos-aplicar.png'),fullPage:true});
  }
  rel.errosJS=errors;
 }finally{await browser.close();await post('/v1/encerrar');await new Promise(r=>setTimeout(r,1500));try{motor.kill();}catch(_){}}
 fs.writeFileSync(path.join(outDir,'motor-real.json'),JSON.stringify(rel,null,1));
 console.log(JSON.stringify(rel,null,1));
})().catch(e=>{console.error(e);process.exit(1);});
