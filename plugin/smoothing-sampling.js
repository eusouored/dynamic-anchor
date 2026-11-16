'use strict';
const H=require('./head-reference.js');

// Only scheduled sampling bridges are filterable. Missing observations, held
// frames and recovery transitions keep the existing gap protection. Derive
// this from saved provenance so old trajectories need no new face analysis.
function bridges(data){
  if(!data||!H.isSampled(data.trackingReference))return [];
  H.validate(data.trackingReference);
  H.validateSamples(data.analysisSamples,data.times,data.selection,{fps:data.fps,mediaFps:data.mediaFps});
  if(!Array.isArray(data.rows)||data.rows.length!==data.times.length)throw Error('Amostragem da suavização incompatível.');
  const frame=t=>Math.round((t-data.selection.inPoint)*data.fps);
  const byFrame=new Map(data.times.map((t,i)=>[frame(t),i]));
  const step=data.trackingReference.sampling.step,out=[];
  for(let s=1;s<data.analysisSamples.length;s++){
    const left=data.analysisSamples[s-1],right=data.analysisSamples[s];
    const delta=right.mediaFrame-left.mediaFrame;
    if(delta<=0||delta>step)continue;
    const a=byFrame.get(frame(left.time)),b=byFrame.get(frame(right.time));
    if(a===undefined||b===undefined||b<=a+1)continue;
    const segment=data.rows[a].trackingSegment;
    let safe=true;
    for(let i=a;i<=b;i++){
      const row=data.rows[i];
      if(row.held===true||row.gap!==undefined||row.trackingSegment!==segment||
        (i>a&&Math.abs((data.times[i]-data.times[i-1])*data.fps-1)>.01)){
        safe=false;break;
      }
    }
    if(safe)for(let i=a+1;i<b;i++)if(data.rows[i].interpolated===true)out.push(i);
  }
  return out;
}
module.exports={bridges};
