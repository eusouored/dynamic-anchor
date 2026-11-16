'use strict';
// Composição a partir do trajeto do rosto (somente trajetos do motor de rosto,
// que trazem a altura da caixa do rosto em cada quadro).
// - evaluate: mede o enquadramento atual do painel (tamanho do rosto na saída,
//   folga acima da cabeça, quadros com a cabeça cortada, quadros com bordas).
// - suggest: calcula zoom fixo e posição vertical. Duas prioridades:
//   'face' (padrão): cabeça inteira, tamanho e folga pedidos; o zoom é limitado
//     pela altura da cabeça e pelo limite do painel. Se a fonte não tiver imagem
//     suficiente, aparecem bordas, e isso é dito.
//   'fill': sem bordas. Entre os enquadramentos sem bordas, o que menos corta a
//     cabeça e fica mais perto do tamanho pedido. Pode cortar a cabeça, e isso é dito.
// A caixa do detector vai da testa ao queixo; o topo da cabeça (cabelo) é
// estimado em 35% da altura do rosto acima da caixa. É uma estimativa.
const C=require('./core.js');
const HAIR=0.35,TOP=0.5+HAIR,MARGIN=0.02;
const sorted=values=>values.filter(Number.isFinite).sort((a,b)=>a-b);
// Long tracks must not expand one function argument per frame. Preserve the
// same Math.min/max handling, including signed zero and nonfinite values.
function rangeBy(values,select){
  let min=Infinity,max=-Infinity;
  for(const value of values){const n=select(value);min=Math.min(min,n);max=Math.max(max,n);}
  return {min,max};
}
function quantile(values,q){const v=sorted(values);if(!v.length)return NaN;const i=Math.min(v.length-1,Math.max(0,Math.round(q*(v.length-1))));return v[i];}
function usable(d){return !!(d&&d.type==='external-face'&&Array.isArray(d.rows)&&d.rows.length>=2&&d.rows.every(r=>Number.isFinite(r.height)&&r.height>0&&Number.isFinite(r.y))&&d.W>0&&d.H>0&&
  (!d.rows.some(r=>r.trackingPoint!==undefined)||d.rows.every(r=>r.trackingPoint&&[r.trackingPoint.x,r.trackingPoint.y].every(Number.isFinite))));}
