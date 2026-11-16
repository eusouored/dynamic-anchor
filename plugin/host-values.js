'use strict';
// Leituras de tempo devolvidas pelo Premiere (TickTime), conferidas.
// O host pode devolver null (ou um item null numa lista de keyframes). Antes,
// isso virava "Cannot read properties of null (reading 'seconds')" sem dizer
// onde. Aqui: nunca vira 0 nem é ignorado em silêncio. Uma leitura somente de
// consulta é repetida uma vez (e isso fica no registro); se o host repetir o
// valor vazio, a operação para com o local exato e nada é gravado por esta
// leitura.
function hostError(where,detail){
  const error=Error('O Premiere devolveu um valor vazio em '+where+(detail?' ('+detail+')':'')+'. Nada foi gravado por esta etapa; efeito e keyframes existentes ficaram como estavam. Tente de novo e, se repetir, envie o registro.');
  error.code='ANCHOR_HOST_NULL';error.where=where;error.detail=detail||null;
  return error;
}
// TickTime.seconds é documentado como number. Só um número finito vale (0 inclusive).
// null, undefined, '', espaços, booleanos, strings numéricas, NaN e ±Infinity são
// valor vazio/indeterminado: Number(null), Number('') e Number(false) davam 0.
const validSeconds=t=>!!t&&typeof t==='object'&&typeof t.seconds==='number'&&Number.isFinite(t.seconds);
function describeValue(v){
  if(v===null)return 'null';if(v===undefined)return 'undefined';
  if(typeof v==='string')return v.trim()?'texto "'+v.slice(0,20)+'"':'texto vazio';
  if(typeof v==='boolean')return 'booleano '+v;
  if(typeof v==='number')return String(v);
  return typeof v;
}
const describeBad=v=>v===null||v===undefined||typeof v!=='object'?describeValue(v):'seconds '+describeValue(v.seconds);
function secondsOf(tick,where){
  if(!validSeconds(tick))throw hostError(where,describeBad(tick));
  return tick.seconds;
}
// Lista de keyframes de um parâmetro. Devolve os TickTime originais (para
// remoção) e os segundos. Um item vazio faz a lista inteira ser relida uma vez.
function listProblem(list){
  if(!Array.isArray(list))return 'lista '+describeBad(list);
  let bad=0,first=-1;
  for(let i=0;i<list.length;i++)if(!validSeconds(list[i])){bad++;if(first<0)first=i;}
  return bad?bad+' de '+list.length+' item(ns) vazio(s), o primeiro na posição '+first+' ('+describeBad(list[first])+')':null;
}
async function keyTimes(param,where,note){
  let problem=null;
  for(let attempt=0;attempt<2;attempt++){
    const list=await param.getKeyframeListAsTickTimes();
    problem=listProblem(list);
    if(!problem){
      if(attempt&&note)await note('RELEITURA OK: '+where+' ('+list.length+' keyframes).');
      return {ticks:list,seconds:list.map(t=>t.seconds)};
    }
    if(!attempt&&note)await note('RELEITURA: '+where+' — '+problem+'; lendo de novo uma vez.');
  }
  throw hostError(where,problem);
}
// Entrada/saída/início/fim do clipe na timeline.
async function clipSeconds(clip,method,where,note){
  let value;
  for(let attempt=0;attempt<2;attempt++){
    value=await clip[method]();
    if(validSeconds(value)){
      if(attempt&&note)await note('RELEITURA OK: '+where+'.');
      return value.seconds;
    }
    if(!attempt&&note)await note('RELEITURA: '+where+' — '+describeBad(value)+'; lendo de novo uma vez.');
  }
  throw hostError(where,describeBad(value));
}
module.exports={hostError,secondsOf,keyTimes,clipSeconds,listProblem,validSeconds,describeBad};
