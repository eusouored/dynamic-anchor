'use strict';
// Premiere 26.5 PRMF v3 index. Only the frame time and bounding rectangle are
// read; compressed pixels and the user's mask data are never changed.
const TICKS=254016000000;
function index(bytes){
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  if(b.byteLength<120)throw new Error('Arquivo de máscara de objeto inválido.');
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength),u32=o=>v.getUint32(o,true),u64=o=>u32(o)+u32(o+4)*4294967296;
  if(String.fromCharCode(...b.slice(0,4))!=='prmf'||u32(4)!==3)throw new Error('Formato da máscara de objeto não reconhecido.');
  const dataEnd=u64(8),metaLength=u64(16);
  if(!Number.isSafeInteger(dataEnd)||dataEnd<32||dataEnd+metaLength!==b.byteLength)throw new Error('Índice da máscara de objeto inválido.');
  return parseMetadata(b.subarray(dataEnd),dataEnd);
}
function parseMetadata(bytes,dataEnd){
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  const u32=o=>v.getUint32(o,true),u64=o=>u32(o)+u32(o+4)*4294967296;
  if(b.byteLength<88||b.byteLength>32*1024*1024)throw new Error('Índice da máscara de objeto inválido ou grande demais.');
  const root=u32(0);
  if(root<4||root+16>b.byteLength)throw new Error('Índice da máscara de objeto inválido.');
  const vec=root+4+u32(root+4);
  if(vec<root+16||vec+4>b.byteLength)throw new Error('Índice da máscara de objeto inválido.');
  const count=u32(vec);
  if(count<1||vec+4+count*4>b.byteLength)throw new Error('Quantidade de quadros da máscara de objeto inválida.');
  const frames=[];let W=0,H=0,skippedRecords=0;
  for(let i=0;i<count;i++){
    try{
    const element=vec+4+i*4,record=element+u32(element);
    if(record<vec+4+count*4||record+4>b.byteLength)throw new Error('Quadro da máscara de objeto inválido.');
    // PRMF uses FlatBuffers tables. The first frame omits the default time 0,
    // and Premiere may omit other default-valued fields, changing record size.
    const table=record-v.getInt32(record,true);
    if(table<4||table+18>b.byteLength)throw new Error('Quadro da máscara de objeto inválido.');
    const tableSize=v.getUint16(table,true),recordSize=v.getUint16(table+2,true);
    if(tableSize<18||table+tableSize>b.byteLength||record+recordSize>b.byteLength)throw new Error('Quadro da máscara de objeto inválido.');
    const field=(index,size)=>{
      const entry=table+4+index*2;
      if(entry+2>table+tableSize)throw new Error('Quadro da máscara de objeto inválido.');
      const offset=v.getUint16(entry,true);
      if(!offset)return null;
      if(offset+size>recordSize||record+offset+size>b.byteLength)throw new Error('Quadro da máscara de objeto inválido.');
      return record+offset;
    };
    const typeAt=field(0,4),tickAt=field(1,8),offsetAt=field(2,4),rectAt=field(3,16),sizeAt=field(4,8),lengthAt=field(6,4);
    if([typeAt,offsetAt,rectAt,sizeAt,lengthAt].some(x=>x===null)||u32(typeAt)!==1)throw new Error('Quadro da máscara de objeto inválido.');
    const x=u32(rectAt),y=u32(rectAt+4),w=u32(rectAt+8),h=u32(rectAt+12),width=u32(sizeAt),height=u32(sizeAt+4),length=u32(lengthAt),tick=tickAt===null?0:u64(tickAt),offset=u32(offsetAt);
    if(!(width>0&&height>0&&width<=16384&&height<=16384&&w>0&&h>0&&x+w<=width&&y+h<=height&&length>0&&offset>=32&&offset+length<=dataEnd&&Number.isSafeInteger(tick)))
      throw new Error('Área ou tempo da máscara de objeto inválido.');
    if(frames.length&&(W!==width||H!==height))throw new Error('O formato da máscara de objeto muda entre quadros.');
    W=width;H=height;frames.push({tick,x:x+w/2,y:y+h/2,width:w,height:h,area:w*h});
    }catch(error){
      // Premiere stores these records in arbitrary order and interrupted tracking
      // can leave one damaged. Only validated records are eligible for a clip.
      skippedRecords++;
    }
  }
  if(!frames.length)throw new Error('Nenhum quadro válido na máscara de objeto.');
  frames.sort((a,b)=>a.tick-b.tick);
  const unique=[];let duplicateFrames=0;
  for(const frame of frames){
    const previous=unique[unique.length-1];
    if(previous&&previous.tick===frame.tick){
      if(Math.abs(previous.x-frame.x)>1e-5||Math.abs(previous.y-frame.y)>1e-5)throw new Error('Quadros conflitantes na máscara de objeto.');
      duplicateFrames++;continue;
    }
    unique.push(frame);
  }
  return {W,H,frames:unique,skippedRecords,duplicateFrames};
}
function forClip(data,clip,{allowPartial=false}={}){
  if(data.W!==clip.W||data.H!==clip.H)throw new Error('A máscara de objeto tem formato diferente do clipe.');
  const {frames}=data,count=Math.ceil((clip.sourceEnd-clip.sourceStart)*clip.fps-1e-7);
  if(!Number.isSafeInteger(count)||count<2)throw new Error('Intervalo do trecho inválido para a máscara de objeto.');
  let smallest=Infinity;for(let i=1;i<frames.length;i++)smallest=Math.min(smallest,frames[i].tick-frames[i-1].tick);
  if(!(smallest>0&&smallest<=TICKS/2))throw new Error('A máscara de objeto não contém um rastreio por quadro.');
  const step=TICKS/clip.fps,tolerance=Math.max(1,step*.51),rows=[],times=[];let repairedFrames=0;
  const firstFrame=allowPartial?Math.max(0,Math.ceil((frames[0].tick-clip.sourceStart*TICKS)/step-.51)):0;
  if(firstFrame>=count)throw new Error('O rastreio da máscara de objeto não cobre todo o trecho selecionado.');
  for(let i=firstFrame;i<count;i++){
    const tick=(clip.sourceStart+i/clip.fps)*TICKS;
    let lo=0,hi=frames.length-1;
    while(lo<hi){const mid=Math.floor((lo+hi)/2);if(frames[mid].tick<tick)lo=mid+1;else hi=mid;}
    const b=frames[lo],a=frames[Math.max(0,lo-1)],nearest=Math.abs(a.tick-tick)<=Math.abs(b.tick-tick)?a:b;
    let point=nearest;
    if(Math.abs(nearest.tick-tick)>tolerance){
      const before=lo>0?frames[lo-1]:null,after=frames[lo];
      if(!before||!after||!(before.tick<tick&&tick<after.tick)||after.tick-before.tick>step*2.1){
        // Perda no MEIO (há rastreio antes e depois): não é fim do rastreio, então não se corta em silêncio.
        if(before&&after&&before.tick<tick&&tick<after.tick){
          const sec=t=>(Number(t)/254016000000).toFixed(2).replace('.',',');
          const error=new Error('A máscara de objeto perde o rastreio de '+sec(before.tick)+' a '+sec(after.tick)+' s e volta depois. Rastreie esse trecho de novo ou divida o take na perda. Nada foi aplicado.');error.code='ANCHOR_OBJECT_GAP';throw error;
        }
        if(allowPartial&&rows.length>=2)break;
        throw new Error('O rastreio da máscara de objeto não cobre todo o trecho selecionado.');
      }
      const mix=(tick-before.tick)/(after.tick-before.tick);
      point={x:before.x+(after.x-before.x)*mix,y:before.y+(after.y-before.y)*mix};
      for(const key of ['area','width','height'])if(Number.isFinite(before[key])&&Number.isFinite(after[key]))point[key]=before[key]+(after[key]-before[key])*mix;
      repairedFrames++;
    }
    const row={frame:i-firstFrame,x:point.x,y:point.y,angle:0};
    for(const key of ['area','width','height'])if(Number.isFinite(point[key]))row[key]=point[key];
    rows.push(row);times.push(tick/TICKS);
  }
  if(rows.length<2)throw new Error('A máscara de objeto precisa de pelo menos 2 quadros rastreados dentro do trecho.');
  const partial=firstFrame>0||rows.length<count;
  return {...clip,rows,times,rotationSupported:false,repairedFrames,skippedRecords:data.skippedRecords||0,duplicateFrames:data.duplicateFrames||0,
    partial,firstTrackedTime:times[0],coveredStart:times[0],lastTrackedTime:times[times.length-1],coveredEnd:times[times.length-1]+1/clip.fps};
}
function forSources(sources,clip){
  const refs=new Set(clip.objectRefs||[]);
  const linked=sources.filter(source=>refs.has(source.id.toLowerCase()));
  if(!linked.length)throw new Error(clip.selection.name+': os arquivos desta máscara de objeto não foram encontrados. Complete o rastreamento e salve o projeto.');
  const candidates=[],failures=[];
  for(const source of linked)try{candidates.push(forClip(source.index,clip,{allowPartial:true}));}catch(error){failures.push(error);}
  if(!candidates.length){
    const tracked=linked.filter(source=>source.index.frames.length>1).sort((a,b)=>b.index.frames.length-a.index.frames.length)[0];
    if(tracked){const first=tracked.index.frames[0].tick/TICKS,last=tracked.index.frames[tracked.index.frames.length-1].tick/TICKS;
      if(first>clip.sourceStart+1/clip.fps)throw new Error(clip.selection.name+': máscara salva a partir de '+first.toFixed(2)+' s; trecho começa em '+clip.sourceStart.toFixed(2)+' s. Rastreie desde o início e salve.');
      if(last<clip.sourceEnd-1/clip.fps)throw new Error(clip.selection.name+': máscara salva até '+last.toFixed(2)+' s; trecho vai até '+clip.sourceEnd.toFixed(2)+' s. Rastreie até o fim e salve.');}
    const refusal=new Error(clip.selection.name+': '+(failures[0]?.message||'a máscara de objeto não cobre todo o trecho. Complete o rastreamento e salve o projeto.'));if(failures[0]?.code)refusal.code=failures[0].code;throw refusal;
  }
  candidates.sort((a,b)=>b.rows.length-a.rows.length);
  const best=candidates[0];
  for(const other of candidates.slice(1)){
    let j=0;
    for(let i=0;i<other.rows.length;i++){
    while(j<best.times.length&&best.times[j]<other.times[i]-1e-7)j++;
    if(j<best.times.length&&Math.abs(best.times[j]-other.times[i])<1e-7&&(Math.abs(best.rows[j].x-other.rows[i].x)>1e-5||Math.abs(best.rows[j].y-other.rows[i].y)>1e-5))
      throw new Error(clip.selection.name+': há rastreamentos de objeto diferentes para esta máscara. Rastreie novamente o trecho e salve o projeto.');
    }
  }
  return best;
}
async function indexFile(entry,{fs,localFileSystem,binary,onFallback=()=>{}}){
  // Only an entry already authorized by the user is passed to the native reader.
  if(!fs?.open||!fs?.read||!fs?.close||!localFileSystem?.getFsUrl){onFallback('Leitura por intervalos indisponível; usando o leitor compatível.');return index(new Uint8Array(await entry.read({format:binary})));}
  let fd;
  try{fd=await fs.open(localFileSystem.getFsUrl(entry),'r');}catch(error){onFallback('Acesso por intervalos indisponível; usando o arquivo autorizado. '+error.message);return index(new Uint8Array(await entry.read({format:binary})));}
  try{
    const before=await entry.getMetadata();
    async function range(position,length){
      const buffer=new ArrayBuffer(length);let offset=0;
      while(offset<length){const result=await fs.read(fd,buffer,offset,length-offset,position+offset);if(!result||!Number.isInteger(result.bytesRead)||result.bytesRead<=0||result.bytesRead>length-offset)throw Error('Arquivo de máscara incompleto durante a leitura. Salve o rastreamento e atualize.');offset+=result.bytesRead;}
      return new Uint8Array(buffer);
    }
    const header=await range(0,32),view=new DataView(header.buffer),u64=offset=>view.getUint32(offset,true)+view.getUint32(offset+4,true)*4294967296;
    if(String.fromCharCode(header[0],header[1],header[2],header[3])!=='prmf'||view.getUint32(4,true)!==3)throw Error('Formato da máscara de objeto não reconhecido.');
    const dataEnd=u64(8),length=u64(16);
    if(!Number.isSafeInteger(dataEnd)||!Number.isSafeInteger(length)||dataEnd<32||length<88||length>32*1024*1024||dataEnd+length!==before.size)throw Error('Índice da máscara de objeto inválido ou grande demais.');
    const metadata=await range(dataEnd,length),after=await entry.getMetadata();
    if(before.size!==after.size||String(before.dateModified)!==String(after.dateModified))throw Error('A máscara mudou durante a leitura. Aguarde o Premiere e atualize.');
    return {...parseMetadata(metadata,dataEnd),readBytes:32+length,fileBytes:before.size,rangeRead:true};
  }finally{await fs.close(fd);}
}
module.exports={index,indexFile,forClip,forSources};
