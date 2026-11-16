'use strict';
const I=require('./integrity.js'),H=require('./host-values.js');
function unbox(v){const seen=new Set();while(v&&typeof v==='object'&&v.value!==undefined){if(seen.has(v))throw Error('Valor cíclico exposto pelo efeito.');seen.add(v);v=v.value;}return Array.isArray(v)?v:v&&Number.isFinite(v.x)&&Number.isFinite(v.y)?[v.x,v.y]:v;}
function createGuard(ppro){
  const effects=ctx=>ctx.comps.filter(c=>c.match!=='AE.ADBE AEMask2');
  // Impressão digital do efeito: tempos, valores e (v2) interpolação de cada
  // keyframe. O valor gravado no digest é o mesmo da 0.9.11, então recibos v1/v2
  // existentes continuam válidos. A documentação do Premiere tipa getKeyframePtr
  // como Keyframe e getTemporalInterpolationMode como Promise<number>, sem caso
  // nulo documentado. Por isso um modo que não chega como número finito (ponteiro
  // nulo ou modo não numérico) é relido uma vez e, se continuar assim, é CONTADO
  // como leitura indeterminada: entra no digest como antes (compatibilidade), mas
  // uma divergência com leitura indeterminada nunca é tratada como ajuste do editor.
  async function readMode(p,tick){
    const key=await p.getKeyframePtr(tick);
    return typeof key?.getTemporalInterpolationMode==='function'?await key.getTemporalInterpolationMode():null;
  }
  const definiteMode=m=>typeof m==='number'&&Number.isFinite(m);
  async function fingerprintDetail(comp,start,readModes=true,note=null){
    const channels=[],indeterminate=[];
    for(let i=0,n=await comp.getParamCount();i<n;i++){
      const p=await comp.getParam(i),varying=await p.isTimeVarying(),where='Transformar › parâmetro '+i;
      const times=varying?(await H.keyTimes(p,where+' › lista de keyframes',note)).seconds.sort((a,b)=>a-b):[start];
      if(varying&&times.length>=2000&&note)await note('CONFERINDO EFEITO: parâmetro '+i+', '+times.length+' keyframes.');
      const values=[],interpolation=[],modes=readModes&&varying&&typeof p.getKeyframePtr==='function';
      let unread=0,first=-1,reread=0;
      for(let k=0;k<times.length;k++){
        const time=times[k],tick=ppro.TickTime.createWithSeconds(time);
        let value=unbox(await p.getValueAtTime(tick));
        // Canal animado sem valor no tempo de uma keyframe = falha do host, não ajuste do editor.
        if(varying&&(value===null||value===undefined)){
          if(note)await note('RELEITURA: '+where+' › valor na keyframe '+k+' de '+times.length+' veio vazio; lendo de novo uma vez.');
          value=unbox(await p.getValueAtTime(ppro.TickTime.createWithSeconds(time)));
          if(value===null||value===undefined)throw H.hostError(where+' › valor na keyframe '+k+' de '+times.length+' ('+time.toFixed(6)+' s)',String(value));
        }
        values.push(value);
        if(!varying)continue;
        if(!modes){
          // v1 (readModes=false) ou host sem getKeyframePtr: mesmo comportamento de antes.
          const key=readModes&&typeof p.getKeyframePtr==='function'?await p.getKeyframePtr(tick):value;
          interpolation.push(typeof key?.getTemporalInterpolationMode==='function'?await key.getTemporalInterpolationMode():null);
          continue;
        }
        let mode=await readMode(p,tick);
        if(!definiteMode(mode)){reread++;mode=await readMode(p,ppro.TickTime.createWithSeconds(time));}
        if(!definiteMode(mode)){unread++;if(first<0)first=k;}
        // undefined/NaN/±Infinity não cabem no digest (a 0.9.11 quebrava com "Tipo de dado
        // não suportado"); entram como null, igual ao ponteiro nulo. null, texto e objeto
        // ficam como antes (recibos antigos só podem conter esses).
        interpolation.push(mode===undefined||(typeof mode==='number'&&!Number.isFinite(mode))?null:mode);
      }
      if(unread){
        indeterminate.push({index:i,count:unread,total:times.length,first});
        if(note)await note('AVISO: '+where+' › interpolação não lida em '+unread+' de '+times.length+' keyframes (primeira na posição '+first+'; ponteiro nulo ou modo não numérico, mesmo após releitura).');
      }else if(reread&&note)await note('RELEITURA OK: '+where+' › interpolação de '+reread+' keyframe(s) lida na segunda tentativa.');
      channels.push({index:i,varying,times: varying?times:[],values,interpolation});
    }
    return {digest:I.digest(channels),indeterminate};
  }
  async function fingerprint(comp,start,readModes=true,note=null){return (await fingerprintDetail(comp,start,readModes,note)).digest;}
  function indeterminateError(list){
    const text=list.map(x=>'parâmetro '+x.index+': '+x.count+' de '+x.total+' (primeira na posição '+x.first+')').join('; ');
    const error=Error('Não foi possível ler a interpolação de keyframes do Transformar ('+text+'). O efeito difere do recibo, mas com leitura indeterminada não dá para afirmar que foi ajustado pelo editor. Nada foi gravado; efeito e keyframes ficaram como estavam. Tente de novo; se repetir, envie o registro. Para recalcular mesmo assim, use "Preservar alterações e criar novo efeito" em Mais › Suporte e opções avançadas › Gestão avançada do Transformar (os efeitos atuais são preservados).');
    error.code='ANCHOR_HOST_INDETERMINATE';error.where='Transformar › interpolação';error.indeterminate=list;
    return error;
  }
  async function capture(ctx,note=null){
    const stack=effects(ctx),index=stack.findIndex(c=>c.comp===ctx.effect.comp);
    if(index<0)throw Error('Não foi possível identificar o efeito aplicado.');
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (recibo do efeito)',note);
    return {version:1,fingerprintVersion:2,layout:'effects-without-mask-v1',index,matches:stack.map(c=>c.match),fingerprint:await fingerprint(ctx.effect.comp,start,true,note)};
  }
  function isMissing(ctx,receipt){
    if(receipt?.version!==1||!Array.isArray(receipt.matches)||!Number.isInteger(receipt.index)||receipt.matches[receipt.index]!=='AE.ADBE Geometry2')return false;
    // Recreate only a sole, absent Transform with the remaining stack intact.
    // A surviving manual Transform or another stack change needs explicit review.
    const stack=receipt.layout==='effects-without-mask-v1'?effects(ctx):ctx.comps;
    return receipt.matches.filter(m=>m==='AE.ADBE Geometry2').length===1&&
      !stack.some(c=>c.match==='AE.ADBE Geometry2')&&
      I.canonical(receipt.matches.filter((_,i)=>i!==receipt.index))===I.canonical(stack.map(c=>c.match));
  }
  // Sucesso exato devolve {edited:false, receipt}: o recibo recalculado agora, que
  // a aplicação reaproveita em vez de ler as mesmas keyframes uma segunda vez.
  async function validate(ctx,receipt,{replaceEdited=false,note=null}={}){
    if(isMissing(ctx,receipt)){const error=Error('O Transformar do Dynamic Anchor foi removido. A próxima aplicação criará um novo efeito.');error.code='ANCHOR_EFFECT_MISSING';throw error;}
    const stack=receipt?.layout==='effects-without-mask-v1'?effects(ctx):ctx.comps;
    if(receipt?.version!==1||!Number.isInteger(receipt.index)||I.canonical(receipt.matches)!==I.canonical(stack.map(c=>c.match)))throw Error('A ordem dos efeitos mudou. Preserve os ajustes e revise o efeito do Dynamic Anchor.');
    const start=await H.clipSeconds(ctx.clip,'getInPoint','entrada do clipe (conferência do efeito)',note),matches=[],unread=[];
    for(let i=0;i<stack.length;i++){
      if(stack[i].match!=='AE.ADBE Geometry2')continue;
      const detail=await fingerprintDetail(stack[i].comp,start,receipt.fingerprintVersion===2,note);
      if(detail.digest===receipt.fingerprint)matches.push(i);
      else if(detail.indeterminate.length)unread.push(...detail.indeterminate);
    }
    // Divergência com interpolação não lida: indeterminado, nunca "ajustado".
    if(matches.length!==1&&unread.length)throw indeterminateError(unread);
    if(matches.length!==1||matches[0]!==receipt.index){
      // Explicit replacement can recalculate a previously managed, sole
      // Transform. Never infer ownership among multiple Transform effects.
      const sole=receipt.matches[receipt.index]==='AE.ADBE Geometry2'&&stack.filter(c=>c.match==='AE.ADBE Geometry2').length===1;
      if(sole&&replaceEdited===true)return {edited:true};
      const error=Error(sole?'O Transformar do Dynamic Anchor foi editado depois da aplicação. Para o Dynamic Anchor recalcular, desfaça a edição com Ctrl+Z ou apague esse Transformar e aplique de novo. Nada foi gravado.':'O efeito foi alterado manualmente ou sua identificação ficou ambígua. Nenhum ajuste foi sobrescrito.');
      if(sole)error.code='ANCHOR_EFFECT_EDITED';
      throw error;
    }
    if(stack.slice(receipt.index+1).some(c=>c.match==='AE.ADBE Geometry2'))throw Error('Há outro Transformar depois do efeito gerenciado. Revise a composição antes de atualizar.');
    const reusable=receipt.fingerprintVersion===2&&receipt.layout==='effects-without-mask-v1';
    return {edited:false,receipt:reusable?{version:1,fingerprintVersion:2,layout:'effects-without-mask-v1',index:receipt.index,matches:stack.map(c=>c.match),fingerprint:receipt.fingerprint}:null};
  }
  return {fingerprint,fingerprintDetail,capture,validate,isMissing};
}
module.exports={createGuard};
