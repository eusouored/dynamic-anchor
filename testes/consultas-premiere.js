'use strict';
// Conta as consultas ao Premiere de cada etapa do painel e mede o tempo com um Premiere lento.
// Roda o código real (engine.js, preview-host.js, selection-watch.js) contra um Premiere simulado.
// Dois modelos de Premiere ocupado (cada resposta demora LAT ms):
//   fila: responde uma consulta por vez (pior caso: o tempo é o número de consultas × LAT);
//   lote: responde de uma vez tudo o que chegou junto (o tempo é o número de rodadas × LAT).
// Uso: node consultas-premiere.js [LAT_ms]   (ANCHOR_TEST_ROOT aponta outra pasta de plugin)
const path=require('path'),root=process.env.ANCHOR_TEST_ROOT?path.resolve(process.env.ANCHOR_TEST_ROOT):path.resolve(__dirname,'../plugin');
const LAT=Number(process.argv[2]||20);
const XMP='<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmlns:stDim="http://ns.adobe.com/xap/1.0/sType/Dimensions#" xmpDM:videoPixelAspectRatio="1/1"><xmpDM:videoFrameSize stDim:w="3840" stDim:h="2160" stDim:unit="pixel"/></rdf:Description></rdf:RDF></x:xmpmeta>';
const TPS=254016000000;
function premiere(mode){
 let calls=0,queue=Promise.resolve(),pending=[],timer=null,rounds=0;
 const ask=value=>{calls++;const get=()=>typeof value==='function'?value():value;
  if(mode==='fila'){const p=queue.then(()=>new Promise(r=>setTimeout(r,LAT)));queue=p;return p.then(get);}
  return new Promise(r=>{pending.push(()=>r(get()));if(!timer)timer=setTimeout(()=>{timer=null;rounds++;pending.splice(0).forEach(f=>f());},LAT);});};
 const tick=s=>({seconds:s,ticks:String(Math.round(s*TPS)),add(o){return tick(this.seconds+o.seconds);},subtract(o){return tick(this.seconds-o.seconds);},divide(n){return tick(this.seconds/n);}});
 const param=(name,value)=>({displayName:name,isTimeVarying:()=>ask(false),getValueAtTime:()=>ask(value),getKeyframeListAsTickTimes:()=>ask([]),areKeyframesSupported:()=>ask(true)});
 const component=(match,name,names)=>({getMatchName:()=>ask(match),getDisplayName:()=>ask(name),getParamCount:()=>ask(names.length),getParam:i=>ask(param(names[i],0))});
 const chain=list=>({getComponentCount:()=>ask(list.length),getComponentAtIndex:i=>ask(list[i])});
 const motion=['Posição','Escala','Dimensionar largura','Dimensionar uniformemente','Rotação','Ponto de ancoragem','Filtro anti-cintilação','Corte à esquerda','Corte superior','Corte à direita','Corte inferior'];
 const item={getId:()=>ask('item-1'),getMediaFilePath:()=>ask('E:/midia/clipe.mp4'),hasProxy:()=>ask(false),getProxyPath:()=>ask(''),getFootageInterpretation:()=>ask({getPixelAspectRatio:()=>ask(1)})};
 const clip=(kind)=>({
  getComponentChain:()=>ask(kind==='video'?chain([component('AE.ADBE Opacity','Opacidade',['Opacidade','Modo de mesclagem']),component('AE.ADBE Motion','Movimento',motion)]):
   chain([component('ADBE Audio Volume','Volume',['Ignorar','Nível']),component('ADBE Channel Volume','Volume do canal',['Ignorar','Esq','Dir']),component('ADBE Panner','Panorâmica',['Equilíbrio'])])),
  getSpeed:()=>ask(1),isSpeedReversed:()=>ask(false),getTrackIndex:()=>ask(0),getName:()=>ask('clipe.mp4'),
  getStartTime:()=>ask(tick(916.9)),getEndTime:()=>ask(tick(918.1333333333333)),getInPoint:()=>ask(tick(430.73333333333335)),getOutPoint:()=>ask(tick(431.96666666666664)),getProjectItem:()=>ask(item)});
 const items=[clip('video'),clip('audio')];
 const seq={guid:{toString:()=>'seq-1'},getSelection:()=>ask({getTrackItems:()=>ask(items)}),getFrameSize:()=>ask({width:3840,height:2160}),getTimebase:()=>ask(String(TPS/30)),getSettings:()=>ask({getVideoPixelAspectRatio:()=>ask('1')})};
 const project={guid:{toString:()=>'proj-1'},path:'C:/projeto.prproj',getActiveSequence:()=>ask(seq)};
 const ppro={Project:{getActiveProject:()=>ask(project)},TickTime:{createWithTicks:t=>tick(Number(t)/TPS),createWithSeconds:tick},
  Metadata:{getXMPMetadata:()=>ask(XMP)},ClipProjectItem:{cast:x=>x},Constants:{},EventManager:{addGlobalEventListener(){},removeGlobalEventListener(){}},
  Exporter:{exportSequenceFrame:()=>ask(()=>{files.set(lastName,true);return true;})}};
 const files=new Map();let lastName=null;
 const png=new Uint8Array([137,80,78,71,0,0,0,0,73,69,78,68,174,66,96,130]);
 const folder={nativePath:'C:/tmp',getEntries:async()=>[],getEntry:async n=>{if(!files.has(n))throw Error('missing');return {name:n,getMetadata:async()=>({size:png.length}),read:async()=>png.buffer,delete:async()=>files.delete(n)};}};
 const uxp={storage:{localFileSystem:{getTemporaryFolder:async()=>folder,getFsUrl:f=>'file:///'+f.name},formats:{binary:'binary'}}};
 const realNow=Date.now;
 return {ppro,uxp,setName:n=>{lastName=n;},get calls(){return calls;},get rounds(){return rounds;},reset(){calls=0;rounds=0;}};
}
const load=name=>require(path.join(root,name));
async function measure(mode,name,fn){
 const P=premiere(mode);const t0=Date.now();await fn(P);const ms=Date.now()-t0;
 return {name,mode,calls:P.calls,ms,trips:Math.round(ms/LAT)};
}
const flows={
 'troca de take: leitura do painel':async P=>{
  const engine=load('engine.js').createEngine(P.ppro,load('core.js'),null,{});
  if(engine.selectionsWithSummary)await engine.selectionsWithSummary();else{await engine.selections();await engine.selectionSummary();}
 },
 'troca de take: prévia (leitura + quadro)':async P=>{
  const H=load('preview-host.js');const next=await H.read(P.ppro);
  const now=Date.now;Date.now=()=>4242;P.setName('anchor-prototype-4242.png');
  try{await H.capture(P.ppro,P.uxp,next,()=>true,()=>Promise.resolve());}finally{Date.now=now;}
 },
 'conferência leve da seleção (a cada 2,5 s)':async P=>{await load('selection-watch.js').selectionStamp(P.ppro);},
 'Analisar: leituras antes do motor':async P=>{
  const engine=load('engine.js').createEngine(P.ppro,load('core.js'),null,{});
  if(engine.analysisSource){await engine.analysisSource();return;}
  const s=await engine.selection();await engine.sequenceFormat(s);await engine.mediaSource(s);await engine.selection();
 },
};
// Mesmos dados com as consultas juntas: leitura única = leituras separadas (e = versão anterior, com ANCHOR_BASELINE).
async function equivalence(){
 const assert=require('assert/strict');
 const dados=async folder=>{const P=premiere('lote'),req=n=>require(path.join(folder,n));const engine=req('engine.js').createEngine(P.ppro,req('core.js'),null,{});
  const s=await engine.selection(),f=await engine.sequenceFormat(s),m=await engine.mediaSource(s),all=await engine.selections(),sum=await engine.selectionSummary(),pv=await req('preview-host.js').read(P.ppro);
  return {engine,dados:{s,f,m,all,sum,key:pv.key,name:pv.name,format:pv.format}};};
 const atual=await dados(root);
 if(atual.engine.analysisSource){const a=await atual.engine.analysisSource();assert.deepEqual(a,{selection:atual.dados.s,sequenceFormat:atual.dados.f,media:atual.dados.m});}
 if(atual.engine.selectionsWithSummary){const b=await atual.engine.selectionsWithSummary();assert.deepEqual(b,{selections:atual.dados.all,summary:atual.dados.sum});}
 let base='sem versão anterior para comparar';
 if(process.env.ANCHOR_BASELINE){const antes=await dados(path.resolve(process.env.ANCHOR_BASELINE));assert.deepEqual(atual.dados,antes.dados);base='igual à versão anterior';}
 console.log('equivalência: leitura única = leituras separadas · '+base);
}
(async()=>{
 await equivalence();
 const rows=[];
 for(const [name,fn] of Object.entries(flows))for(const mode of ['fila','lote'])rows.push(await measure(mode,name,fn));
 console.log('Premiere simulado: cada resposta demora '+LAT+' ms · pasta: '+root);
 for(const r of rows)console.log(('  '+r.name).padEnd(46)+(' '+r.mode).padEnd(6)+String(r.calls).padStart(5)+' consultas'+String(r.trips).padStart(6)+' rodadas de espera');
 if(process.argv[3])require('fs').writeFileSync(process.argv[3],JSON.stringify(rows,null,1));
})().catch(e=>{console.error(e);process.exitCode=1;});
