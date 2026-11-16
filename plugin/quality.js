'use strict';
// Optional processing always starts from original data and keeps every frame.
function geometry(points){
  let sum=0,x=0,y=0,minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length],cross=a.x*b.y-b.x*a.y;
    sum+=cross;x+=(a.x+b.x)*cross;y+=(a.y+b.y)*cross;
    minX=Math.min(minX,a.x);minY=Math.min(minY,a.y);maxX=Math.max(maxX,a.x);maxY=Math.max(maxY,a.y);
  }
  const out={area:Math.abs(sum)/2,width:maxX-minX,height:maxY-minY};
  if(Math.abs(sum)>1e-8){out.centroidX=x/(3*sum);out.centroidY=y/(3*sum);}
  return out;
}
function options(value={}){
  const center=value.center||'original',filter=value.filter||'none';
  if(!['original','area'].includes(center)||!['none','adaptive','outliers'].includes(filter))throw Error('Método de movimento incompatível.');
  if(value.ignoreFirst!==undefined&&typeof value.ignoreFirst!=='boolean')throw Error('Referência inicial incompatível.');
  return {center,filter,...(value.ignoreFirst===true?{ignoreFirst:true}:{})};
}
function process(data,value={}){
  if(data.rows.some(r=>r.trackingPoint!==undefined)){
    const motion=require('./core.js').motionRows(data.rows),processed=process({...data,rows:motion},value);
    return {...processed,rows:processed.rows.map((r,i)=>({...data.rows[i],angle:r.angle,trackingPoint:{x:r.x,y:r.y}}))};
  }
  const opt=options(value),rows=data.rows.map(row=>({...row}));
  if(opt.center==='area'){
    if(!rows.every(r=>Number.isFinite(r.centroidX)&&Number.isFinite(r.centroidY)))throw Error('Este trajeto não contém centro de área. Atualize uma máscara vetorial ou use o centro original.');
    for(const row of rows){row.x=row.centroidX;row.y=row.centroidY;}
  }
  // Ignore the first mask measurement, not its timeline time. Hold the second
  // measurement at the first sample so no neutral frame or timing shift appears.
  const holdStart=()=>{if(opt.ignoreFirst&&rows.length>=2){const frame=rows[0].frame;rows[0]={...rows[1],frame};}};
  holdStart();
  if(opt.filter==='none'||rows.length<3)return {...data,rows};
  const original=rows.map(r=>({...r})),diag=Math.hypot(data.SW||data.W,data.SH||data.H);
  // Local bidirectional calculation avoids a causal delay and does not bridge gaps.
  for(let i=1;i<rows.length-1;i++){
    if(data.times[i]-data.times[i-1]>1.5/data.fps||data.times[i+1]-data.times[i]>1.5/data.fps)continue;
    const a=original[i-1],b=original[i],c=original[i+1];
    // Recovered losses hold the last framing. Neither optional filter may
    // move these samples or borrow a measurement from another segment.
    // Untagged legacy trajectories follow exactly the previous calculation.
    if(a.held===true||b.held===true||c.held===true||a.trackingSegment!==b.trackingSegment||b.trackingSegment!==c.trackingSegment)continue;
    if(opt.filter==='outliers'){
      const excursion=Math.hypot(b.x-(a.x+c.x)/2,b.y-(a.y+c.y)/2),neighbor=Math.hypot(a.x-c.x,a.y-c.y);
      if(excursion>diag*.025&&excursion>neighbor*3){rows[i].x=(a.x+c.x)/2;rows[i].y=(a.y+c.y)/2;}
    }else{
      const speed=Math.hypot(c.x-a.x,c.y-a.y)*data.fps/diag;
      const amount=.65/(1+speed*20);
      rows[i].x=b.x+(a.x-2*b.x+c.x)*amount/2;
      rows[i].y=b.y+(a.y-2*b.y+c.y)*amount/2;
    }
  }
  holdStart();
  return {...data,rows};
}
module.exports={geometry,options,process};
