'use strict';

// Premiere's public PointKeyframe API has no spatial interpolation setter.
// A native Spatial Linear key preserves that flag when copied and retargeted.
function createLinearPointKeyframes({ppro,loadTemplate}){
  if(!ppro||typeof loadTemplate!=='function')throw Error('Modelo Linear indisponível.');
  return {strategy:'native-spatial-linear-v3',ready:loadTemplate,async prepare(values,times,note=async()=>{}){
    if(!Array.isArray(values)||!values.length||!Array.isArray(times)||values.length!==times.length||
      values.some(v=>!v||![v.x,v.y].every(Number.isFinite))||times.some((t,i)=>!Number.isFinite(t)||(i&&t<=times[i-1])))
      throw Error('Pontos ou tempos inválidos para interpolação Linear. Nada foi alterado.');
    const {param,start,starts}=await loadTemplate();
    if(!param||typeof param.getKeyframePtr!=='function'||!Number.isFinite(start))throw Error('Modelo Linear inválido. Nada foi alterado.');
    const candidates=Array.isArray(starts)?starts:[start];
    const sourceTime=candidates.find(t=>Number.isFinite(t)&&times.every(target=>Math.abs(target-t)>1e-7));
    if(sourceTime===undefined)throw Error('Os tempos do modelo Linear coincidem com o trajeto. Nada foi aplicado.');
    const keys=[];
    // Do not parallelize: simultaneous reads can share the same native value.
    // Each read must finish AND be retargeted before requesting the next copy.
    for(let i=0;i<values.length;i++){
      const key=await param.getKeyframePtr(ppro.TickTime.createWithSeconds(sourceTime));
      if(!key)throw Error('O Premiere não retornou o modelo Linear. Nada foi alterado.');
      key.value=new ppro.PointF(values[i].x,values[i].y);
      key.position=ppro.TickTime.createWithSeconds(times[i]);keys.push(key);
      if(i>0&&i%2000===0)await note('PREPARANDO: Posição Linear | '+i+' de '+values.length+' keyframes.');
    }
    // Detect native aliasing before any action is created.
    for(let i=0;i<keys.length;i++){
      let v=keys[i].value;while(v&&v.value!==undefined)v=v.value;
      const p=Array.isArray(v)?{x:v[0],y:v[1]}:v;
      if(Math.abs(Number(keys[i].position.seconds)-times[i])>1e-7||!p||Math.abs(p.x-values[i].x)>1e-5||Math.abs(p.y-values[i].y)>1e-5)
        throw Error('O Premiere compartilhou dados entre keyframes preparados. Nada foi aplicado.');
    }
    return keys;
  }};
}
module.exports={createLinearPointKeyframes};
