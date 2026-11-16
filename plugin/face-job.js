'use strict';
// Pedido para o motor de rosto externo (motor-rosto/anchor_rosto.py).
// O pedido só descreve o take; nenhum vídeo, efeito ou projeto é alterado.
const T=require('./trajectory.js');
function requestId(){return 'rl-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)+Math.random().toString(36).slice(2,10);}
function build({selection,format,media,id=requestId()}){
  T.identity(selection);
  if(!format||![format.width,format.height,format.fps].every(n=>Number.isFinite(n)&&n>0))throw Error('Formato da sequência indisponível.');
  const mediaPath=media&&typeof media.mediaPath==='string'&&media.mediaPath?media.mediaPath:null;
  const proxyPath=media&&typeof media.proxyPath==='string'&&media.proxyPath?media.proxyPath:null;
  return JSON.stringify({format:'anchor-face-job',version:1,requestId:id,createdAt:new Date().toISOString(),
    mediaPath,proxyPath,inPoint:selection.inPoint,outPoint:selection.outPoint,
    width:format.width,height:format.height,fps:format.fps,selection},null,1);
}
function fileName(selection){
  const base=String(selection&&selection.name||'take').replace(/\.[^.]+$/,'').replace(/[^\w\-]+/g,'_').slice(0,60)||'take';
  return 'Anchor-pedido-rosto-'+base+'.json';
}
module.exports={build,fileName,requestId};
