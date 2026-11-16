'use strict';
// Qualidade visível do trajeto do rosto. "Confiança" aqui é a pontuação do
// detector YuNet para a caixa do rosto naquele quadro; não é probabilidade de
// que seja a mesma pessoa.
const sec=n=>Number(n).toFixed(1).replace('.',',');
const dec=n=>Number(n).toFixed(2).replace('.',',');
// Intervalos cobertos por amostras reais, incluindo lacunas internas. Cada
// amostra cobre um quadro; pequenas diferenças numéricas não criam perdas.
function mergeRanges(ranges,step){
  const out=[];
  for(const [a,b] of ranges.sort((x,y)=>x[0]-y[0])){const last=out[out.length-1];if(last&&a-last[1]<=1e-7)last[1]=Math.max(last[1],b);else out.push([a,b]);}
  return out;
}
function gridFrames(rows,job){
  const frames=new Set();
  for(const r of rows||[]){const time=r&&r.time,k=(time-job.inPoint)*job.fps,frame=Math.round(k);
    if(Number.isFinite(time)&&Number.isSafeInteger(frame)&&frame>=0&&Math.abs(k-frame)<=.01&&time<job.outPoint&&job.inPoint+frame/job.fps<job.outPoint)frames.add(frame);
  }
  return frames;
}
function rowRanges(rows,job,frames=gridFrames(rows,job)){
  const step=1/job.fps;
  return mergeRanges([...frames].map(frame=>{const time=job.inPoint+frame/job.fps;return [time,Math.min(job.outPoint,time+step)];}),step);
}
function missingRanges(ranges,job){
  const out=[];let end=job.inPoint;
  for(const [a,b] of ranges){if(a-end>1e-7)out.push([end,a]);end=Math.max(end,b);}
  if(job.outPoint-end>1e-7)out.push([end,job.outPoint]);return out;
}
function lostRanges(rows,job){return missingRanges(rowRanges(rows,job),job);}
// Os segmentos auxiliares servem à revisão, não à aplicação. Não confiar em
// start/end declarados: conferir os tempos das linhas e descontar sobreposições.
function coverageDetails(result,job){
  const frames=gridFrames(result.rows,job),selected=rowRanges(result.rows,job,frames),step=1/job.fps,extra=[];
  for(const seg of (Array.isArray(result.segments)?result.segments:[])){
    const rows=seg&&seg.rows;if(!Array.isArray(rows)||rows.length<2)continue;
    let prev=null,valid=true;
    for(const r of rows){
      const t=r&&r.time,grid=(t-job.inPoint)*job.fps;
      if(!Number.isFinite(t)||t<job.inPoint-step*.01||t>=job.outPoint||Math.abs(grid-Math.round(grid))>.01||(prev!==null&&t<=prev)||
        ![r.x,r.y,r.width,r.height,r.confidence,result.width,result.height].every(Number.isFinite)||r.width<=0||r.height<=0||r.confidence<.5||r.confidence>1||r.x<0||r.y<0||r.x>result.width||r.y>result.height){valid=false;break;}prev=t;
    }
    if(valid)extra.push(...rowRanges(rows,job));
  }
  const all=mergeRanges([...selected,...extra],step),other=[];
  for(const [a,b] of mergeRanges(extra,step)){
    let start=a;
    for(const [x,y] of selected){if(y<=start||x>=b)continue;if(x-start>1e-7)other.push([start,x]);start=Math.max(start,y);}
    if(b-start>1e-7)other.push([start,b]);
  }
  const total=job.outPoint-job.inPoint,available=all.reduce((n,[a,b])=>n+b-a,0);
  const expectedFrames=Math.ceil(total*job.fps-1e-7),selectedComplete=expectedFrames>0&&frames.size===expectedFrames&&result.rows.length===expectedFrames&&frames.has(0)&&frames.has(expectedFrames-1);
  const selectedSeconds=selected.reduce((n,[a,b])=>n+b-a,0);
  return {selectedCoverage:selectedComplete?1:Math.max(0,Math.min(1,selectedSeconds/total)),selectedComplete,selectedFrames:frames.size,expectedFrames,
    availableCoverage:Math.max(0,Math.min(1,available/total)),otherSegments:other,missing:missingRanges(all,job)};
}
function canAutoApply(result,job,mask,details=coverageDetails(result,job)){
  return !!mask&&!mask.partial&&result.rows.length>=2&&!(mask.recoveryEvidence?.heldFrames>0)&&result.coverage===1&&details.selectedComplete&&
    !details.missing.length&&!details.otherSegments.length&&(!result.stats||result.stats.segments===undefined||result.stats.segments===1)&&
    !(Array.isArray(result.segments)&&result.segments.some(s=>s&&s.primary===false));
}
// Cobertura sem arredondar para cima: 0,9991 é "99,9%", nunca "100%".
function coverText(c){
  const v=Number(c)||0;if(v>=1)return '100%';
  const tenth=Math.floor(v*1000)/10,out=Math.min(99.9,tenth);
  return (Number.isInteger(out)?String(out):out.toFixed(1)).replace('.',',')+'%';
}
// Trecho em segundos do take; trechos menores que 0,1 s viram quadros e milissegundos
// (por exemplo, o último quadro de um take de 29,97 fps numa sequência de 59,94 fps).
function rangeText(a,b,job){
  const d=b-a,fps=Number(job&&job.fps)||0;
  if(d<0.1&&fps>0){const frames=Math.max(1,Math.round(d*fps)),ms=(1000*frames/fps).toFixed(1).replace('.',',');return sec(a)+' s ('+frames+' quadro'+(frames>1?'s':'')+', ~'+ms+' ms)';}
  return sec(a)+'–'+sec(b)+' s';
}
function groupTimes(times,gap=.5){
  const out=[];for(const t of [...(times||[])].filter(Number.isFinite).sort((a,b)=>a-b)){const last=out[out.length-1];if(last&&t-last[1]<=gap)last[1]=t;else out.push([t,t]);}
  return out;
}
function issues(result,job,details=coverageDetails(result,job)){
  const q=result&&result.quality||{},list=[];
  for(const [start,end] of details.missing)list.push({kind:'sem rosto',start,end});
  for(const [start,end] of details.otherSegments)list.push({kind:'outro trecho',start,end});
  for(const [start,end] of q.lowConfidence||[])list.push({kind:'baixa confiança',start,end});
  for(const [start,end] of q.interpolatedRuns||[])list.push({kind:'interpolado',start,end});
  for(const [start,end] of groupTimes(q.ambiguousTimes))list.push({kind:'ambiguidade descartada',start,end});
  return list.filter(i=>Number.isFinite(i.start)&&Number.isFinite(i.end)).sort((a,b)=>a.start-b.start);
}
function label(issue,job){
  const a=issue.start-job.inPoint,b=issue.end-job.inPoint;
  const name=issue.kind==='sem rosto'?'sem rastreamento':issue.kind==='outro trecho'?'outro trecho encontrado, fora do trajeto selecionado':issue.kind==='mantido'?'enquadramento mantido sem detecção':issue.kind;
  return name+' '+(['sem rosto','outro trecho','mantido'].includes(issue.kind)?rangeText(a,b,job):b-a>0.05?sec(a)+'–'+sec(b)+' s':sec(a)+' s')+' do take';
}
function summary(result,job,details=coverageDetails(result,job)){
  const q=result&&result.quality||{},parts=details.otherSegments.length?
    ['Trajeto selecionado: '+coverText(details.selectedCoverage)+' do take','Rastreamento disponível: '+coverText(details.availableCoverage)+' (inclui interpolações)',(details.otherSegments.length===1?'Outro trecho fora da aplicação':'Outros '+details.otherSegments.length+' trechos fora da aplicação')+': confira a pessoa antes de usar']:
    ['Cobertura '+coverText(details.selectedCoverage)+' do trajeto selecionado'];
  if(details.otherSegments.length)parts.push('Qualidade abaixo: somente do trajeto selecionado');
  if(Number.isFinite(q.meanConfidence))parts.push('confiança do detector média '+dec(q.meanConfidence)+(Number.isFinite(q.minConfidence)?', mínima '+dec(q.minConfidence):''));
  const runs=q.interpolatedRuns||[],runTime=runs.reduce((n,[a,b])=>n+(b-a),0);
  parts.push(runs.length?runs.length+' trecho'+(runs.length>1?'s':'')+' interpolado'+(runs.length>1?'s':'')+' ('+sec(runTime)+' s)':'sem trechos interpolados');
  const low=(q.lowConfidence||[]).length;if(low)parts.push(low+' trecho'+(low>1?'s':'')+' de baixa confiança');
  const amb=(q.ambiguousTimes||[]).length;parts.push(amb?amb+' descarte'+(amb>1?'s':'')+' por ambiguidade (outro rosto parecido perto)':'sem ambiguidade');
  return parts.join(' · ')+'.';
}
// Base64 sem depender de atob (nem sempre presente no UXP).
function base64Bytes(text){
  const map=new Int16Array(128).fill(-1),chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for(let i=0;i<chars.length;i++)map[chars.charCodeAt(i)]=i;
  const clean=String(text||'').replace(/[^A-Za-z0-9+/]/g,''),out=new Uint8Array(Math.floor(clean.length*3/4));
  let buffer=0,bits=0,n=0;
  for(let i=0;i<clean.length;i++){buffer=(buffer<<6)|map[clean.charCodeAt(i)];bits+=6;if(bits>=8){bits-=8;out[n++]=(buffer>>bits)&255;}}
  return out.subarray(0,n);
}
module.exports={issues,label,summary,lostRanges,coverageDetails,canAutoApply,groupTimes,base64Bytes,coverText,rangeText};
