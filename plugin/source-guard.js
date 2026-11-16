'use strict';
const normalizePath=value=>String(value||'').replace(/\\/g,'/').replace(/^\/\/\?\/unc\//i,'//').replace(/^\/\/\?\//,'').toLowerCase().replace(/\/+$/,'');
function fromJob(job){
  if(!job||typeof job.mediaPath!=='string'||!job.mediaPath.trim()||![job.width,job.height,job.fps].every(n=>Number.isFinite(n)&&n>0))
    throw Error('A análise não informou a mídia e o formato necessários para identificar sua origem. Faça uma nova análise.');
  return {mediaPath:normalizePath(job.mediaPath),width:job.width,height:job.height,fps:job.fps};
}
// Tamanho e data do arquivo: mídia regravada no mesmo caminho (reexportada, trocada) não pode herdar o trajeto antigo.
// O UXP expõe isso por getMetadata(); onde não estiver disponível o carimbo segue sem esses campos (compatível com antigos).
async function fileSignature(mediaPath,getUxp=()=>require('uxp')){
  try{
    const fs=getUxp().storage.localFileSystem,entry=await fs.getEntryWithUrl('file:'+String(mediaPath).replace(/\\/g,'/')),meta=await entry.getMetadata();
    const size=Number(meta.size),modified=meta.dateModified instanceof Date?meta.dateModified.getTime():Number(meta.dateModified);
    return Number.isFinite(size)&&size>=0&&Number.isFinite(modified)?{mediaSize:size,mediaModified:modified}:null;
  }catch(_){return null;}
}
async function stampFor(job,getUxp){return {...fromJob(job),...(await fileSignature(job.mediaPath,getUxp)||{})};}
function validateStamp(stamp){
  if(!stamp||typeof stamp.mediaPath!=='string'||!stamp.mediaPath||![stamp.width,stamp.height,stamp.fps].every(n=>Number.isFinite(n)&&n>0))
    throw Error('A análise salva não tem identificação verificável da mídia de origem. Faça uma nova análise antes de reaplicar.');
  return stamp;
}
async function verify(stamp,selection,engine){
  validateStamp(stamp);
  try{
    if(!engine||typeof engine.mediaSource!=='function'||typeof engine.sequenceFormat!=='function')throw Error('O Premiere não disponibilizou a identificação atual da mídia e da sequência.');
    const [media,format]=await Promise.all([engine.mediaSource(selection),engine.sequenceFormat(selection)]);
    const current=fromJob({mediaPath:media&&media.mediaPath,...format});
    if(stamp.mediaSize!==undefined&&stamp.mediaModified!==undefined){
      const signature=await fileSignature(media&&media.mediaPath);
      if(signature&&(signature.mediaSize!==stamp.mediaSize||signature.mediaModified!==stamp.mediaModified))
        throw Error('A mídia ou o formato da sequência mudou desde a análise: o arquivo de vídeo foi regravado. Faça uma nova análise do rosto antes de confirmar ou reaplicar o trajeto.');
    }
    if(current.mediaPath!==normalizePath(stamp.mediaPath)||current.width!==stamp.width||current.height!==stamp.height||Math.abs(current.fps-stamp.fps)>1e-6)
      throw Error('A mídia ou o formato da sequência mudou desde a análise. Faça uma nova análise do rosto antes de confirmar ou reaplicar o trajeto.');
    return true;
  }catch(error){
    if(/mídia ou o formato da sequência mudou|não tem identificação verificável/.test(String(error&&error.message)))throw error;
    throw Error('Não foi possível conferir a mídia e o formato atuais. Faça uma nova análise do rosto antes de confirmar ou reaplicar o trajeto. ('+String(error&&error.message||error)+')');
  }
}
module.exports={normalizePath,fromJob,stampFor,fileSignature,validateStamp,verify};
