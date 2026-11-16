'use strict';
// Premiere simulado para o destino Movimento: roda o código real do motion-engine (preview = leitura
// da geometria + conta + conferência dos keyframes, sem gravar) contra clipes simulados e confere o
// resultado com o modelo do Premiere:
//   saída = K.escala·(Posição + escala·(ponto_mídia − Âncora)) + K.deslocamento
// Para cada cenário aceito: rosto no alvo em todos os quadros e o vídeo cobrindo o quadro (zoom automático).
// Para os recusados: a mensagem esperada.
const path=require('path'),root=process.env.ANCHOR_TEST_ROOT||path.resolve(__dirname,'../plugin');
const C=require(path.join(root,'core.js')),M=require(path.join(root,'motion-geometry.js'));
const {createMotionEngine}=require(path.join(root,'motion-engine.js'));

const tick=s=>({seconds:s,ticks:String(Math.round(s*254016000000))});
const ppro={TickTime:{createWithSeconds:tick},PointF:function(x,y){this.x=x;this.y=y;}};
function param(name,value){return {name,displayName:name,value,param:{displayName:name,isTimeVarying:async()=>false,areKeyframesSupported:async()=>true,
  getKeyframeListAsTickTimes:async()=>[],getValueAtTime:async()=>value}};}

function cenario(c){
 const media={width:c.media[0],height:c.media[1],pixelAspect:c.mediaPar||1},W=c.seq[0],H=c.seq[1],fps=c.fps||30;
 const canvas=M.sourceCanvas(media,W,H),SW=canvas.width,SH=canvas.height,r=canvas.ratio;
 const n=45,t0=10,times=Array.from({length:n},(_,i)=>t0+i/fps);
 // rosto andando no quadro do vídeo (coordenadas do rastreio)
 const rows=times.map((t,i)=>({frame:i,x:SW*(.4+.2*i/(n-1)),y:SH*(.42+.06*Math.sin(i/5)),angle:0}));
 const anchorN=c.anchor||{x:.5,y:.5},rotation=c.rotation||0,motionScale=c.scale||100;
 const crop=c.crop||0;
 const motionComp={getParamCount:async()=>c.cropSchema===false?6:11,getParam:async i=>({displayName:['Posição','Escala','Escala largura','Escala uniforme','Rotação','Âncora','Antitremor','Corte à esquerda','Corte superior','Corte à direita','Corte inferior'][i],
   isTimeVarying:async()=>false,getValueAtTime:async()=>i>=7?crop:0})};
 const comps=(c.stack||['Movimento']).map(name=>({match:name==='Movimento'?'AE.ADBE Motion':name==='Transformar'?'AE.ADBE Geometry2':name==='Lumetri'?'AE.ADBE Lumetri':name==='Recortar'?'AE.ADBE Crop':'AE.ADBE '+name,comp:name==='Movimento'?motionComp:{}}));
 const ctx={clip:{getInPoint:async()=>tick(t0-.5),getOutPoint:async()=>tick(t0+n/fps+1)},
  seq:{getSettings:async()=>({getVideoPixelAspectRatio:async()=>String(c.seqPar||1)})},
  motion:{comp:motionComp},position:param('Posição',new ppro.PointF(.5,.5)),scale:param('Escala',motionScale),
  anchor:param('Âncora',new ppro.PointF(anchorN.x,anchorN.y)),rotation:param('Rotação',rotation),uniform:param('Escala uniforme',true),comps};
 const K=c.K||{scale:1,t:{x:0,y:0}};
 const host={context:async()=>ctx,readValue:async(info)=>info.param.getValueAtTime(),
  readMediaFormat:async()=>{if(c.nested)throw Error('Não foi possível confirmar o formato original da mídia nos metadados. Nada foi gravado em Movimento.');return media;},
  upstreamGeometry:async(effects,ts)=>({scale:effects.length?K.scale:1,translations:ts.map(()=>effects.length?{...K.t}:{x:0,y:0})}),
  motionGuard:{isMotion:()=>false},legacyGuard:{validate:async()=>true},transact:async()=>{throw Error('o teste não grava');}};
 const engine=createMotionEngine({ppro,C,checkpoint:null,host});
 const settings={destination:'motion',W,H,fps,refIndex:0,sourceTimes:times,sourceSelection:null,replace:true,resetScale:false,
  opt:{useX:true,useY:true,rotation:false,target:{x:W/2,y:H/2},targetOffset:{x:0,y:0},maxRot:0,deadzone:0,smoothWin:0,anchor:{x:SW/2,y:SH/2},
   source:{w:SW,h:SH},scaleMode:'auto',minimumCover:true,autoLimit:false,maxScale:10,frame:{w:W,h:H}}};
 return {run:async()=>{
  const keys=await engine.preview(rows,settings),g=keys.meta.geometry;
  let erro=0,borda=0;
  keys.forEach((k,i)=>{
   const nv=M.nativeValues(C,keys,i,{W:g.W,H:g.H,ratio:g.ratio,K:g.K,anchorVirtual:g.sourceTransform[i].anchor,rotationBase:g.rotationBase||0});
   const s=nv.scale/100,P={x:nv.position.x*W,y:nv.position.y*H},A={x:anchorN.x*media.width,y:anchorN.y*media.height},ang=(rotation)*Math.PI/180;
   const out=p=>{const dx=p.x-A.x,dy=p.y-A.y,rx=dx*Math.cos(ang)-dy*Math.sin(ang),ry=dx*Math.sin(ang)+dy*Math.cos(ang);
    return {x:g.K.scale*(P.x+s*rx)+g.K.translations[i].x,y:g.K.scale*(P.y+s*ry)+g.K.translations[i].y};};
   // rosto: coordenada do rastreio (quadro do vídeo) → pixels da mídia
   const f=out({x:rows[i].x*r,y:rows[i].y*r});erro=Math.max(erro,Math.hypot(f.x-W/2,f.y-H/2));
   // cobertura: os 4 cantos da saída precisam cair dentro da mídia (inverte o modelo numericamente pelos cantos da mídia)
   const cs=[out({x:0,y:0}),out({x:media.width,y:0}),out({x:media.width,y:media.height}),out({x:0,y:media.height})];
   const dentro=q=>{let sinal=0;for(let j=0;j<4;j++){const a=cs[j],b=cs[(j+1)%4],v=(b.x-a.x)*(q.y-a.y)-(b.y-a.y)*(q.x-a.x);if(Math.abs(v)<1e-6)continue;const sg=Math.sign(v);if(sinal&&sg!==sinal)return false;sinal=sg;}return true;};
   if(![{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}].every(dentro))borda++;
  });
  return {erro,borda,escala:(keys.meta.scale*100/g.ratio).toFixed(1)+'%',quadroVideo:SW.toFixed(1)+'x'+SH.toFixed(1)};
 }};
}

