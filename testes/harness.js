'use strict';
const fs=require('fs'),path=require('path');
const {chromium}=require(process.env.PLAYWRIGHT||'playwright');
const root=process.env.ANCHOR_TEST_ROOT?path.resolve(process.env.ANCHOR_TEST_ROOT):path.resolve(__dirname,'../plugin');
const stage=process.env.ANCHOR_TEST_ROOT||process.env.ANCHOR_BASELINE?root:path.join(__dirname,'stage');
async function launch(){return chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});}
async function open(browser,{width=390,height=760,theme='dark',status='offline',selection='none',format={width:1920,height:1080,pixelAspect:1},trajectory=false,cssDelay=0,activate=true,realMotor=false,take=null,media=null,motorPort=47833,dpr=1,dataType='external-face'}={}){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:dpr}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const sources={};for(const file of fs.readdirSync(root).filter(n=>n.endsWith('.js')))sources[file]=fs.readFileSync(path.join(fs.existsSync(path.join(stage,file))?stage:root,file),'utf8');
 await page.route('http://anchor.test/**',async route=>{
  const p=decodeURIComponent(new URL(route.request().url()).pathname);if(p==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script[^>]*><\/script>/g,'')});
  const file=path.resolve(root,'.'+p);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
  const override=path.join(stage,path.basename(file)),actual=path.dirname(file)===root&&fs.existsSync(override)?override:file,ext=path.extname(file);
  if(ext==='.css'&&cssDelay)await new Promise(r=>setTimeout(r,cssDelay));return route.fulfill({contentType:ext==='.css'?'text/css':ext==='.svg'?'image/svg+xml':ext==='.png'?'image/png':'application/octet-stream',body:fs.readFileSync(actual)});
 });
 if(realMotor){
  // Ponte para o motor real: o pedido sai do Node, sem cabeçalho Origin (o motor recusa páginas web).
  const http=require('http');
  await page.route('http://127.0.0.1:'+motorPort+'/**',async route=>{
   const req=route.request(),u=new URL(req.url()),body=req.postData();
   const res=await new Promise((ok,fail)=>{const r=http.request({host:'127.0.0.1',port:motorPort,path:u.pathname+u.search,method:req.method(),headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body||'')}},resp=>{const parts=[];resp.on('data',d=>parts.push(d));resp.on('end',()=>ok({status:resp.statusCode,body:Buffer.concat(parts)}));});r.on('error',fail);if(body)r.write(body);r.end();}).catch(e=>null);
   if(!res)return route.abort('connectionrefused');
   return route.fulfill({status:res.status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:res.body});
  });
 }
 await page.goto('http://anchor.test/');
 await page.evaluate(({sources,theme,status,selection,format,trajectory,activate,realMotor,take,media,dataType})=>{
  for(const tag of ['sp-textfield','sp-dropdown'])customElements.define(tag,class extends HTMLElement{
   get value(){return this._value===undefined?(this.getAttribute('value')||''):this._value;}set value(v){this._value=String(v);}
   get selectedIndex(){return this._index===undefined?Math.max(0,[...this.querySelectorAll('sp-menu-item')].findIndex(e=>e.hasAttribute('selected'))):this._index;}set selectedIndex(v){this._index=Number(v);}
  });
  // UXP's initial font comes from its host; Chromium's initial font is serif.
  // Substitute a Windows UI font in this harness, not in product styles.
  const defaults=document.createElement('style');defaults.textContent='body,.bancada{font-family:"Segoe UI",sans-serif!important}';document.head.appendChild(defaults);
  window.__test={dataType,status,selection,format,trajectory,busy:false,hostWrites:[],launches:[],native:[],requests:[],appliedChecks:[],theme};const t=window.__test;
  let themeListener;document.theme={getCurrent:()=>t.theme,onUpdated:{addListener:fn=>themeListener=fn}};t.setTheme=name=>{t.theme=name;themeListener(name);};
  t.take={name:'Take de teste',start:0,end:2,inPoint:0,outPoint:2,trackIndex:0,sequenceId:'test-sequence',sequenceGuid:'test-sequence',projectGuid:'test-project',projectPath:'C:/Anchor-Test.prproj',projectItemId:'test-item'};
  if(take)Object.assign(t.take,take);
  t.data=()=>({type:t.dataType||'external-face',name:'Rosto de teste',selection:t.take,W:t.format.width,H:t.format.height,fps:30,rows:Array.from({length:60},(_,i)=>({frame:i,x:t.format.width*(.43+.03*Math.sin(i/7)),y:t.format.height*(.36+.04*Math.cos(i/9)),angle:0,height:t.format.height*.14})),times:Array.from({length:60},(_,i)=>i/30)});
  const cache={},storage={};const folder={async getEntries(){return Object.values(storage);},async getEntry(n){if(!storage[n])throw Error('missing');return storage[n];},async createFile(n){return storage[n]={name:n,value:'',async read(){return this.value;},async write(v){this.value=v;}};}};
  const ppro={Project:{async getActiveProject(){return null;}},EventManager:{addGlobalEventListener(){},removeGlobalEventListener(){}},Constants:{}};
  const uxp={storage:{localFileSystem:{async getDataFolder(){return folder;},async getPluginFolder(){return {nativePath:'C:\\Anchor-Test'};}},formats:{binary:'binary'}},shell:{async openPath(p){t.launches.push(p);return '';}}};
  const engine={async selections(){if(t.selection==='error')throw Object.assign(Error('Premiere busy; try again'),{code:'HOST_TEMPORARY'});if(['none','no-project','no-sequence'].includes(t.selection))throw Error('Selecione um take na timeline.');return t.selection==='multiple'?[t.take,{...t.take,name:'Outro take',start:2,end:4}]:[t.take];},async selection(){return (await this.selections())[0];},async appliedCheck(...args){t.appliedChecks.push(args);return {present:t.appliedPresent!==false,keys:args[2]?args[2].length:0};},async sequenceFormat(){return {fps:30,...t.format};},async mediaSource(){return media||{mediaPath:'test.mp4'};},async navigate(s,time){(t.navigations??=[]).push(time);},async selectionSummary(){return [];}};
  t.engine=engine;const workflow={async capture(groups,selections,evidence){t.captured={groups,evidence};t.realData=groups[0][0];t.trajectory=true;},async load(){return t.realData?{masks:[t.realData],confirmed:true}:t.trajectory?{masks:[t.data()],confirmed:true}:null;},async state(){return t.savedState||{status:'not-started'};},async saveState(s,v){t.savedState=v;return v;},invalidateAll(){},resetCancel(){},async confirm(){return {masks:[t.realData||t.data()],confirmed:true};},async shouldSkip(){return false;},async apply(d,s){t.hostWrites.push(s);const rows=window.require('./quality.js').process(d,s.quality).rows;const keys=window.require('./core.js').anchorFraming(rows,0,s.opt);(t.appliedKeys??=[]).push(keys.map(k=>[k.px,k.py,k.scale]));t.savedState={status:'verified'};return keys;}};
  const preview={async read(){if(t.selection==='no-project')throw Error('Abra um projeto no Premiere.');if(t.selection==='no-sequence')throw Error('Abra uma sequência no Premiere.');return {sequence:{guid:'seq'},format:{...t.format,ratio:t.format.width*t.format.pixelAspect/t.format.height},key:['none','multiple'].includes(t.selection)?null:'selected',reason:'Selecione um take na timeline.'};},async capture(){throw Error('Mock: thumbnail unavailable');}};
  if(!realMotor)window.AnchorFaceOptions={client:{async status(){t.requests.push('status');if(t.status==='pending')await new Promise(r=>t.resolveProbe=r);if(t.status!=='ready'){const codes={offline:'offline',timeout:'timeout',permission:'permission',outdated:'outdated',incompatible:'incompatible',malformed:'http'};throw Object.assign(Error('Teste '+t.status),{code:codes[t.status]||'offline'});}return {service:'anchor-rosto',engine:'face-yunet-v1',api:1,version:'0.5.2',features:['premiere-process-lifetime-v1']};}}};
  if(!realMotor)window.fetch=async()=>{throw Error('Unexpected fetch in test');};
  window.require=name=>{if(name==='uxp')return uxp;if(name==='premierepro')return ppro;let id=name.replace(/^\.\//,'');if(!id.endsWith('.js'))id+='.js';if(id==='engine.js')return {createEngine:()=>engine};if(id==='workflow.js')return {createWorkflow:()=>workflow};if(id==='preview-host.js')return preview;if(cache[id])return cache[id].exports;if(!sources[id])throw Error('Missing '+id);const module={exports:{}};cache[id]=module;new Function('require','module','exports',sources[id])(window.require,module,module.exports);if(id==='face-panel.js'){const init=module.exports.initializeFacePanel;module.exports.initializeFacePanel=options=>(t.face=init(options));}return module.exports;};
  window.require('./main.js');window.require('./bancada.js');if(activate)document.dispatchEvent(new Event('mousedown',{bubbles:true}));
 },{sources,theme,status,selection,format,trajectory,activate,realMotor,take,media,dataType});
 await page.waitForFunction(()=>window.AnchorIntegration&&window.AnchorBancada);
 await page.evaluate(()=>{__test.firstReady={cssReady:getComputedStyle(document.getElementById('bancada')).getPropertyValue('--b-bg').trim()!==''};});
 await page.waitForFunction(()=>getComputedStyle(document.getElementById('bancada')).getPropertyValue('--b-bg').trim()!=='');
 await page.evaluate(async()=>{await window.AnchorIntegration.refreshSelection();await window.AnchorBancada.refresh();window.AnchorBancada.sync();});
 if(status!=='pending')await page.waitForTimeout(30);
 return {page,errors};
}
module.exports={launch,open,root,stage};



