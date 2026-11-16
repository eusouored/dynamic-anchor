"use strict";
const H=require('./head-reference.js');
function validate(indices,count){
 if(indices===undefined)return null;
 if(!Array.isArray(indices)||indices.length<2||indices.some((n,i)=>!Number.isInteger(n)||n<0||n>=count||(i&&n<=indices[i-1])))throw Error('Índices de keyframes analisados inválidos.');
 return indices.slice();
}
function fromTrajectory(data,times){
 if(!H.isSampled(data.trackingReference))return {};
 H.validateSamples(data.analysisSamples,data.times,data.selection,{fps:data.fps,mediaFps:data.mediaFps});
 const by=new Map(times.map((t,i)=>[Math.round((t-data.selection.inPoint)*data.fps),i]));
 const indices=data.analysisSamples.map(s=>by.get(Math.round((s.time-data.selection.inPoint)*data.fps)));
 validate(indices,times.length);return {keyframeIndices:indices};
}
module.exports={validate,fromTrajectory};
