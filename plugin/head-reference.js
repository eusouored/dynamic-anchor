"use strict";
const LEGACY_METHOD='selected-head-center-v1',METHOD='selected-head-hybrid-v2',SAMPLED_METHOD='selected-head-hybrid-v3',SHA='0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f';
const isHead=ref=>[METHOD,LEGACY_METHOD,SAMPLED_METHOD].includes(ref?.method);
const isHybrid=ref=>[METHOD,SAMPLED_METHOD].includes(ref?.method);
const isSampled=ref=>ref?.method===SAMPLED_METHOD;
function reference(step){return {method:METHOD,offset:{x:0,y:0},sampling:{method:'fixed-stride-v1',step},model:{name:'bisenet-resnet18-head',sha256:SHA,runtime:'onnxruntime'},smoothing:{method:'robust-local-quadratic-v1',windowSeconds:.14},stabilization:{method:'face-motion-head-offset-v1',offsetSigmaSeconds:.4,measuredOffsetsOnly:true,maxHeadFraction:.5,headLossFallback:'selected-face-continuity-v1'},association:{method:'selected-face-overlap-v1',identityVerified:false}};}
function sampledReference(step){return {...reference(step),association:{...reference(step).association,instanceSeparation:'face-seeded-competitive-v1'},stabilization:{...reference(step).stabilization,visualMotion:'similarity-reference-v1',contourMotion:'selected-headwear-top-motion-v1'},method:SAMPLED_METHOD,applicationSampling:{method:'analyzed-source-frames-v1',frameMapping:'nearest-sequence-frame-v1'}};}
function validate(ref){
 if(!isHead(ref)||ref.offset?.x!==0||ref.offset?.y!==0||ref.sampling?.method!=='fixed-stride-v1'||![1,2,3].includes(ref.sampling.step)||ref.model?.name!=='bisenet-resnet18-head'||ref.model.sha256!==SHA||ref.model.runtime!=='onnxruntime'||ref.smoothing?.method!=='robust-local-quadratic-v1'||ref.smoothing.windowSeconds!==.14||ref.association?.method!=='selected-face-overlap-v1'||ref.association.identityVerified!==false)throw Error('Referência de cabeça inteira inválida.');
 if(isHybrid(ref)&&(ref.stabilization?.method!=='face-motion-head-offset-v1'||ref.stabilization.offsetSigmaSeconds!==.4||ref.stabilization.measuredOffsetsOnly!==true||ref.stabilization.maxHeadFraction!==.5||!['selected-face-continuity-v1','selected-face-scale-bidirectional-shape-v2'].includes(ref.stabilization.headLossFallback)))throw Error('Fusão de cabeça e rosto inválida.');
 for(const [field,value]of Object.entries({shapeValidation:'face-relative-temporal-shape-v1',offsetSupport:'bounded-observed-envelope-v1',gapRecovery:'bidirectional-csrt-head-gap-v1'}))if(ref.stabilization?.[field]!==undefined&&ref.stabilization[field]!==value)throw Error('Estabilização de cabeça incompatível: '+field+'.');
 if(isSampled(ref)&&ref.stabilization.visualMotion!==undefined&&ref.stabilization.visualMotion!=='similarity-reference-v1')throw Error('Movimento visual incompatível.');
 if(isSampled(ref)&&ref.association.instanceSeparation!==undefined&&ref.association.instanceSeparation!=='face-seeded-competitive-v1')throw Error('Separação de pessoas incompatível.');
 if(isSampled(ref)&&ref.stabilization.contourMotion!==undefined&&!['selected-headwear-top-motion-v1','selected-headwear-top-motion-v2','selected-headwear-top-motion-v3','selected-headwear-top-motion-v4-supported'].includes(ref.stabilization.contourMotion))throw Error('Contorno temporal incompatível.');
 if(isSampled(ref)&&ref.stabilization.headwearAdaptation!==undefined){const a=ref.stabilization.headwearAdaptation;if(a?.method!=='visible-accessory-hysteresis-v1'||a.seconds!==.2||a.presentFraction!==.12||a.absentFraction!==.02||a.minimumVisibleParts!==2)throw Error('Adaptação de acessórios incompatível.');}
 if(isSampled(ref)&&ref.stabilization.occlusionMotion!==undefined&&(ref.stabilization.occlusionMotion!=='selected-headwear-flow-residual-v1'||ref.stabilization.occlusionMaxFraction!==.06||ref.stabilization.occlusionBlendSeconds!==.15||ref.stabilization.occlusionSigmaSeconds!==.4))throw Error('Correção de oclusão incompatível.');
 if(isSampled(ref)&&ref.stabilization.occlusionReferenceRepair!==undefined){const r=ref.stabilization.occlusionReferenceRepair;if(r?.method!=='bounded-contour-reference-v2'||r.maxIntervalSeconds!==.5||r.maxCorrectionFraction!==.5||r.triggerResidualFraction!==.10||r.trustedResidualFraction!==.12||r.minLocalImpulseFraction!==.10)throw Error('Referência de oclusão incompatível.');}
 if(isSampled(ref)&&(ref.applicationSampling?.method!=='analyzed-source-frames-v1'||ref.applicationSampling.frameMapping!=='nearest-sequence-frame-v1'))throw Error('Amostragem dos keyframes inválida.');
 return ref;
}
function validateRow(row,W=Infinity,H=Infinity,{recovered=false,hybrid=false}={}){
 const b=row?.headBounds,p=row?.trackingPoint,sources=['segmented','interpolated',...(recovered?['gap']:[]),...(hybrid?['face-propagated']:[])],propagated=hybrid&&['face-propagated','gap'].includes(b?.source);
 if(!b||!p||![b.left,b.top,b.right,b.bottom,p.x,p.y].every(Number.isFinite)||b.left<(propagated?-W:0)||b.top<(propagated?-H:0)||b.right>(propagated?2*W:W)||b.bottom>(propagated?2*H:H)||b.right<=b.left||b.bottom<=b.top||!sources.includes(b.source)||Math.abs(p.x-(b.left+b.right)/2)>(b.right-b.left)*(hybrid ? .5 : .25)+1e-6||Math.abs(p.y-(b.top+b.bottom)/2)>(b.bottom-b.top)*(hybrid ? .5 : .25)+1e-6)throw Error('Contorno ou centro da cabeça inválidos.');return row;
}
function validateSamples(samples,times,selection,{fps,mediaFps}){
 if(!Array.isArray(samples)||samples.length<2||!Number.isFinite(mediaFps)||mediaFps<=0||!Number.isFinite(fps)||fps<=0)throw Error('Leituras reais do motor ausentes.');
 const frame=t=>Math.round((t-selection.inPoint)*fps),present=new Set(times.map(frame));
 for(let i=0;i<samples.length;i++){
  const s=samples[i];if(!s||![s.time,s.sourceTime].every(Number.isFinite)||!Number.isInteger(s.mediaFrame)||s.mediaFrame<0||!['detected','tracked'].includes(s.source)||s.time<selection.inPoint-1e-7||s.time>=selection.outPoint||s.sourceTime<selection.inPoint-.5/mediaFps-1e-7||s.sourceTime>=selection.outPoint||Math.abs((s.time-selection.inPoint)*fps-frame(s.time))>.01||Math.abs(s.time-s.sourceTime)>.5/fps+1e-7||Math.abs(s.sourceTime*mediaFps-s.mediaFrame)>.51||!present.has(frame(s.time))||(i&&s.time<=samples[i-1].time+1e-8))throw Error('Leitura analisada inválida ou repetida.');
 }
 return samples;
}
function blend(a,b,u,source='gap'){if(!a&&!b)return undefined;if(!a||!b)throw Error('Contorno da cabeça ausente em um extremo da perda.');const out={source};for(const k of ['left','top','right','bottom'])out[k]=a[k]+(b[k]-a[k])*u;return out;}
module.exports={METHOD,SAMPLED_METHOD,LEGACY_METHOD,SHA,isHead,isHybrid,isSampled,reference,sampledReference,validate,validateRow,validateSamples,blend};
