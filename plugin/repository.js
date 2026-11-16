'use strict';
const I=require('./integrity.js');
// Two independently verified slots: a failed/truncated write never overwrites
// the last good generation. No reliance on undocumented filesystem atomicity.

// Formato compacto (sem perda): listas longas de objetos iguais viram colunas, com tabela de textos repetidos.
// Um take de 60 min a 59,94 passa de ~100 MB em JSON de objetos para ~30 MB, abaixo do limite de 64 MB.
const isPlain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function flat(o,path,out){
  for(const k of Object.keys(o)){const v=o[k],p=path.concat(k);
    if(isPlain(v)){if(!flat(v,p,out))return false;}
    else if(Array.isArray(v))return false;
    else if(v!==undefined)out.push([JSON.stringify(p),v]);}
  return true;
}
function packList(list){
  const cols=new Map(),rows=[];
  for(const item of list){
    if(!isPlain(item))return null;const cells=[];if(!flat(item,[],cells))return null;
    const row=new Map();for(const [p,v] of cells){if(!cols.has(p))cols.set(p,cols.size);row.set(p,v);}rows.push(row);
  }
  const names=[...cols.keys()],out=names.map(p=>({p:JSON.parse(p),v:[],m:[]}));
  rows.forEach((row,r)=>names.forEach((p,c)=>{if(row.has(p))out[c].v.push(row.get(p));else{out[c].v.push(0);out[c].m.push(r);}}));
  for(const col of out){
    if(!col.m.length)delete col.m;
    if(col.v.every(v=>typeof v==='string')&&col.v.length>=8){const d=[...new Set(col.v)];if(d.length*4<=col.v.length){const idx=new Map(d.map((v,i)=>[v,i]));col.d=d;col.v=col.v.map(v=>idx.get(v));}}
  }
  return {'~cols':out,n:list.length};
}
function pack(v){
  if(Array.isArray(v)){if(v.length>=64){const packed=packList(v);if(packed)return packed;}return v.map(pack);}
  if(isPlain(v)){const o={};for(const k of Object.keys(v))o[k]=pack(v[k]);return o;}
  return v;
}
function unpack(v){
  if(Array.isArray(v))return v.map(unpack);
  if(!isPlain(v))return v;
  if(Array.isArray(v['~cols'])&&Number.isInteger(v.n)){
    const list=Array.from({length:v.n},()=>({}));
    for(const col of v['~cols']){
      const miss=new Set(col.m||[]);
      for(let r=0;r<v.n;r++){if(miss.has(r))continue;let val=col.v[r];if(col.d)val=col.d[val];
        let o=list[r];for(let i=0;i<col.p.length-1;i++){const k=col.p[i];o=o[k]||(o[k]={});}o[col.p[col.p.length-1]]=val;}
    }
    return list;
  }
  const o={};for(const k of Object.keys(v))o[k]=unpack(v[k]);return o;
}
function createRepository(folder){
  let queue=Promise.resolve();
  const name=(key,slot)=>'anchor-'+I.sha256(key)+'-'+slot+'.json';
  async function read(key){
    const entries=await folder.getEntries(),valid=[],errors=[],prefix='anchor-'+I.sha256(key)+'-';let present=0,incompatible=false;
    for(const slot of ['a','b']){
      const entry=entries.find(e=>e.name===prefix+slot+'.json');if(!entry)continue;present++;
      try{
        const text=await entry.read();if(text.length>64*1024*1024)throw Error('Dados armazenados excedem o limite de leitura.');
        const e=JSON.parse(text);if(e.packed===1){e.payload=unpack(e.payload);delete e.packed;}
        if(e.format==='anchor-store'&&e.version!==1){incompatible=true;throw Error('Formato de armazenamento incompatível.');}
        if(e.format!=='anchor-store')throw Error('Formato de armazenamento incompatível.');
        if(e.key!==key||!Number.isSafeInteger(e.generation)||e.generation<1||e.checksum!==I.digest(e.payload))throw Error('Falha de integridade no trajeto armazenado.');
        valid.push({...e,slot,bytes:unescape(encodeURIComponent(text)).length});
      }catch(error){errors.push(error.message);}
    }
    if(incompatible)throw Error('Uma geração usa formato de armazenamento incompatível. Atualize o plugin; os dados foram preservados.');
    if(!valid.length){if(present){const e=Error('Os dados salvos deste trajeto estão danificados nas duas cópias ('+errors.join(' ')+'). Analise ou leia a máscara de novo: a próxima gravação recomeça do zero.');e.corrupted=true;throw e;}return null;}
    valid.sort((a,b)=>b.generation-a.generation);
    if(valid.length===2&&valid[0].generation===valid[1].generation&&valid[0].checksum!==valid[1].checksum)throw Error('Gerações conflitantes no armazenamento.');
    return {...valid[0],recovered:errors.length>0,errors};
  }
  function write(key,payload){
    let snapshot;try{snapshot=I.clone(payload);}catch(error){return Promise.reject(error);}
    const task=queue.then(async()=>{
      let old;
      try{old=await read(key);}
      catch(error){
        if(!error||!error.corrupted)throw error;
        // B20: duas cópias danificadas não podem travar a chave para sempre. Guarda as danificadas (.corrompido) e recomeça.
        old=null;const prefix='anchor-'+I.sha256(key)+'-';
        for(const entry of await folder.getEntries()){if(!entry.name.startsWith(prefix)||!entry.name.endsWith('.json'))continue;if(typeof entry.moveTo==='function')try{await entry.moveTo(folder,{newName:entry.name+'.corrompido',overwrite:true});}catch(_){}}
      }
      const slot=old?.slot==='a'?'b':'a';
      const envelope={format:'anchor-store',version:1,key,generation:(old?.generation||0)+1,checksum:I.digest(snapshot),payload:snapshot};
      const serialized=JSON.stringify({...envelope,payload:pack(snapshot),packed:1});if(serialized.length>64*1024*1024)throw Error('Trajeto excede o limite seguro do armazenamento. A geração anterior foi preservada.');
      const entry=await folder.createFile(name(key,slot),{overwrite:true});
      await entry.write(serialized);
      const check=JSON.parse(await entry.read());if(check.packed===1){check.payload=unpack(check.payload);delete check.packed;}
      if(I.canonical(check)!==I.canonical(envelope))throw Error('O armazenamento não confirmou a gravação.');
      return I.clone(snapshot);
    });queue=task.catch(()=>{});return task;
  }
  return {read,write};
}
module.exports={createRepository};
