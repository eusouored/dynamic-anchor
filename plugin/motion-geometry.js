'use strict';

// Pure coordinate conversion for writing Dynamic Anchor directly to Premiere Motion.
// Tracking and Dynamic Anchor keys live on the sequence canvas; Motion's source
// anchor is in media pixels and its final Position is normalized by the host.
const finitePoint=p=>!!p&&Number.isFinite(p.x)&&Number.isFinite(p.y);
const point=v=>Array.isArray(v)?{x:v[0],y:v[1]}:v&&Number.isFinite(v.x)&&Number.isFinite(v.y)?{x:v.x,y:v.y}:null;

// Quadro do vídeo: a mídia escalada por um fator único até cobrir o quadro da sequência.
// O rastreio fica nesse espaço; o quadro de saída continua sendo a sequência (W×H).
// Mesma proporção: é exatamente W×H (comportamento de sempre). Proporção diferente (ex.: 16:9 numa
// sequência 9:16): um lado coincide com a sequência e o outro passa dela, centrado.
function sourceCanvas(media,W,H){
  if(!media||![media.width,media.height,W,H].every(n=>Number.isFinite(n)&&n>0))throw Error('Dimensões da mídia ou da sequência inválidas.');
  const rx=media.width/W,ry=media.height/H;
  if(Math.abs(rx-ry)<=Math.max(rx,ry)*1e-6)return {width:W,height:H,ratio:(rx+ry)/2,sameAspect:true};
  const r=Math.min(rx,ry);
  return {width:media.width/r,height:media.height/r,ratio:r,sameAspect:false};
}
function validateSourceFormat(format,W,H,{sequencePixelAspect=1}={}){
  if(!format||![format.width,format.height,format.pixelAspect,sequencePixelAspect].every(Number.isFinite)||
    format.width<=0||format.height<=0||format.pixelAspect<=0||sequencePixelAspect<=0||
    ![W,H].every(n=>Number.isFinite(n)&&n>0))
    throw Error('Não foi possível confirmar dimensões de mídia e aspecto do pixel válidos. Nenhum keyframe foi gravado.');
  if(Math.abs(format.pixelAspect-sequencePixelAspect)>Math.max(format.pixelAspect,sequencePixelAspect)*1e-9)
    throw Error('A mídia e a sequência precisam do mesmo aspecto do pixel: pixels quadrados ou SAR idêntico. Nenhum keyframe foi gravado.');
  const canvas=sourceCanvas(format,W,H);
  return {width:format.width,height:format.height,pixelAspect:Math.abs(format.pixelAspect-1)<=1e-9?1:format.pixelAspect,ratio:canvas.ratio,
    sourceWidth:canvas.width,sourceHeight:canvas.height,
    ...(Math.abs(format.pixelAspect-1)>1e-9?{sequencePixelAspect}: {})};
}
function sourceDimensions(source){return {width:source.width,height:source.height,pixelAspect:source.pixelAspect,
  ...(source.sequencePixelAspect!==undefined?{sequencePixelAspect:source.sequencePixelAspect}:{})};}
function validateSourceRotation(source,rotations,requested=false){
  if(Math.abs(source.pixelAspect-1)>1e-9&&(requested||!Array.isArray(rotations)||rotations.some(r=>!Number.isFinite(r)||r!==0)))
    throw Error('Pixels não quadrados exigem Rotação desligada e Movimento sem giro. Nenhum keyframe foi gravado.');
}

function rotationSourceTransform(W,H,ratio,anchors,rotations){
  if(!Number.isFinite(ratio)||ratio<=0||!Array.isArray(anchors)||!Array.isArray(rotations)||anchors.length!==rotations.length)
    throw Error('Dados incompletos para compor a rotação de Movimento.');
  return anchors.map((value,i)=>{
    const a=point(value),rotation=rotations[i];
    if(!finitePoint(a)||!Number.isFinite(rotation))throw Error('Âncora ou rotação de Movimento inválida.');
    // Premiere exposes Motion Anchor as a normalized PointF (same convention
    // as the existing engine), so map it to the sequence canvas. Source media
    // dimensions affect scale conversion only; they are not Anchor units.
    const anchor={x:a.x*W,y:a.y*H};
    return {position:{x:anchor.x,y:anchor.y},anchor,scale:1,rotation};
  });
}

function measureInDestination(C,rows,sourceTransform){
  if(!Array.isArray(rows)||!Array.isArray(sourceTransform)||rows.length!==sourceTransform.length)
    throw Error('Rastreamento e geometria de Movimento incompatíveis.');
  const points=C.motionRows(rows);
  return points.map((row,i)=>{
    const m=sourceTransform[i],v=C.rot({x:row.x-m.anchor.x,y:row.y-m.anchor.y},m.rotation);
    return {...row,x:m.position.x+m.scale*v.x,y:m.position.y+m.scale*v.y,angle:row.angle+m.rotation};
  });
}

// Returns normalized Motion Position, percent Scale, and degrees Rotation.
// K describes uniform Geometry2 effects downstream from Motion.
function nativeValues(C,keys,index,{W,H,ratio,K,anchorVirtual,rotationBase}){
  const k=keys[index],t=K.translations[index];
  if(!k||!finitePoint(anchorVirtual)||!t||![W,H,ratio,K.scale,k.scale,k.px,k.py,k.rotation,rotationBase].every(Number.isFinite)||
    W<=0||H<=0||ratio<=0||K.scale<=0)
    throw Error('Não foi possível converter o keyframe para Movimento.');
  const offset=C.rot({x:anchorVirtual.x-k.anchor.x,y:anchorVirtual.y-k.anchor.y},k.rotation);
  const position={x:(k.px+k.scale*offset.x-t.x)/K.scale/W,
    y:(k.py+k.scale*offset.y-t.y)/K.scale/H};
  const scale=k.scale/(ratio*K.scale)*100;
  const rotation=rotationBase+k.rotation;
  if(!finitePoint(position)||![scale,rotation].every(Number.isFinite)||scale<=0)throw Error('O cálculo produziu valores de Movimento inválidos.');
  return {position,scale,rotation};
}

module.exports={sourceCanvas,validateSourceFormat,sourceDimensions,validateSourceRotation,rotationSourceTransform,measureInDestination,nativeValues,point};
