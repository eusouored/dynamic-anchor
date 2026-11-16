'use strict';
// O UXP pode rejeitar promessas com valores que não são Error (texto, objeto
// nativo sem message, undefined). Tudo que chega ao painel ou ao registro passa
// por aqui para nunca virar "undefined".
function describe(error){
  if(error===undefined)return 'erro sem detalhe (undefined)';
  if(error===null)return 'erro sem detalhe (null)';
  if(typeof error==='string')return error||'erro vazio';
  if(typeof error!=='object'&&typeof error!=='function')return String(error);
  const parts=[];
  try{if(typeof error.message==='string'&&error.message)parts.push(error.message);}catch(_){}
  try{if(error.code!==undefined&&error.code!==null&&!parts.some(p=>p.includes(String(error.code))))parts.push('código '+String(error.code));}catch(_){}
  if(!parts.length){
    try{const names=Object.getOwnPropertyNames(error).filter(n=>{if(n==='stack')return false;try{const v=error[n];return v!==''&&v!==undefined&&v!==null;}catch(_){return false;}});if(names.length){const json=JSON.stringify(error,names);if(json&&json!=='{}')parts.push(json.slice(0,400));}}catch(_){}
  }
  if(!parts.length){try{const text=String(error);if(text&&text!=='[object Object]'&&text!=='Error')parts.push(text);}catch(_){}}
  return parts.join(' · ')||'erro sem detalhe ('+((error&&error.name)||(error&&error.constructor&&error.constructor.name)||typeof error)+')';
}
// Texto para o editor: o que houve e o que fazer. Sem prefixo de etapa ("[etapa]") e sem "código X";
// esse detalhe técnico continua em describe(), que vai para o registro.
function plain(error){
  let text=describe(error);
  text=text.replace(/^(\[[^\]]*\]\s*)+/,'').replace(/\s*·\s*código\s+\S+\s*$/,'');
  return text||'Não foi possível concluir. Tente de novo.';
}
function stack(error){try{return error&&error.stack?String(error.stack).split('\n').slice(0,4).join(' / '):'';}catch(_){return '';}}
function toError(error,prefix=''){
  const out=new Error((prefix?prefix+' ':'')+describe(error));
  try{if(error&&typeof error==='object'){if(error.code!==undefined)out.code=error.code;if(error.isServiceError)out.isServiceError=true;}}catch(_){}
  return out;
}
module.exports={describe,plain,stack,toError};
