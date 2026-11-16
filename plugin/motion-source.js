'use strict';
// Read-only media/project XMP dimensions. Missing/ambiguous metadata never becomes a guessed
// source size based on sequence size or Motion's movable anchor point.
const {xmlTree}=require('./project-mask.js');
const DM='http://ns.adobe.com/xmp/1.0/DynamicMedia/',DIM='http://ns.adobe.com/xap/1.0/sType/Dimensions#';
const PROJECT='http://ns.adobe.com/premierePrivateProjectMetaData/1.0/';
const bad=()=>Error('Não foi possível confirmar o formato original da mídia nos metadados. Nada foi gravado em Movimento.');
function rational(value){
 const text=String(value??'').trim(),match=/^(\d+(?:\.\d+)?)(?:\s*[/,:]\s*(\d+(?:\.\d+)?))?$/.exec(text);
 if(!match)return NaN;const n=Number(match[1])/(match[2]===undefined?1:Number(match[2]));return Number.isFinite(n)&&n>0?n:NaN;
}
function metadataTree(xmp){
 if(typeof xmp!=='string'||!xmp.trim()||xmp.length>2*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(xmp))throw bad();
 try{return xmlTree('<PremiereData>'+xmp+'</PremiereData>');}catch(_){throw bad();}
}
function parseMediaFormatData(xmp,allowMissing){
 const tree=metadataTree(xmp);
 const dimensions=[],aspects=[];
 const expanded=(name,ns)=>{const colon=name.indexOf(':'),prefix=colon<0?'':name.slice(0,colon);return {uri:ns[prefix]||'',local:colon<0?name:name.slice(colon+1)};};
 const visit=(node,inherited,frame=null)=>{
  const ns={...inherited};for(const [key,value]of Object.entries(node.attrs))if(key==='xmlns')ns['']=value;else if(key.startsWith('xmlns:'))ns[key.slice(6)]=value;
  const tag=expanded(node.name,ns);
  if(tag.uri===DM&&tag.local==='videoFrameSize'){frame={w:[],h:[],unit:[]};dimensions.push(frame);}
  const read=(name,value)=>{
   const field=expanded(name,ns);
   if(field.uri===DM&&field.local==='videoPixelAspectRatio')aspects.push(rational(value));
   if(frame&&field.uri===DIM&&['w','h','unit'].includes(field.local))frame[field.local].push(String(value).trim());
  };
  read(node.name,node.text);
  for(const [key,value]of Object.entries(node.attrs))if(!key.startsWith('xmlns'))read(key,value);
  for(const child of node.children)visit(child,ns,frame);
 };
 visit(tree,{});
 const one=(values,number=false)=>{
  const result=[...new Set(values.map(v=>number?Number(v):v))];
  if(result.length!==1||number&&(!Number.isInteger(result[0])||result[0]<=0||result[0]>65536))throw bad();return result[0];
 };
 if(aspects.some(n=>!Number.isFinite(n)))throw bad();
 if(!dimensions.length&&allowMissing)return null;
 if(!dimensions.length||!aspects.length)throw bad();
 const formats=dimensions.map(d=>({width:one(d.w,true),height:one(d.h,true),unit:one(d.unit)}));
 if(formats.some(f=>f.unit!=='pixel'||f.width!==formats[0].width||f.height!==formats[0].height)||aspects.some(n=>Math.abs(n-aspects[0])>1e-12))throw bad();
 return {width:formats[0].width,height:formats[0].height,pixelAspect:aspects[0]};
}
function parseMediaFormat(xmp){return parseMediaFormatData(xmp,false);}
function parseProjectMediaFormat(xmp){
 const formats=[];
 const visit=(node,inherited)=>{
  const ns={...inherited};for(const [key,value]of Object.entries(node.attrs))if(key==='xmlns')ns['']=value;else if(key.startsWith('xmlns:'))ns[key.slice(6)]=value;
  const read=(name,value)=>{
   const colon=name.indexOf(':'),prefix=colon<0?'':name.slice(0,colon),local=colon<0?name:name.slice(colon+1);
   if(ns[prefix]!==PROJECT||local!=='Column.Intrinsic.VideoInfo')return;
   // Premiere's intrinsic format is localized: 3840 x 2160 (1,0) in pt-BR.
   // Read only this namespaced field and require the complete known form.
   const match=/^\s*(\d+)\s*[x×]\s*(\d+)\s*\(\s*(\d+(?:[.,]\d+)?)\s*\)\s*$/.exec(String(value));
   if(!match)throw bad();
   const width=Number(match[1]),height=Number(match[2]),pixelAspect=Number(match[3].replace(',','.'));
   if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=65536)||!Number.isFinite(pixelAspect)||pixelAspect<=0)throw bad();
   formats.push({width,height,pixelAspect});
  };
  read(node.name,node.text);for(const [key,value]of Object.entries(node.attrs))if(!key.startsWith('xmlns'))read(key,value);
  for(const child of node.children)visit(child,ns);
 };
 visit(metadataTree(xmp),{});
 if(!formats.length||formats.some(f=>f.width!==formats[0].width||f.height!==formats[0].height||Math.abs(f.pixelAspect-formats[0].pixelAspect)>1e-12))throw bad();
 return formats[0];
}
async function readMediaFormat(ppro,ctx){
 if(!ppro?.Metadata||typeof ppro.Metadata.getXMPMetadata!=='function'||typeof ctx.clip?.getProjectItem!=='function')throw bad();
 const item=await ctx.clip.getProjectItem();if(!item)throw bad();
 let format=parseMediaFormatData(await ppro.Metadata.getXMPMetadata(item),true);
 if(!format){
  if(typeof ppro.Metadata.getProjectMetadata!=='function')throw bad();
  format=parseProjectMediaFormat(await ppro.Metadata.getProjectMetadata(item));
 }
 // A footage interpretation override, when exposed, takes precedence over XMP.
 const cast=typeof ppro.ClipProjectItem?.cast==='function'?ppro.ClipProjectItem.cast(item):item;
 if(typeof cast?.getFootageInterpretation==='function'){
  const interpretation=await cast.getFootageInterpretation();
  if(typeof interpretation?.getPixelAspectRatio==='function'){
   const value=await interpretation.getPixelAspectRatio(),ratio=typeof value==='number'?value:rational(value);
   if(!Number.isFinite(ratio)||ratio<=0)throw bad();format.pixelAspect=ratio;
  }
 }
 return format;
}
module.exports={parseMediaFormat,parseProjectMediaFormat,readMediaFormat,rational};
