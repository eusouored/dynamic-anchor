'use strict';
// Read-only adapter for tracked vector masks in saved Premiere projects. Never edits a project.
const TICKS = 254016000000;
// Most XML nodes are leaves without attributes. Share immutable empty values
// instead of allocating an object and an array for every node in large projects.
const EMPTY_CHILDREN=Object.freeze([]),EMPTY_ATTRS=Object.freeze({});
function xmlTree(xml) {
  if (xml.length > 128*1024*1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Projeto XML não suportado.');
  const root={name:'#document',children:[],attrs:{},text:''}, stack=[root];
  // B25: referências numéricas (&#233; e &#xE9;) também são decodificadas.
  const decode=s=>s.replace(/&(?:lt|gt|amp|quot|apos|#\d{1,7}|#[xX][0-9a-fA-F]{1,6});/g,v=>{const t={'&lt;':'<','&gt;':'>','&amp;':'&','&quot;':'"','&apos;':"'"}[v];if(t)return t;const n=v[2]==='x'||v[2]==='X'?parseInt(v.slice(3,-1),16):parseInt(v.slice(2,-1),10);try{return String.fromCodePoint(n);}catch(_){return v;}});
  const re=/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g;
  for (const m of xml.matchAll(re)) {
    const s=m[0],parent=stack[stack.length-1];
    if(s.startsWith('<!--')||s.startsWith('<?'))continue;
    if(s.startsWith('<![CDATA[')){parent.text+=s.slice(9,-3);continue;}
    if(s.startsWith('</')){if(stack.length===1||stack.pop().name!==s.slice(2,-1).trim())throw new Error('Projeto XML inválido.');continue;}
    if(s[0]==='<'){
      const name=/^<([\w.:-]+)/.exec(s); if(!name)throw new Error('Elemento XML não suportado.');
      const n={name:name[1],attrs:EMPTY_ATTRS,children:EMPTY_CHILDREN,text:''};
      for(const a of s.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)){if(n.attrs===EMPTY_ATTRS)n.attrs={};n.attrs[a[1]]=decode(a[2]);}
      if(parent.children===EMPTY_CHILDREN)parent.children=[];
      parent.children.push(n);if(!s.endsWith('/>'))stack.push(n);
    }else parent.text+=decode(s);
  }
  if(stack.length!==1)throw new Error('Projeto XML incompleto.');
  const project=root.children.find(n=>n.name==='PremiereData')||(()=>{throw new Error('Este arquivo não é um projeto Premiere.');})();
  // Premiere writes a repeated binary value only once after splitting a clip.
  // Later mask parameters point to that value with BinaryHash and have no text.
  const nodes=[],payloads=new Map(),pending=[project];
  while(pending.length){const node=pending.pop();for(const entry of node.children)pending.push(entry);
    const hash=node.attrs.BinaryHash,data=node.text.trim();
    if(hash&&data){if(payloads.has(hash)&&payloads.get(hash)!==data)throw new Error('Dados binários conflitantes no projeto.');payloads.set(hash,data);}
    if(hash&&!data)nodes.push(node);
  }
  for(const node of nodes)if(node.attrs.BinaryHash&&!node.text.trim()){
    const data=payloads.get(node.attrs.BinaryHash);
    if(!data)throw new Error('Dados compartilhados da máscara não encontrados no projeto salvo.');
    node.text=data;
  }
  return project;
}
const child=(n,name)=>n&&n.children.find(c=>c.name===name);
function descendants(n,name){
  const out=[],pending=[];if(n)for(let i=n.children.length-1;i>=0;i--)pending.push(n.children[i]);
  while(pending.length){const c=pending.pop();if(c.name===name)out.push(c);for(let i=c.children.length-1;i>=0;i--)pending.push(c.children[i]);}
  return out;
}
const path=(n,...names)=>names.reduce((a,b)=>child(a,b),n);
const text=n=>n?n.text.trim():'';
const val=(n,...names)=>text(path(n,...names));
function bytes64(s) {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',clean=s.replace(/\s/g,'');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)||clean.length%4)throw new Error('Dados de máscara inválidos.');
  const out=[];let acc=0,bits=0;
  for(const c of clean){if(c==='=')break;acc=(acc<<6)|chars.indexOf(c);bits+=6;if(bits>=8){bits-=8;out.push((acc>>bits)&255);}}
  return new Uint8Array(out);
}
function view64(s){const b=bytes64(s);return new DataView(b.buffer,b.byteOffset,b.byteLength);}
function shape(s) {
  const v=view64(s);
  // Geometric AEMask2: version, contour count, path id, byte flag, path type, vertex count.
  if(v.byteLength<22||v.getUint32(0,true)!==2||v.getUint32(4,true)!==1||v.getUint32(13,true)!==2)
    throw new Error('Use uma máscara geométrica com um contorno. Este formato de máscara ainda não é suportado.');
  const count=v.getUint32(17,true);
  if(count<3||count>4096||v.byteLength!==22+count*28)throw new Error('Geometria da máscara não reconhecida.');
  const pts=[];
  for(let i=0;i<count;i++){
    const off=21+i*28, p={x:v.getFloat32(off+4,true),y:v.getFloat32(off+8,true)};
    if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>4||Math.abs(p.y)>4)throw new Error('Coordenadas de máscara inválidas.');
    pts.push(p);
  }
  return pts;
}
function matrix(s) {
  const v=view64(s);
  if(v.byteLength!==104||v.getUint32(0,true)!==1)throw new Error('Controlador de rastreamento não reconhecido.');
  const f=i=>v.getFloat32(i,true),m={a:f(4),b:f(8),c:f(16),d:f(20),tx:f(28),ty:f(32)};
  if(!Object.values(m).every(Number.isFinite)||Math.abs(f(12))>1e-7||Math.abs(f(24))>1e-7||Math.abs(f(36)-1)>1e-7||Math.abs(m.a*m.d-m.b*m.c)<1e-8)
    throw new Error('Transformação de máscara inválida ou com perspectiva.');
  return m;
}
function samples(n,decode) {
  const entries=val(n,'Keyframes').split(';').filter(Boolean).map(s=>{
    const i=s.indexOf(',');return {tick:Number(s.slice(0,i)),value:decode(s.slice(i+1))};
  });
  if(!entries.length){const s=val(n,'StartKeyframeValue');if(s)entries.push({tick:-Infinity,value:decode(s)});}
  if(!entries.length)throw new Error('A máscara não tem geometria salva.');
  entries.sort((a,b)=>a.tick-b.tick);
  return entries;
}
function sampleAt(entries,tick,kind) {
  // A subframe rounding difference must hold the first saved value, not
  // extrapolate backwards from the first pair of samples.
  if(tick<=entries[0].tick)return entries[0].value;
  let lo=0,hi=entries.length-1;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(entries[mid].tick<=tick+.01)lo=mid;else hi=mid-1;}
  const a=entries[lo],b=entries[lo+1];
  if(!b||a.tick===-Infinity||Math.abs(a.tick-tick)<.01)return a.value;
  const mix=(x,y)=>x+(y-x)*(tick-a.tick)/(b.tick-a.tick);
  if(kind==='matrix'||kind==='point')return Object.fromEntries(Object.keys(a.value).map(k=>[k,mix(a.value[k],b.value[k])]));
  if(kind==='number')return mix(a.value,b.value);
  if(a.value.length!==b.value.length)return a.value;
  return a.value.map((p,i)=>({x:mix(p.x,b.value[i].x),y:mix(p.y,b.value[i].y)}));
}
function manualSamples(param,kind) {
  if(!param)return null;
  const decode=s=>{
    if(kind==='point'){
      const parts=s.split(':').map(Number);
      if(parts.length!==2||!parts.every(Number.isFinite))throw new Error('Ajuste manual da máscara inválido.');
      return {x:parts[0],y:parts[1]};
    }
    const n=Number(s);if(!Number.isFinite(n))throw new Error('Ajuste manual da máscara inválido.');return n;
  };
  const entries=[],start=val(param,'StartKeyframe');
  if(start){const m=/^[^,]+,([^,]+)/.exec(start);if(m)entries.push({tick:-Infinity,value:decode(m[1])});}
  for(const s of val(param,'Keyframes').split(';').filter(Boolean)){
    const m=/^([^,]+),([^,]+)/.exec(s);if(!m||!Number.isFinite(Number(m[1])))throw new Error('Keyframe de ajuste manual inválido.');
    entries.push({tick:Number(m[1]),value:decode(m[2])});
  }
  entries.sort((a,b)=>a.tick-b.tick);return entries.length?entries:null;
}
function prepareProject(xml) {
  const root=xmlTree(xml),ids=new Map(),uids=new Map();
  for(const n of root.children){if(n.attrs.ObjectID)ids.set(n.attrs.ObjectID,n);if(n.attrs.ObjectUID)uids.set(n.attrs.ObjectUID.toLowerCase(),n);}
  return {root,ids,uids};
}
function parseProject(xml,selection) {
  const {ids,uids}=typeof xml==='string'?prepareProject(xml):xml;
  const deref=n=>n&&(ids.get(n.attrs.ObjectRef)||uids.get((n.attrs.ObjectURef||'').toLowerCase()));
  const seq=uids.get(selection.sequenceId.toLowerCase().replace(/[{}]/g,''));
  if(!seq||seq.name!=='Sequence')throw new Error('A sequência ativa não está neste projeto salvo.');
  const groups=descendants(seq,'Second').map(deref),vg=groups.find(n=>n&&n.name==='VideoTrackGroup');
  const trackRef=descendants(vg,'Track').find(n=>Number(n.attrs.Index)===selection.trackIndex),track=deref(trackRef);
  const candidates=descendants(track,'TrackItem').map(deref).filter(n=>n&&n.name==='VideoClipTrackItem');
  const close=(a,b)=>Math.abs(a-b)<1/TICKS+.000001;
  const matched=candidates.filter(n=>{
    const ti=path(n,'ClipTrackItem','TrackItem'),sub=deref(path(n,'ClipTrackItem','SubClip')),clip=deref(child(sub,'Clip'));
    return close(Number(val(ti,'Start')||0)/TICKS,selection.start)&&close(Number(val(ti,'End'))/TICKS,selection.end)&&
      close(Number(val(clip,'Clip','InPoint')||0)/TICKS,selection.inPoint)&&close(Number(val(clip,'Clip','OutPoint'))/TICKS,selection.outPoint)&&String(val(sub,'Name')||'').normalize('NFC')===String(selection.name||'').normalize('NFC');
  });
  if(matched.length!==1)throw new Error('O clipe selecionado mudou ou o projeto não foi salvo. Leia a máscara novamente.');
  const item=matched[0],rect=val(item,'FrameRect').split(',').map(Number),seqRect=val(vg,'FrameRect').split(',').map(Number);
  const W=rect[2]-rect[0],H=rect[3]-rect[1],step=Number(val(vg,'TrackGroup','FrameRate'));
  if(!(W>0&&H>0&&step>0)||W!==seqRect[2]-seqRect[0]||H!==seqRect[3]-seqRect[1]||val(item,'PixelAspectRatio')!=='1,1')
    throw new Error('Use clipe e sequência com a mesma resolução e pixels quadrados. Aninhe a mídia se necessário.');
  // Current Premiere saves the owned chain under ClipTrackItem, without a
  // SelectionComponents link. Resolve only this already-matched clip's chain;
  // an explicit selection link must never fall back to a different chain.
  const chain=deref(child(item,'SelectionComponents')||path(item,'ClipTrackItem','ComponentOwner','Components'));
  const masks=[],objectMasks=[];
  const visited=new Set();
  function visit(comp){
    if(!comp)return;
    if(visited.has(comp))return;visited.add(comp);
    const refs=path(comp,'SubComponents');
    if(refs){refs.children.forEach(n=>visit(deref(n)));return;}
    if(val(comp,'MatchName')!=='AE.ADBE AEMask2')return;
    const ps=descendants(path(comp,'Component','Params'),'Param').map(deref),byId=id=>ps.find(p=>Number(val(p,'ParameterID'))===id);
    const controller=byId(6),geometry=byId(7);
    if(!controller||!geometry||!val(controller,'Keyframes')){
      const objectData=val(byId(24),'StartKeyframeValue');
      if(objectData){
        // The saved object-mask metadata names its external PRMF sources by UUID.
        // Time and resolution alone cannot distinguish another clip's mask.
        const bytes=bytes64(objectData),parts=[];
        for(let i=0;i<bytes.length;i+=4096)parts.push(String.fromCharCode(...bytes.slice(i,i+4096)));
        const objectRefs=[...new Set((parts.join('').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)||[]).map(id=>id.toLowerCase()))];
        objectMasks.push({name:val(comp,'Component','InstanceName')||'Máscara de objeto',objectRefs,uid:String((comp.attrs&&(comp.attrs.ObjectUID||comp.attrs.ObjectID))||'')});
      }
      return;
    }
    masks.push({name:val(comp,'Component','InstanceName')||val(comp,'Component','DisplayName')||'Máscara',controller,geometry,byId,uid:String((comp.attrs&&(comp.attrs.ObjectUID||comp.attrs.ObjectID))||'')});
  }
  descendants(chain,'Component').filter(n=>n.attrs.ObjectRef).forEach(n=>visit(deref(n)));
  if(!masks.length&&!objectMasks.length)throw new Error('Nenhuma máscara rastreada foi encontrada neste clipe. Rastreie uma máscara no Premiere antes de ler.');
  const data=masks.map(mask=>{
    const ms=samples(mask.controller,matrix),ss=samples(mask.geometry,shape),start=selection.inPoint*TICKS,end=selection.outPoint*TICKS;
    const manual={position:manualSamples(mask.byId(9),'point'),anchor:manualSamples(mask.byId(10),'point'),width:manualSamples(mask.byId(26),'number'),height:manualSamples(mask.byId(27),'number'),rotation:manualSamples(mask.byId(12),'number')};
    const count=Math.ceil((end-start)/step-1e-7);
    if(!Number.isSafeInteger(count)||count<2)throw new Error('Use um trecho de pelo menos 2 quadros.');
    if(ms.length<2)throw new Error('A máscara precisa de pelo menos 2 quadros rastreados dentro do trecho selecionado.');
    // A mask may begin or end inside a longer clip. Only sample frames with
    // saved tracking data; the Transform is gated outside this interval.
    const firstFrame=Math.max(0,Math.ceil((ms[0].tick-start)/step-.45));
    const lastFrame=Math.min(count-1,Math.floor((ms[ms.length-1].tick-start)/step+.45));
    if(lastFrame-firstFrame<1)throw new Error('A máscara precisa de pelo menos 2 quadros rastreados dentro do trecho selecionado.');
    for(let i=1;i<ms.length;i++)if(ms[i].tick-ms[i-1].tick>step*2.1&&ms[i-1].tick<start+lastFrame*step&&ms[i].tick>start+firstFrame*step)
      throw new Error('Há uma interrupção no rastreamento da máscara. Rastreie os quadros ausentes antes de aplicar.');
    const rows=[],times=[],ptsFrames=[];
    for(let i=firstFrame;i<=lastFrame;i++){
      const tick=start+i*step,m=sampleAt(ms,tick,'matrix');
      const p=manual.position&&sampleAt(manual.position,tick,'point'),a=manual.anchor&&sampleAt(manual.anchor,tick,'point');
      const sx=manual.width?sampleAt(manual.width,tick,'number')/100:1,sy=manual.height?sampleAt(manual.height,tick,'number')/100:1;
      const angle=manual.rotation?sampleAt(manual.rotation,tick,'number')*Math.PI/180:0;
      if(!(sx>0&&sy>0)||!Number.isFinite(angle))throw new Error('Escala ou rotação manual da máscara inválida.');
      const ca=Math.cos(angle),sa=Math.sin(angle);
      const pts=sampleAt(ss,tick,'shape').map(v=>{
        // Tracker and manual Transform are separate in Premiere. A frame correction
        // acts on the already tracked contour in the image plane.
        const tracked={x:m.a*v.x+m.c*v.y+m.tx,y:m.b*v.x+m.d*v.y+m.ty};
        const dx=(tracked.x-(a?a.x:0))*sx,dy=(tracked.y-(a?a.y:0))*sy;
        return {x:((p?p.x:0)+ca*dx-sa*dy)*W,y:((p?p.y:0)+sa*dx+ca*dy)*H};
      });
      const x=pts.reduce((s,p)=>s+p.x,0)/pts.length,y=pts.reduce((s,p)=>s+p.y,0)/pts.length;
      const geometry=require('./quality.js').geometry(pts);
      rows.push({frame:i-firstFrame,x,y,angle:0,...geometry});times.push(tick/TICKS);ptsFrames.push(pts);
    }
    const first=ptsFrames[0],fc=rows[0];
    rows.forEach((r,i)=>{
      let dot=0,cross=0;if(first.length===ptsFrames[i].length)first.forEach((a,j)=>{const b=ptsFrames[i][j],ax=a.x-fc.x,ay=a.y-fc.y,bx=b.x-r.x,by=b.y-r.y;dot+=ax*bx+ay*by;cross+=ax*by-ay*bx;});
      else {const m0=sampleAt(ms,start+firstFrame*step,'matrix'),mi=sampleAt(ms,start+(firstFrame+i)*step,'matrix');dot=m0.a*mi.a+m0.b*mi.b;cross=m0.a*mi.b-m0.b*mi.a;}
      r.angle=Math.atan2(cross,dot)*180/Math.PI;
    });
    return {name:mask.name,...(mask.uid?{maskId:'uid:'+mask.uid}:{}),rows,times,W,H,fps:TICKS/step,selection,partial:firstFrame>0||lastFrame<count-1,
      firstTrackedTime:times[0],lastTrackedTime:times[times.length-1],coveredStart:times[0],coveredEnd:times[times.length-1]+step/TICKS};
  });
  return data.concat(objectMasks.map(mask=>({...mask,type:'object',W,H,fps:TICKS/step,sourceStart:selection.inPoint,sourceEnd:selection.outPoint,selection,rotationSupported:false})));
}
function unpackProject(bytes) {
  const pako=require('./vendor/pako-inflate.js');
  if(bytes.byteLength>32*1024*1024)throw new Error('Use um projeto de até 32 MB para ler a máscara.');
  if(bytes[0]!==31||bytes[1]!==139)throw new Error('Formato de projeto Premiere não reconhecido.');
  const inflate=new pako.Inflate({to:'string'}),chunks=[];let size=0;
  inflate.onData=s=>{size+=s.length;if(size>128*1024*1024)throw new Error('Projeto descompactado muito grande.');chunks.push(s);};
  inflate.push(bytes,true);if(inflate.err)throw new Error('Não foi possível descompactar o projeto.');
  return chunks.join('');
}
module.exports={parseProject,prepareProject,unpackProject,shape,matrix,xmlTree};
