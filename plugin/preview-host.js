'use strict';
const G=require('./preview-geometry.js');
function seconds(value){if(!value||typeof value.seconds!=='number'||!Number.isFinite(value.seconds))throw Error('O Premiere não informou o tempo do trecho.');return value.seconds;}
async function read(ppro){
  const project=await ppro.Project.getActiveProject();if(!project)throw Error('Abra um projeto no Premiere.');
  const sequence=await project.getActiveSequence();if(!sequence)throw Error('Abra uma sequência no Premiere.');
  const rect=await sequence.getFrameSize(),settings=await sequence.getSettings();
  const format=G.format(rect.width===undefined?rect.right-rect.left:rect.width,rect.height===undefined?rect.bottom-rect.top:rect.height,await settings.getVideoPixelAspectRatio());
  const items=await(await sequence.getSelection()).getTrackItems(),video=[];
  for(const clip of items||[]){if(!clip||typeof clip.getComponentChain!=='function')continue;
    const chain=await clip.getComponentChain();let isVideo=false;
    for(let i=0,n=await chain.getComponentCount();i<n;i++){const comp=await chain.getComponentAtIndex(i);if(/AE\.ADBE Motion/i.test(await comp.getMatchName())){isVideo=true;break;}}
    if(isVideo)video.push(clip);
  }
  if(video.length!==1)return{sequence,format,key:null,name:video.length?'Selecione apenas um take':'Nenhum take selecionado',reason:video.length?'Selecione um único clipe de vídeo.':'Selecione um take na timeline.'};
  const clip=video[0],name=await clip.getName(),startTime=await clip.getStartTime(),endTime=await clip.getEndTime(),start=seconds(startTime),end=seconds(endTime),track=await clip.getTrackIndex();
  if(start<0||end<=start)throw Error('O intervalo do take é inválido.');
  const frameTicks=Number(await sequence.getTimebase());
  if(!Number.isSafeInteger(frameTicks)||frameTicks<=0)throw Error('O Premiere não informou a duração dos quadros.');
  const inPoint=seconds(await clip.getInPoint()),outPoint=seconds(await clip.getOutPoint()),item=await clip.getProjectItem(),mediaId=String(await item.getId());
  const key=JSON.stringify([String(project.guid||project.name||''),String(sequence.guid),track,mediaId,name,start,end,inPoint,outPoint,format.width,format.height,format.pixelAspect,frameTicks]);
  return{sequence,clip,name,start,end,startTime,endTime,frameTicks,format,key};
}
async function capture(ppro,uxp,expected,isCurrent,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))){
  const before=await read(ppro);if(before.key!==expected.key||!isCurrent())throw Error('A seleção mudou antes da captura.');
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
    const after=await read(ppro);if(after.key!==expected.key||!isCurrent())throw Error('A seleção mudou durante a captura.');
    return{file,url:fs.getFsUrl(file),width:size.width,height:size.height};
  }catch(error){if(file)try{await file.delete();}catch(_){}throw error;}
}
module.exports={read,capture,seconds};
