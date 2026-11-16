'use strict';
function positive(value,label){if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw Error(label+' inválido.');return value;}
function pixelAspect(value){
  if(typeof value==='number')return positive(value,'Aspecto do pixel');
  if(typeof value!=='string')throw Error('Aspecto do pixel indisponível.');
  const s=value.trim().replace(',','.');
  if(/^\d+(\.\d+)?$/.test(s))return positive(Number(s),'Aspecto do pixel');
  const m=/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(s);
  if(m)return positive(Number(m[1])/positive(Number(m[2]),'Denominador'),'Aspecto do pixel');
  throw Error('Não foi possível interpretar o aspecto do pixel.');
}
function format(width,height,par){positive(width,'Largura');positive(height,'Altura');return{width,height,pixelAspect:pixelAspect(par),ratio:width*pixelAspect(par)/height};}
function fit(ratio,available,maxHeight,maxWidth){positive(ratio,'Proporção');const width=Math.max(1,Math.floor(Math.min(available,maxHeight*ratio,maxWidth||Infinity)));return{width,height:Math.max(1,Math.round(width/ratio))};}
function offset(value){return Math.max(-50,Math.min(50,Math.round(value)));}
function thumb(value,axis,extent){return Math.round(extent*(50+(axis==='y'?value:-value))/100);}
module.exports={pixelAspect,format,fit,offset,thumb};
