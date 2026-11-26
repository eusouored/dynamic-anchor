'use strict';
const G=require('./preview-geometry.js');
function seconds(value){if(!value||typeof value.seconds!=='number'||!Number.isFinite(value.seconds))throw Error('O Premiere não informou o tempo do trecho.');return value.seconds;}
async function read(ppro){
  const project=await ppro.Project.getActiveProject();if(!project)throw Error('Abra um projeto no Premiere.');
  const sequence=await project.getActiveSequence();if(!sequence)throw Error('Abra uma sequência no Premiere.');
  // 1.7.7: consultas independentes vão juntas ao Premiere (com ele ocupado, cada resposta pode demorar).
  const [rect,settings,selection]=await Promise.all([sequence.getFrameSize(),sequence.getSettings(),sequence.getSelection()]);
  const [pixelAspect,items]=await Promise.all([settings.getVideoPixelAspectRatio(),selection.getTrackItems()]);
  const format=G.format(rect.width===undefined?rect.right-rect.left:rect.width,rect.height===undefined?rect.bottom-rect.top:rect.height,pixelAspect);
  const isVideo=await Promise.all((items||[]).map(async clip=>{
    if(!clip||typeof clip.getComponentChain!=='function')return false;
    const chain=await clip.getComponentChain(),n=await chain.getComponentCount();
    const comps=await Promise.all(Array.from({length:n},(_,i)=>chain.getComponentAtIndex(i)));
    return (await Promise.all(comps.map(comp=>comp.getMatchName()))).some(match=>/AE\.ADBE Motion/i.test(match));
  }));
  const video=(items||[]).filter((_,i)=>isVideo[i]);
  if(video.length!==1)return{sequence,format,key:null,name:video.length?'Selecione apenas um take':'Nenhum take selecionado',reason:video.length?'Selecione um único clipe de vídeo.':'Selecione um take na timeline.'};
  const clip=video[0];
  const [name,startTime,endTime,track,timebase,inTime,outTime,item]=await Promise.all([clip.getName(),clip.getStartTime(),clip.getEndTime(),clip.getTrackIndex(),sequence.getTimebase(),clip.getInPoint(),clip.getOutPoint(),clip.getProjectItem()]);
  const start=seconds(startTime),end=seconds(endTime);
  if(start<0||end<=start)throw Error('O intervalo do take é inválido.');
  const frameTicks=Number(timebase);
  if(!Number.isSafeInteger(frameTicks)||frameTicks<=0)throw Error('O Premiere não informou a duração dos quadros.');
  const inPoint=seconds(inTime),outPoint=seconds(outTime),mediaId=String(await item.getId());
  const key=JSON.stringify([String(project.guid||project.name||''),String(sequence.guid),track,mediaId,name,start,end,inPoint,outPoint,format.width,format.height,format.pixelAspect,frameTicks]);
  return{sequence,clip,name,start,end,startTime,endTime,frameTicks,format,key};
}
async function capture(ppro,uxp,expected,isCurrent,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
  // 1.7.7: o take acabou de ser lido (expected); quem chama descarta a captura se a seleção mudar.
  // A releitura completa antes de exportar só repetia consultas. A conferência depois da exportação continua.
  if(!expected||!expected.key||!isCurrent())throw Error('A seleção mudou antes da captura.');
  const before=expected;
  const fs=uxp.storage.localFileSystem,folder=await fs.getTemporaryFolder(),size=G.fit(expected.format.ratio,960,960,960),name='anchor-prototype-'+Date.now()+'.png';
  let file=null;
  try{
    // Reload can interrupt asynchronous unload cleanup. Only our own PNGs in
    // this plugin's private temporary folder are eligible for removal.
    for(const old of await folder.getEntries())if(/^anchor-prototype-\d+(?:-gray)?\.png$/.test(old.name))try{await old.delete();}catch(_){}
    const fullPath=folder.nativePath.replace(/[\\/]+$/,'')+'/'+name;
    // Keep Premiere's exact clip time. A seconds round-trip at a cut can land
    // before its frame boundary. A quarter-frame inset stays in the first frame
    // with either floor or nearest-frame sampling, including fractional rates.
    const quarterFrame=ppro.TickTime.createWithTicks(String(Math.floor(before.frameTicks/4)));
    const halfClip=before.endTime.subtract(before.startTime).divide(2);
    const inset=seconds(halfClip)<seconds(quarterFrame)?halfClip:quarterFrame;
    const captureTime=before.startTime.add(inset);
    const ok=await ppro.Exporter.exportSequenceFrame(before.sequence,captureTime,fullPath,folder.nativePath,size.width,size.height);
    if(ok!==true)throw Error('O Premiere não exportou o primeiro frame.');
    let ready=false;
    for(let attempt=0;attempt<50;attempt++){
      try{
        file=await folder.getEntry(name);
        if((await file.getMetadata()).size>0){
          // The exporter can resolve while the PNG is still being written.
          // Publishing a partial file lets UXP cache a failed image decode.
          const bytes=new Uint8Array(await file.read({format:uxp.storage.formats.binary}));
          const end=[73,69,78,68,174,66,96,130];
          ready=bytes.length>=end.length&&end.every((byte,i)=>bytes[bytes.length-end.length+i]===byte);
        }
      }catch(_){}
      if(ready)break;
      await wait(100);
    }
    if(!ready)throw Error('O arquivo do primeiro frame não ficou disponível. Atualize para tentar novamente.');
    // 1.7.7: quem chama troca o "isCurrent" a cada troca de take; uma releitura completa aqui só somava consultas.
    if(!isCurrent())throw Error('A seleção mudou durante a captura.');
    return{file,url:fs.getFsUrl(file),width:size.width,height:size.height};
  }catch(error){if(file)try{await file.delete();}catch(_){}throw error;}
}
module.exports={read,capture,seconds};