const CASOS=[
 {nome:'mesma proporção 4K em 1080p',media:[3840,2160],seq:[1920,1080]},
 {nome:'vertical 9:16 (4K em 1080x1920)',media:[3840,2160],seq:[1080,1920]},
 {nome:'quadrada 1:1',media:[3840,2160],seq:[1080,1080]},
 {nome:'4:5 (Instagram)',media:[3840,2160],seq:[1080,1350]},
 {nome:'vídeo vertical em sequência 16:9',media:[1080,1920],seq:[1920,1080]},
 {nome:'21:9 em 16:9',media:[2560,1080],seq:[1920,1080]},
 {nome:'FPS diferente (seq 25, mídia 59,94)',media:[3840,2160],seq:[1920,1080],fps:25},
 {nome:'FPS 23,976',media:[1920,1080],seq:[1920,1080],fps:24000/1001},
 {nome:'âncora do Movimento deslocada',media:[3840,2160],seq:[1080,1920],anchor:{x:.3,y:.65}},
 {nome:'Movimento com escala 150% antes',media:[3840,2160],seq:[1920,1080],scale:150},
 {nome:'Movimento já girado 8°',media:[3840,2160],seq:[1080,1920],rotation:8},
 {nome:'Transformar depois do Movimento',media:[3840,2160],seq:[1080,1920],stack:['Movimento','Transformar'],K:{scale:1.1,t:{x:30,y:-20}}},
 {nome:'efeito de cor antes do Movimento',media:[3840,2160],seq:[1080,1920],stack:['Lumetri','Movimento']},
 {nome:'Movimento sem controles de corte (esquema antigo)',media:[1920,1080],seq:[1080,1080],cropSchema:false},
 {nome:'Transformar ANTES do Movimento',media:[3840,2160],seq:[1920,1080],stack:['Transformar','Movimento'],recusa:/efeito geométrico antes de Movimento/},
 {nome:'Recortar depois do Movimento',media:[3840,2160],seq:[1920,1080],stack:['Movimento','Recortar'],recusa:/efeito geométrico incompatível depois/},
 {nome:'corte no próprio Movimento',media:[3840,2160],seq:[1920,1080],crop:5,recusa:/corte diferente de zero/},
 {nome:'aspecto do pixel diferente',media:[1440,1080],mediaPar:1.333,seq:[1920,1080],recusa:/mesmo aspecto do pixel/},
 {nome:'sequência aninhada / subsequência',media:[1920,1080],seq:[1920,1080],nested:true,recusa:/formato original da mídia/},
];
(async()=>{let falhas=0;
 for(const c of CASOS){
  let linha;
  try{const r=await cenario(c).run();
   const ok=!c.recusa&&r.erro<1e-6&&r.borda===0;if(!ok)falhas++;
   linha=(ok?'ok   ':'FALHA')+' '+c.nome.padEnd(46)+(c.recusa?' (devia recusar)':'')+' erro no alvo '+r.erro.toExponential(1)+' px · bordas '+r.borda+' · escala '+r.escala+' · quadro do vídeo '+r.quadroVideo;
  }catch(e){const ok=c.recusa&&c.recusa.test(e.message);if(!ok)falhas++;linha=(ok?'ok   ':'FALHA')+' '+c.nome.padEnd(46)+(ok?' recusa: ':' ERRO: ')+e.message;}
  console.log(linha);
 }
 console.log(falhas?falhas+' falha(s)':'todos os cenários ok');process.exit(falhas?1:0);})();
