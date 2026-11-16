'use strict';
const T=require('./trajectory.js'),I=require('./integrity.js'),V=require('./video-reference.js');
// Trajetos produzidos fora do painel: protótipo de região (navegador) e motor
// de rosto (motor-rosto/anchor_rosto.py). Nenhum dos dois retima ou converte
// resolução; tudo precisa coincidir com a sequência e com o take selecionado.
function decodeRegion(pkg,selection,format){
  if(pkg.version!==1||!Array.isArray(pkg.rows)||pkg.rows.length<2)throw Error('Trajeto do protótipo inválido.');
  if(!format||pkg.width!==format.width||pkg.height!==format.height||!Number.isFinite(pkg.fps)||Math.abs(pkg.fps-format.fps)>1e-4)throw Error('Resolução ou FPS do protótipo diferente da sequência. Não há conversão automática.');
  const rows=[],times=[];
  for(let i=0;i<pkg.rows.length;i++){
    const r=pkg.rows[i];
    if(!r||![r.time,r.x,r.y,r.width,r.height,r.confidence].every(Number.isFinite)||r.width<=0||r.height<=0||r.confidence<.78||r.confidence>1||r.x<0||r.y<0||r.x>pkg.width||r.y>pkg.height||(i&&Math.abs(r.time-times[i-1]-1/pkg.fps)>.1/pkg.fps))throw Error('O trajeto contém baixa confiança, lacunas ou valores inválidos.');
    if(Number.isFinite(r.decodedTime)&&Math.abs(r.decodedTime-r.time)>.55/pkg.fps)throw Error('O navegador decodificou um quadro fora da tolerância.');
    rows.push({...(r.headBounds?{headBounds:I.clone(r.headBounds)}:{}),...(r.faceTrackingPoint?{faceTrackingPoint:I.clone(r.faceTrackingPoint)}:{}),frame:i,x:r.x,y:r.y,angle:0,width:r.width,height:r.height,area:r.width*r.height,confidence:r.confidence});times.push(r.time);
  }
  return finish({name:'Região — motor experimental',type:'external-region',rows,times,pkg,selection,evidence:{fileName:String(pkg.fileName||''),engine:'region-ncc-v1',timing:'browser-seek'}});
}
const FACE_MIN_CONFIDENCE=.5;
function decodeFace(pkg,selection,format,segmentRows=null){
  if(![1,2].includes(pkg.version)||pkg.engine!=='face-yunet-v1'||!Array.isArray(pkg.rows)||pkg.rows.length<2)throw Error('Trajeto do motor de rosto inválido ou de versão incompatível.');
  const video15=V.isVideo15(pkg.trackingReference);
  let videoData=null;
  if(video15){try{videoData=V.validatePackage(pkg,selection,format);}catch(error){throw Error('Trajeto video15 inválido: '+error.message);}}
  else if(pkg.referenceCoverage!==undefined)throw Error('Cobertura de referência video15 sem o método video15 correspondente.');
  if(pkg.version===1&&(pkg.trackingReference!==undefined||pkg.rows.some(r=>r&&r.trackingPoint!==undefined)))throw Error('A referência facial exige a versão 2 do trajeto.');
  if(pkg.version===2&&(!pkg.trackingReference||!pkg.rows.every(r=>r&&r.trackingPoint)))throw Error('Referência facial incompleta.');
  // O motor responde no quadro do vídeo: igual à sequência, ou format.sourceWidth×sourceHeight quando as proporções diferem.
  const expectedW=format&&(format.sourceWidth||format.width),expectedH=format&&(format.sourceHeight||format.height);
  if(!format||pkg.width!==expectedW||pkg.height!==expectedH||!Number.isFinite(pkg.fps)||Math.abs(pkg.fps-format.fps)>1e-4)throw Error('Resolução ou FPS do trajeto diferente da sequência. Gere um novo pedido para este take.');
  if(pkg.selection){
    let same=false;try{same=I.canonical(T.identity(pkg.selection))===I.canonical(T.identity(selection));}catch(error){same=false;}
    if(!same)throw Error('Este trajeto foi gerado para outro take ou corte. Gere um novo pedido com o take atual selecionado.');
  }else if(!Number.isFinite(pkg.inPoint)||Math.abs(pkg.inPoint-selection.inPoint)>.5/pkg.fps)throw Error('A entrada informada ao motor não coincide com a entrada deste take.');
  const sourceRows=segmentRows||pkg.rows;
  if(video15&&segmentRows&&!([pkg.rows,...pkg.segments.filter(s=>!s.primary).map(s=>s.rows)].some(run=>I.canonical(run)===I.canonical(segmentRows))))throw Error('Trecho video15 não pertence ao resultado validado.');
  const rows=[],times=[],step=1/pkg.fps;
  for(let i=0;i<sourceRows.length;i++){
    const r=sourceRows[i];
    if(require('./adaptive-reference.js').isAdaptive(pkg.trackingReference)){require('./adaptive-reference.js').validate(pkg.trackingReference);require('./adaptive-reference.js').validateRow(r,pkg.trackingReference);}
    if(!r||![r.time,r.x,r.y,r.width,r.height,r.confidence].every(Number.isFinite)||r.width<=0||r.height<=0||r.confidence<FACE_MIN_CONFIDENCE||r.confidence>1||r.x<0||r.y<0||r.x>pkg.width||r.y>pkg.height)
      throw Error('O trajeto do rosto contém baixa confiança ou valores inválidos (linha '+(i+1)+').');
    const k=(r.time-selection.inPoint)/step;
    if(Math.abs(k-Math.round(k))>.01||(i&&Math.abs(r.time-times[i-1]-step)>.01*step))throw Error('O trajeto do rosto não está na grade de quadros da sequência ou tem lacunas.');
    rows.push({...(r.headBounds?{headBounds:I.clone(r.headBounds)}:{}),...(r.faceTrackingPoint?{faceTrackingPoint:I.clone(r.faceTrackingPoint)}:{}),frame:i,x:r.x,y:r.y,angle:0,width:r.width,height:r.height,area:r.width*r.height,confidence:r.confidence,interpolated:r.source==='interpolated',...(pkg.version===2?{trackingPoint:{x:r.trackingPoint.x,y:r.trackingPoint.y}}:{}),...(video15?{source:r.source==='sampled'?'sampled':'detected'}:require('./adaptive-reference.js').isAdaptive(pkg.trackingReference)?{source:r.source}:{})});times.push(r.time);
  }
  const stats=pkg.stats&&typeof pkg.stats==='object'?pkg.stats:{};
  return finish({frame:format,name:'Rosto — motor experimental',type:'external-face',rows,times,pkg,selection,evidence:{fileName:String(pkg.fileName||''),engine:'face-yunet-v1',engineVersion:String(pkg.engineVersion||''),
    analysisSource:pkg.analysisSource==='proxy'?'proxy':'original',timing:'decoder-pts',interpolatedRows:rows.filter(r=>r.interpolated).length,sampledRows:rows.filter(r=>r.source==='sampled').length,segments:Number.isInteger(stats.segments)?stats.segments:null},referenceCoverage:videoData&&sourceRows===pkg.rows?videoData.coverage:undefined});
}
function decodeFaceSegment(pkg,rows,selection,format){return decodeFace(pkg,selection,format,rows);}
function finish({frame,name,type,rows,times,pkg,selection,evidence,referenceCoverage}){
  // W×H = sequência (quadro de saída); SW×SH = quadro do vídeo, só quando difere (proporções diferentes).
  const sourceDiffers=!!frame&&(pkg.width!==frame.width||pkg.height!==frame.height);
  const d={name,type,rotationSupported:false,selection,W:sourceDiffers?frame.width:pkg.width,H:sourceDiffers?frame.height:pkg.height,...(sourceDiffers?{SW:pkg.width,SH:pkg.height}:{}),fps:pkg.fps,rows,times,firstTrackedTime:times[0],lastTrackedTime:times[times.length-1],coveredStart:times[0],coveredEnd:times[times.length-1]+1/pkg.fps,
    partial:times[0]>selection.inPoint+.5/pkg.fps||times[times.length-1]<selection.outPoint-1.5/pkg.fps,externalEvidence:evidence,...(pkg.trackingReference?{trackingReference:I.clone(pkg.trackingReference)}:{}),...(referenceCoverage?{referenceCoverage:I.clone(referenceCoverage)}:{})};
  if(require('./head-reference.js').isSampled(pkg.trackingReference)){d.mediaFps=pkg.mediaFps;d.analysisSamples=I.clone((pkg.analysisSamples||[]).filter(s=>s.time>=times[0]-1e-7&&s.time<=times[times.length-1]+1e-7));}
  T.validate(d);return d;
}
function kind(text){
  let pkg;try{pkg=JSON.parse(text);}catch(error){throw Error('Arquivo JSON inválido.');}
  if(pkg&&pkg.format==='anchor-region-prototype')return 'region';
  if(pkg&&pkg.format==='anchor-face-track')return 'face';
  throw Error('Escolha o JSON do motor de rosto ou do protótipo de região.');
}
function decode(text,selection,format,{confirmed=false}={}){
  if(!confirmed)throw Error('Confirme que o vídeo e o intervalo correspondem ao take selecionado.');
  const pkg=JSON.parse(text);
  if(pkg.format==='anchor-region-prototype')return decodeRegion(pkg,selection,format);
  if(pkg.format==='anchor-face-track')return decodeFace(pkg,selection,format);
  throw Error('Trajeto do protótipo inválido.');
}
module.exports={decode,decodeFaceSegment,kind,FACE_MIN_CONFIDENCE};
