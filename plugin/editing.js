'use strict';
const I=require('./integrity.js');
function correct(data,layers=[]){
  if(data.rows.some(r=>r.trackingPoint!==undefined)){
    const motion=require('./core.js').motionRows(data.rows),edited=correct({...data,rows:motion},layers);
    return {...edited,rows:edited.rows.map((r,i)=>({...data.rows[i],trackingPoint:{x:r.x,y:r.y}}))};
  }
  const rows=data.rows.map(r=>({...r}));
  if(!Array.isArray(layers)||layers.length>100)throw Error('Camadas de correção inválidas.');
  for(const layer of layers){
    if(!layer||![layer.start,layer.end].every(Number.isFinite)||layer.start>=layer.end||layer.start<data.times[0]-1e-7||layer.end>data.times[data.times.length-1]+1e-7)throw Error('A correção deve ficar dentro do intervalo rastreado.');
    let points=null;
    if(layer.kind==='points'){
      if(!Array.isArray(layer.points)||!layer.points.length||layer.points.length>1000)throw Error('Pontos de correção inválidos.');
      points=[{time:layer.start,dx:0,dy:0},...layer.points,{time:layer.end,dx:0,dy:0}];
      for(let i=0;i<points.length;i++){const p=points[i];if(![p.time,p.dx,p.dy].every(Number.isFinite)||Math.abs(p.dx)>data.W*4||Math.abs(p.dy)>data.H*4||(i&&p.time<=points[i-1].time))throw Error('Pontos devem estar em ordem, dentro do intervalo e sem tempos repetidos.');}
    }else if(layer.kind&&layer.kind!=='offset')throw Error('Tipo de correção incompatível.');
    else if(![layer.dx,layer.dy].every(Number.isFinite)||Math.abs(layer.dx)>data.W*4||Math.abs(layer.dy)>data.H*4)throw Error('Deslocamento da correção fora da área suportada.');
    const indices=data.times.map((t,i)=>t>=layer.start-1e-7&&t<=layer.end+1e-7?i:-1).filter(i=>i>=0);
    if(indices.length<3)throw Error('Escolha pelo menos três quadros para uma correção com transição.');
    const last=indices[indices.length-1],a=data.times[indices[0]],b=data.times[last];
    let segment=0;
    for(const i of indices){
      if(points){const time=data.times[i];while(segment<points.length-2&&points[segment+1].time<time)segment++;const p=points[segment],q=points[segment+1],u=Math.max(0,Math.min(1,(time-p.time)/(q.time-p.time))),t=u*u*(3-2*u);rows[i].x+=p.dx+(q.dx-p.dx)*t;rows[i].y+=p.dy+(q.dy-p.dy)*t;}
      else{const mix=(data.times[i]-a)/(b-a),weight=i===indices[0]||i===last?0:Math.sin(Math.PI*mix)**2;rows[i].x+=layer.dx*weight;rows[i].y+=layer.dy*weight;}
    }
  }
  return {...data,rows};
}
function boundaryWarnings(data){
  if(!data?.rows||data.rows.length<4)return [];
  data={...data,rows:require('./core.js').motionRows(data.rows)};
  const warnings=[],diag=Math.hypot(data.W,data.H),ratio=(a,b)=>a>0&&b>0?Math.max(a/b,b/a):1;
  for(const end of [false,true]){
    const ids=end?[data.rows.length-1,data.rows.length-2,data.rows.length-3,data.rows.length-4]:[0,1,2,3];
    const [a,b,c,d]=ids.map(i=>data.rows[i]);
    if(ids.slice(1).some((i,j)=>Math.abs(data.times[i]-data.times[ids[j]])>1.5/data.fps))continue;
    const changed=['area','width','height'].some(k=>ratio(a[k],b[k])>1.3);
    const stable=['area','width','height'].every(k=>ratio(b[k],c[k])<1.1&&ratio(c[k],d[k])<1.1);
    const jump=Math.hypot(a.x-b.x,a.y-b.y),neighbor=Math.max(Math.hypot(b.x-c.x,b.y-c.y),Math.hypot(c.x-d.x,c.y-d.y));
    if(changed&&stable&&jump>Math.max(3,diag*.001,neighbor*5))warnings.push({start:Math.min(data.times[ids[0]],data.times[ids[1]]),end:Math.max(data.times[ids[0]],data.times[ids[1]]),kind:end?'centro instável no último quadro':'centro instável no primeiro quadro',value:jump});
  }
  return warnings;
}
function analyze(data){
  data={...data,rows:require('./core.js').motionRows(data.rows)};
  const warnings=boundaryWarnings(data),diag=Math.hypot(data.W,data.H);
  const add=(i,kind,value)=>warnings.push({start:data.times[Math.max(0,i-1)],end:data.times[i],kind,...(Number.isFinite(value)?{value}:{})});
  for(let i=1;i<data.rows.length;i++){
    const a=data.rows[i-1],b=data.rows[i],distance=Math.hypot(b.x-a.x,b.y-a.y)/diag;
    let angle=b.angle-a.angle;while(angle>180)angle-=360;while(angle< -180)angle+=360;
    if(distance>.15)warnings.push({start:data.times[i-1],end:data.times[i],kind:'deslocamento brusco',value:distance});
    if(Math.abs(angle)>45)warnings.push({start:data.times[i-1],end:data.times[i],kind:'mudança angular',value:angle});
    if(data.times[i]-data.times[i-1]>2.1/data.fps)warnings.push({start:data.times[i-1],end:data.times[i],kind:'intervalo sem amostras'});
    if(a.area>0&&b.area>0&&Math.max(a.area/b.area,b.area/a.area)>1.8)add(i,'mudança de área',b.area/a.area);
    if(a.width>0&&a.height>0&&b.width>0&&b.height>0){const ratio=(b.width/b.height)/(a.width/a.height);if(ratio>1.6||ratio<1/1.6)add(i,'deformação da região',ratio);}
    if(i<data.rows.length-1){const c=data.rows[i+1],excursion=Math.hypot(b.x-(a.x+c.x)/2,b.y-(a.y+c.y)/2),travel=Math.hypot(c.x-a.x,c.y-a.y);if(excursion>diag*.025&&excursion>travel*3)add(i,'oscilação isolada',excursion);}
  }
  let stillStart=null;
  for(let i=1;i<=data.rows.length;i++){
    const still=i<data.rows.length&&Math.hypot(data.rows[i].x-data.rows[i-1].x,data.rows[i].y-data.rows[i-1].y)<diag*.0001&&data.times[i]-data.times[i-1]<1.5/data.fps;
    if(still){if(stillStart===null)stillStart=i-1;}else if(stillStart!==null){
      const end=i-1,prior=Math.max(0,stillStart-Math.ceil(data.fps*.5)),next=Math.min(data.rows.length-1,end+Math.ceil(data.fps*.5));
      if(data.times[end]-data.times[stillStart]>=1&&stillStart>0&&next>end&&Math.hypot(data.rows[prior].x-data.rows[stillStart].x,data.rows[prior].y-data.rows[stillStart].y)>diag*.01&&Math.hypot(data.rows[next].x-data.rows[end].x,data.rows[next].y-data.rows[end].y)>diag*.01)warnings.push({start:data.times[stillStart],end:data.times[end],kind:'pausa entre movimentos; revisar alvo'});
      else if(i===data.rows.length&&data.times[end]-data.times[stillStart]>=3&&stillStart>0&&Math.hypot(data.rows[prior].x-data.rows[stillStart].x,data.rows[prior].y-data.rows[stillStart].y)>diag*.01)warnings.push({start:data.times[stillStart],end:data.times[end],kind:'imobilidade no final; revisar alvo'});
      stillStart=null;
    }
  }
  warnings.sort((a,b)=>a.start-b.start);const merged=[],lastByKind=new Map();
  for(const w of warnings){const previous=lastByKind.get(w.kind);if(previous&&w.start<=previous.end+1.5/data.fps)previous.end=Math.max(previous.end,w.end);else{const next={...w};merged.push(next);lastByKind.set(w.kind,next);}}
  return {warnings:merged.slice(0,100),total:merged.length,geometryAvailable:data.rows.some(r=>Number.isFinite(r.area)),note:'Indícios para revisão, sem correção automática. Área vetorial aproximada pelos vértices; objeto usa retângulo. Imobilidade não comprova perda do alvo.'};
}
function validateSettings(s){
  if(!s||s.version!==1||!['auto','fixed','none'].includes(s.mode)||!s.fields||!s.checks)throw Error('Configuração incompatível.');
  const limits={offsetX:[-50,50],offsetY:[-50,50],smoothWin:[0,100],scalePercent:[0,900],maxScale:[100,1000],maxRot:[0,180],deadzone:[0,180],shutterAngle:[0,360]};
  for(const [key,[min,max]]of Object.entries(limits)){const text=String(s.fields[key]).trim().replace(',','.'),n=Number(text);if(!text||!Number.isFinite(n)||n<min||n>max)throw Error('Valor inválido em '+key+'.');}
  for(const key of ['useX','useY','useRot','setShutter','centerTarget'])if(typeof s.checks[key]!=='boolean')throw Error('Controle inválido em '+key+'.');
  // Opcional (0.9.14, experimental): ausente = desligado, como em todos os ajustes anteriores.
  if(s.checks.tremorFilter!==undefined&&typeof s.checks.tremorFilter!=='boolean')throw Error('Controle inválido em tremorFilter.');
  if(s.checks.zoomProtection!==undefined&&typeof s.checks.zoomProtection!=='boolean')throw Error('Controle inválido em zoomProtection.');
  if(s.guardFill!==undefined&&typeof s.guardFill!=='boolean')throw Error('Controle inválido em guardFill.');
  require('./quality.js').options(s.quality);
  const settings=I.clone(s);
  delete settings.checks.zoomProtection; // Retired control in version 1 presets.
  return settings;
}
module.exports={correct,analyze,validateSettings,boundaryWarnings};