// Physical face bounds stay in row.x/y. Only the tracked reference may differ.
const point=row=>row.trackingPoint||row;
const physicalHeadTop=r=>r.headBounds?r.headBounds.top:r.y-TOP*r.height;
const headBottom=r=>r.headBounds?r.headBounds.bottom:r.y+.5*r.height;
// Borda visível num quadro: algum canto da saída fica fora da imagem de origem.
function hasBorder(k,W,H){
  const p=C.applyTransform([{x:0,y:0},{x:W,y:H}],k),eps=0.5;
  return p[0].x>eps||p[0].y>eps||p[1].x<W-eps||p[1].y<H-eps;
}
function evaluate(d,spec){
  if(!usable(d)||!spec||!spec.opt)return null;
  // A avaliação deve respeitar as mesmas lacunas que o cálculo aplicado.
  const measured=d.rows.map(r=>({...r,angle:0}));
  const keys=C.anchorFraming(measured,0,{...spec.opt,frame:spec.opt.frame||{w:d.W,h:d.H}});
  let cut=0,borders=0,minTop=Infinity,maxChin=-Infinity;const sizes=[];
  d.rows.forEach((r,i)=>{
    const k=keys[i];
    const top=C.applyTransform([{x:r.x,y:physicalHeadTop(r)}],k)[0].y,chin=C.applyTransform([{x:r.x,y:headBottom(r)}],k)[0].y;
    if(top<0||chin>d.H)cut++;if(hasBorder(k,d.W,d.H))borders++;
    minTop=Math.min(minTop,top);maxChin=Math.max(maxChin,chin);sizes.push(k.scale*r.height/d.H);
  });
  return {scale:keys.meta.scale,...(keys.meta.variableScale?{minScale:keys.meta.minScale,variableScale:true}:{}),clamped:!!keys.meta.clamped,neededScale:keys.meta.needed,faceFraction:quantile(sizes,.5),
    headTopMin:minTop/d.H,chinMax:maxChin/d.H,cutFrames:cut,cutFraction:cut/d.rows.length,borderFrames:borders,borderFraction:borders/d.rows.length,frames:d.rows.length};
}
// Medidas de um enquadramento (s, tx, ty) direto sobre as linhas, sem suavização.
function measure(d,s,tx,ty){
  let cut=0,borders=0;const W=d.W,H=d.H;
  for(const r of d.rows){
    const p=point(r);
    const headTop=ty+s*(physicalHeadTop(r)-p.y),chin=ty+s*(headBottom(r)-p.y);
    if(headTop<0||chin>H)cut++;
    const left=tx-s*p.x,top=ty-s*p.y,right=tx+s*(W-p.x),bottom=ty+s*(H-p.y);
    if(left>0.5||top>0.5||right<W-0.5||bottom<H-0.5)borders++;
  }
  return {cut,borders};
}
// Fração dos quadros em que o topo estimado da cabeça já está fora da imagem de origem.
function sourceCut(d){return d.rows.filter(r=>physicalHeadTop(r)<0).length/d.rows.length;}
// faceFraction: altura desejada do rosto na saída (fração da altura do quadro).
// headroom: folga desejada entre o topo da cabeça e o topo do quadro.
function suggest(d,{faceFraction=.22,headroom=.08,maxScale=2.5,offsetX=0,priority='face'}={}){
  if(!usable(d))throw Error('A composição pelo rosto precisa de um trajeto do motor de rosto.');
  if(!(faceFraction>0&&faceFraction<1)||!(headroom>=0&&headroom<.5))throw Error('Confira tamanho do rosto e espaço acima.');
  if(!(maxScale>=1))throw Error('Limite de zoom inválido.');
  if(!['face','fill'].includes(priority))throw Error('Prioridade de composição inválida.');
  const W=d.W,H=d.H,n=d.rows.length,heights=d.rows.map(r=>r.height),hMed=quantile(heights,.5),hHigh=quantile(heights,1);
  const hasPoint=d.rows[0].trackingPoint!==undefined;
  const per=d.rows.map(r=>({ct:{x:point(r).x,y:point(r).y},r:0})),tx=W/2+W*offsetX/100;
  const desired=Math.max(1,faceFraction*H/hMed);
  const topDistances=hasPoint?d.rows.map(r=>r.trackingPoint.y-physicalHeadTop(r)):null;
  const chinDistances=hasPoint?d.rows.map(r=>headBottom(r)-r.trackingPoint.y):null;
  const topMed=hasPoint?quantile(topDistances,.5):TOP*hMed;
  const topHigh=hasPoint?quantile(topDistances,1):TOP*hHigh;
  const chinHigh=hasPoint?quantile(chinDistances,1):0.5*hHigh;
  // Protect every measured head, including a brief approach. Percentiles may
  // describe typical size, but cannot authorize cropping the rare largest face.
  const headLimit=H*(1-headroom-MARGIN)/(hasPoint?topHigh+chinHigh:(TOP+0.5)*hHigh);
  // Posição vertical do centro do rosto para um zoom s: topo da cabeça típica na folga
  // pedida, sem cortar a cabeça maior e sem empurrar o queixo para fora.
  const faceY=s=>{
    let ty=hasPoint?Math.max(headroom*H+s*topMed,MARGIN*H+s*topHigh):Math.max(headroom*H+TOP*s*hMed,MARGIN*H+TOP*s*hHigh);
    const chin=hasPoint?H-MARGIN*H-s*chinHigh:H-MARGIN*H-0.5*s*hHigh;
    if(ty>chin&&chin>=(hasPoint?s*topHigh:TOP*s*hHigh))ty=chin;// só move para cima se a cabeça continuar inteira
    return Math.max(0,Math.min(H,ty));
  };
  let s,ty,feasible=true,fillOffset=null;
  if(priority==='face'){
    s=Math.max(1,Math.min(desired,maxScale,headLimit));ty=faceY(s);
  }else{
    // Sem bordas: procura em zooms de 1 até o limite; para cada um, a posição mais
    // baixa possível (cabeça mais para dentro) sem mostrar bordas.
    const {min:minY,max:maxY}=rangeBy(d.rows,r=>point(r).y);
    const target=Math.min(desired,maxScale),maxStep=Math.floor(maxScale*1000+1e-9),seen=new Set();let best=null;
    for(let k=0;k<=400;k++){
      // Os controles usam passos de 0,1 ponto percentual. A cobertura precisa
      // ser conferida nesses valores, não antes de um arredondamento posterior.
      const step=1000+Math.round((maxStep-1000)*k/400);
      if(seen.has(step))continue;seen.add(step);
      const sc=1+((step-1000)/10)/100;
      const low=Math.ceil(((H-sc*(H-maxY))/H-.5)*1000-1e-9),high=Math.floor((sc*minY/H-.5)*1000+1e-9);
      const a=Math.max(-500,low),b=Math.min(500,high);if(a>b)continue;
      const offset=Math.max(a,Math.min(b,Math.round((faceY(sc)/H-.5)*1000)));
      const y=H/2+H*(offset/10)/100;
      if(C.requiredScale(per,{x:tx,y},{w:W,h:H})>sc+1e-9)continue;
      const m=measure(d,sc,tx,y),distance=Math.abs(sc-target);
      // Compare exact frame counts first. Rounding a percentage would hide
      // a rare cropped frame on a long take and prefer its tighter framing.
      if(!best||m.cut<best.cut||m.cut===best.cut&&distance<best.distance)best={cut:m.cut,distance,sc,y,offset:offset/10};
    }
    if(best){s=best.sc;ty=best.y;fillOffset=best.offset;}else{
      feasible=false;s=1+((maxStep-1000)/10)/100;
      const y=Math.max(Math.min(faceY(s),s*minY),H-s*(H-maxY));
      fillOffset=Math.max(-50,Math.min(50,Math.round((y/H-.5)*1000)/10));ty=H/2+H*fillOffset/100;
    }
  }
  const m=measure(d,s,tx,ty),needed=C.requiredScale(per,{x:tx,y:ty},{w:W,h:H});
  if(priority==='fill')feasible=feasible&&m.borders===0&&needed<=s+1e-9&&s<=maxScale+1e-9;
  const offsetY=fillOffset===null?Math.max(-50,Math.min(50,Math.round((ty/H-.5)*1000)/10)):fillOffset;
  const scalePercent=Math.max(0,Math.round((s-1)*1000)/10);
  return {priority,feasible,scale:s,scalePercent,offsetY,faceFraction:s*hMed/H,headTop:(hasPoint?ty-s*topMed:ty-TOP*s*hMed)/H,
    desiredScale:desired,limited:s+1e-9<Math.min(desired,10),limitedByZoom:priority==='face'&&desired>maxScale&&maxScale<=headLimit,limitedByHead:priority==='face'&&headLimit<Math.min(desired,maxScale),
    headFits:headLimit>=1,borders:m.borders>0,borderFraction:m.borders/n,cutFraction:m.cut/n,cutRisk:m.cut>0,neededScale:needed,sourceCut:sourceCut(d)};
}
// Prepared path: the workflow supplies processed references and a numeric native
// geometry snapshot. Physical face boxes always remain in data.rows.
const G=require('./framing-geometry.js');
function prepare(data,spec,geometry){
  G.validate(geometry);
  if(!usable(data)||!spec||!spec.opt||geometry.W!==data.W||geometry.H!==data.H||geometry.measuredRows.length!==data.rows.length)
    throw Error('Geometria, formato ou quadros incompatíveis na composição pelo rosto.');
  return {data,spec,geometry};
}
function physicalCorners(row,top,bottom){
  if(row.headBounds){const b=row.headBounds;return [{x:b.left,y:b.top},{x:b.right,y:b.top},{x:b.left,y:b.bottom},{x:b.right,y:b.bottom}];}
  const half=Number.isFinite(row.width)&&row.width>0?row.width/2:0;
  return [{x:row.x-half,y:top},{x:row.x+half,y:top},{x:row.x+half,y:bottom},{x:row.x-half,y:bottom}];
}
function facePoints(prepared,keys){
  const {data:d,geometry:g}=prepared;
  return d.rows.map((row,i)=>{
    const transform=points=>C.applyTransform(points.map(p=>G.sourcePoint(g,i,p)),keys[i]);
    const head=transform(physicalCorners(row,row.y-TOP*row.height,row.y+.5*row.height));
    // Face size is a length, independent of the desired rotation's projection.
    const axis=transform([{x:row.x,y:row.y-row.height/2},{x:row.x,y:row.y+row.height/2}]);
    return {top:Math.min(...head.map(p=>p.y)),chin:Math.max(...head.map(p=>p.y)),
      height:Math.hypot(axis[1].x-axis[0].x,axis[1].y-axis[0].y)};
  });
}
function evaluatePrepared(prepared,spec=prepared&&prepared.spec){
  prepare(prepared.data,spec,prepared.geometry);
  const keys=G.calculate(prepared.geometry,spec,{guardAuto:false,guardFill:false}),bounds=facePoints(prepared,keys),coverage=G.evaluateCoverage(prepared.geometry,keys),n=bounds.length;
  const cut=bounds.filter(p=>p.top<0||p.chin>prepared.data.H).length;
  const minTop=rangeBy(bounds,p=>p.top).min,maxChin=rangeBy(bounds,p=>p.chin).max;
  return {scale:keys.meta.scale,...(keys.meta.variableScale?{minScale:keys.meta.minScale,variableScale:true}:{}),clamped:!!keys.meta.clamped,neededScale:coverage.neededScale,
    faceFraction:quantile(bounds.map(p=>p.height/prepared.data.H),.5),headTopMin:minTop/prepared.data.H,
    chinMax:maxChin/prepared.data.H,cutFrames:cut,cutFraction:cut/n,
    borderFrames:coverage.borderFrames,borderFraction:coverage.borderFraction,frames:n};
}
function candidateSpec(base,percent,offsetY,H,priority,offsetX,W){
  const opt={...base.opt,scaleMode:'fixed',scalePercent:percent,targetOffset:{...(base.opt.targetOffset||{}),y:H*offsetY/100}};
  delete opt.zoomProtection;
  if(offsetX!==undefined)opt.targetOffset.x=W*offsetX/100;
  if(priority==='fill')opt.guardFill=true;else delete opt.guardFill;
  return {...base,resetScale:percent===0,opt};
}
function legacyEquivalent({data:d,spec,geometry:g}){
  if(g.basisScale!==1||g.activeScale!==100||spec.opt.zoomProtection||spec.opt.rotation||spec.opt.tremor||spec.opt.smoothWin||spec.opt.useX===false||spec.opt.useY===false)return false;
  const anchor=g.activeAnchor,target=spec.opt.target;
  if(anchor.x!==d.W/2||anchor.y!==d.H/2||target&&(target.x!==d.W/2||target.y!==d.H/2))return false;
  return d.rows.every((r,i)=>{
    const p=point(r),m=g.measuredRows[i],s=g.sourceTransform&&g.sourceTransform[i];
    return p.x===m.x&&p.y===m.y&&(m.angle||0)===0&&
      (!s||s.scale===1&&s.rotation===0&&s.position.x===s.anchor.x&&s.position.y===s.anchor.y);
  });
}
function suggestPrepared(prepared,options={}){
  const {data:d,spec:base,geometry:g}=prepare(prepared.data,prepared.spec,prepared.geometry);
  const {faceFraction=.22,headroom=.08,maxScale=2.5,offsetX,priority='face'}=options;
  if(!(faceFraction>0&&faceFraction<1)||!(headroom>=0&&headroom<.5)||!Number.isFinite(maxScale)||maxScale<1||!['face','fill'].includes(priority))throw Error('Confira tamanho do rosto, espaço acima, prioridade e limite de zoom.');
  const W=d.W,H=d.H,baseOpt=G.resolveOptions(g,base);
  const xSpec=offsetX===undefined?base:{...base,opt:{...base.opt,targetOffset:{...(base.opt.targetOffset||{}),x:W*offsetX/100}}};
  // Suggestions choose a fixed scale. Measure their unit geometry without
  // the responsive policy, then evaluate the resulting fixed controls.
  const unit=C.anchorFraming(g.measuredRows,base.refIndex,{...G.resolveOptions(g,xSpec),zoomProtection:false,scaleOverride:1});
  const ref=G.effectiveReferences(unit),target=unit.meta.target,unitBounds=facePoints(prepared,unit);
  const topDistances=unitBounds.map(p=>target.y-p.top),chinDistances=unitBounds.map(p=>p.chin-target.y),medianHeight=quantile(unitBounds.map(p=>p.height),.5);
  const topMed=quantile(topDistances,.5),topHigh=quantile(topDistances,1),chinHigh=quantile(chinDistances,1);
  const denominator=topHigh+chinHigh,headLimit=denominator>0?H*(1-headroom-MARGIN)/denominator:Infinity;
  const desired=Math.max(1,faceFraction*H/medianHeight),maxStep=Math.floor(maxScale*1000+1e-9);
  const baseY=baseOpt.target?baseOpt.target.y:target.y-(baseOpt.targetOffset&&baseOpt.targetOffset.y||0);
  const faceY=s=>{
    let y=Math.max(headroom*H+s*topMed,MARGIN*H+s*topHigh),chin=H-MARGIN*H-s*chinHigh;
    if(y>chin&&chin>=s*topHigh)y=chin;
    return Math.max(0,Math.min(H,y));
  };
  const rays=ref.map(({ct,r},i)=>{
    const m=g.sourceTransform&&g.sourceTransform[i];let center=ct;
    if(m){const v=C.rot({x:ct.x-m.position.x,y:ct.y-m.position.y},-m.rotation);center={x:m.anchor.x+v.x/m.scale,y:m.anchor.y+v.y/m.scale};}
    const angle=(r+(m?m.rotation:0))*Math.PI/180;
    return {center,m:m?m.scale:1,c:Math.cos(angle),s:Math.sin(angle)};
  });
  // For fixed scale, inverse corner coordinates are linear in target Y.
  // Intersect their intervals once, then quantize directly to the slider grid.
  function verticalInterval(scale){
    let lo=baseY-H/2,hi=baseY+H/2;
    const constrain=(a,b,size)=>{
      if(Math.abs(b)<1e-13)return a>=-1e-9&&a<=size+1e-9;
      let x=-a/b,y=(size-a)/b;if(x>y)[x,y]=[y,x];lo=Math.max(lo,x);hi=Math.min(hi,y);return lo<=hi+1e-8;
    };
    for(const a of rays)for(const [qx,qy]of [[0,0],[W,0],[W,H],[0,H]]){
      const sm=scale*a.m;
      if(!constrain(a.center.x+(a.c*(qx-target.x)+a.s*qy)/sm,-a.s/sm,W)||
         !constrain(a.center.y+(-a.s*(qx-target.x)+a.c*qy)/sm,-a.c/sm,H))return null;
    }
    return [lo,hi];
  }
  function controls(step,yHint,requireCoverage){
    const percent=(step-1000)/10,probe=candidateSpec(base,percent,0,H,priority,offsetX,W),resolved=G.resolveOptions(g,probe);
    const scale=resolved.scaleOverride===undefined?step/1000:resolved.scaleOverride;
    if(!(scale>=1&&scale<=maxScale+1e-9))return null;
    let low=-500,high=500;
    if(requireCoverage){const interval=verticalInterval(scale);if(!interval)return null;
      if(base.opt.useY===false){if(target.y<interval[0]-1e-8||target.y>interval[1]+1e-8)return null;}
      else{low=Math.max(low,Math.ceil((interval[0]-baseY)/H*1000-1e-8));high=Math.min(high,Math.floor((interval[1]-baseY)/H*1000+1e-8));if(low>high)return null;}
    }
    const offset=Math.max(low,Math.min(high,Math.round(((yHint===undefined?faceY(scale):yHint)-baseY)/H*1000)));
    const y=base.opt.useY===false?target.y:baseY+H*offset/1000;
    const cut=topDistances.filter((v,i)=>y-scale*v<0||y+scale*chinDistances[i]>H).length;
    return {step,scale,percent,offsetY:offset/10,y,cut,spec:candidateSpec(base,percent,offset/10,H,priority,offsetX,W)};
  }
  let best=null,legacy=null;
  if(legacyEquivalent(prepared)){
    legacy=suggest(d,{...options,offsetX:offsetX===undefined?(base.opt.targetOffset&&base.opt.targetOffset.x||0)/W*100:offsetX});
    best=controls(1000+Math.round(legacy.scalePercent*10),H/2+H*legacy.offsetY/100,false);
  }
  if(!best&&priority==='face'){
    const ideal=Math.max(1,Math.min(desired,maxScale,headLimit)),step=Math.min(maxStep,Math.max(1000,Math.round(ideal*1000)));
    best=controls(step,undefined,false)||controls(Math.min(maxStep,1001),undefined,false);
  }
  if(!best&&priority==='fill'){
    const steps=new Set([1000,1001,maxStep,Math.min(maxStep,Math.max(1000,Math.round(desired*1000))),Math.min(maxStep,Math.max(1000,Math.floor(headLimit*1000)))]);
    for(let i=0;i<=400;i++)steps.add(1000+Math.round((maxStep-1000)*i/400));
    for(const step of steps){if(!Number.isFinite(step)||step<1000||step>maxStep)continue;const candidate=controls(step,undefined,true);if(!candidate)continue;
      candidate.distance=Math.abs(candidate.scale-Math.min(desired,maxScale));
      if(!best||candidate.cut<best.cut||candidate.cut===best.cut&&candidate.distance<best.distance)best=candidate;
    }
  }
  const found=!!best;
  if(!best)best=controls(maxStep,undefined,false);
  // Only the unrepresentable zero state can leave no bounded candidate.
  if(!best){const spec=candidateSpec(base,0,0,H,priority,offsetX,W),e=evaluatePrepared(prepared,spec);return {priority,feasible:false,scale:e.scale,scalePercent:0,offsetY:0,spec,guardFill:priority==='fill',...e,sourceCut:sourceCut(d)};}
  const after=evaluatePrepared(prepared,best.spec),feasible=priority!=='fill'||found&&after.borderFrames===0&&after.scale+1e-9>=after.neededScale&&after.scale<=maxScale+1e-9;
  return {...(legacy||{}),priority,feasible,scale:after.scale,scalePercent:best.percent,offsetY:best.offsetY,
    faceFraction:after.faceFraction,headTop:(best.y-best.scale*topMed)/H,desiredScale:desired,
    limited:after.scale+1e-9<Math.min(desired,10),limitedByZoom:priority==='face'&&desired>maxScale&&maxScale<=headLimit,
    limitedByHead:priority==='face'&&headLimit<Math.min(desired,maxScale),headFits:headLimit>=1,
    borders:after.borderFrames>0,borderFraction:after.borderFraction,cutFraction:after.cutFraction,cutRisk:after.cutFrames>0,
    neededScale:after.neededScale,sourceCut:sourceCut(d),spec:best.spec,guardFill:priority==='fill'};
}
module.exports={evaluate,suggest,usable,measure,sourceCut,HAIR,prepare,evaluatePrepared,suggestPrepared};
