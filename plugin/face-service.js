'use strict';
// Cliente do serviço local do motor de rosto (motor-rosto/anchor_servico.py).
// O UXP não inicia processos com argumentos nem lê sua saída; o motor roda como
// serviço HTTP só em 127.0.0.1 e o painel conversa com ele por fetch.
const PORT=47833,BASE='http://127.0.0.1:'+PORT,API=1,ENGINE='face-yunet-v1',MIN_VERSION='0.5.3';
const E=require('./face-errors.js');
// Fábrica (não subclasse de Error): no UXP, subclasses de Error podem perder
// a mensagem. Funciona com e sem "new".
function ServiceError(message,code){const error=new Error(String(message));error.name='ServiceError';error.code=code;error.isServiceError=true;return error;}
function compareVersion(a,b){
  const pa=String(a||'0').split('.').map(n=>parseInt(n,10)||0),pb=String(b||'0').split('.').map(n=>parseInt(n,10)||0);
  for(let i=0;i<Math.max(pa.length,pb.length);i++){const d=(pa[i]||0)-(pb[i]||0);if(d)return d<0?-1:1;}
  return 0;
}
function createClient({fetchImpl=typeof fetch==='function'?(...args)=>fetch(...args):null,base=BASE,fallbackBases=base===BASE?['http://localhost:'+PORT]:[],timeoutMs=5000}={}){
  // Endereço em uso. Se o Premiere bloquear 127.0.0.1 por permissão, tenta o
  // mesmo motor por localhost (também só este computador) e guarda o que funcionou.
  const bases=[base,...fallbackBases];let active=0;
  async function request(path,options={}){
    let lastError=null;
    for(let i=active;i<bases.length;i++){
      try{const data=await requestAt(bases[i],path,options);active=i;return data;}
      catch(error){lastError=error;if(!(error&&error.code==='permission'))throw error;}
    }
    throw lastError;
  }
  async function requestAt(base,path,{method='GET',body,timeout=timeoutMs}={}){
    if(!fetchImpl)throw new ServiceError('Este Premiere não oferece rede ao painel.','offline');
    let controller=null;try{controller=typeof AbortController==='function'?new AbortController():null;}catch(_){controller=null;}let timer=null;
    const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new ServiceError('O motor de rosto não respondeu a tempo.','timeout'));if(controller)try{controller.abort();}catch(_){}},timeout);});
    try{
      let response;
      try{
        const init={method,headers:{'Content-Type':'application/json'}};
        if(body!==undefined)init.body=JSON.stringify(body);
        if(controller)init.signal=controller.signal;
        response=await Promise.race([fetchImpl(base+path,init),expired]);
      }catch(error){
        if(error&&error.isServiceError)throw error;
        const detail=E.describe(error);
        // Bloqueio do próprio Premiere (permissão de rede do manifesto): ligar o
        // motor ou reinstalar não resolve; não confundir com motor desligado.
        if(/permission denied|manifest entry not found/i.test(detail))throw new ServiceError('O Premiere bloqueou a conexão do painel com o motor de rosto. Feche o painel Dynamic Anchor e abra de novo (ou reinicie o Premiere). Se continuar, mande o registro de diagnóstico para o suporte.','permission');
        throw new ServiceError('Motor de rosto desligado ou inacessível ('+detail+').','offline');
      }
      if(!response||typeof response.json!=='function')throw new ServiceError('Resposta inválida do motor de rosto ('+E.describe(response)+').','http');
      // A resposta só terminou depois do corpo. O resultado de um take longo
      // pode chegar após os cabeçalhos; esse período também precisa de prazo.
      let data=null;try{data=await Promise.race([response.json(),expired]);}catch(error){if(error&&error.isServiceError)throw error;data=null;}
      if(!response.ok)throw new ServiceError((data&&data.error)||('O motor de rosto respondeu '+response.status+'.'),response.status===409?'busy':response.status===403?'forbidden':'http');
      if(!data||typeof data!=='object')throw new ServiceError('Resposta inválida do motor de rosto.','http');
      return data;
    }finally{clearTimeout(timer);}
  }
  return {
    base,
    get activeBase(){return bases[active];},
    status:()=>request('/v1/status',{timeout:2500}),
    start:(job,options)=>request('/v1/analises',{method:'POST',body:{job,options:options||{}}}),
    task:id=>request('/v1/analises/'+encodeURIComponent(id)),
    cancel:id=>request('/v1/analises/'+encodeURIComponent(id)+'/cancelar',{method:'POST',body:{}}),
    shutdown:()=>request('/v1/encerrar',{method:'POST',body:{}}),
    faces:(job,options)=>request('/v1/rostos',{method:'POST',body:{job,options:options||{}},timeout:30000}),
    diagnostics:()=>request('/v1/diagnostico',{timeout:5000}),
  };
}
function supportsReference(status,reference){
  if(reference!=='video15')return true;
  return !!status&&Array.isArray(status.references)&&status.references.includes('video15');
}
function checkStatus(status,reference){
  if(!status||status.service!=='anchor-rosto'||status.api!==API||status.engine!==ENGINE)
    throw new ServiceError('Outro programa está usando a porta '+PORT+' do motor de rosto.','incompatible');
  if(compareVersion(status.version,MIN_VERSION)<0)throw new ServiceError('Motor de rosto '+status.version+' desatualizado; é necessário '+MIN_VERSION+' ou mais novo.','outdated');
  if(!Array.isArray(status.features)||!status.features.includes('premiere-process-lifetime-v1'))throw new ServiceError('Este motor não tem a proteção de encerramento com o Premiere. Atualize o painel e o motor juntos.','outdated');
  if(!supportsReference(status,reference))throw new ServiceError('Este motor não tem o método de análise necessário. Clique em Preparar motor para atualizá-lo e tente de novo.','unsupported-reference');
  return status;
}
module.exports={createClient,checkStatus,supportsReference,compareVersion,ServiceError,PORT,MIN_VERSION};
