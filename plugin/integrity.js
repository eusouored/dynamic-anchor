'use strict';
// Portable SHA-256. No Node crypto dependency in the UXP runtime.
function sha256(input){
  const bytes=unescape(encodeURIComponent(input)),words=[],bitLength=bytes.length*8;
  for(let i=0;i<bytes.length;i++)words[i>>2]=(words[i>>2]||0)|(bytes.charCodeAt(i)<<(24-(i%4)*8));
  words[bytes.length>>2]=(words[bytes.length>>2]||0)|(0x80<<(24-(bytes.length%4)*8));
  const end=(((bytes.length+8)>>6)+1)*16;words[end-2]=Math.floor(bitLength/0x100000000);words[end-1]=bitLength|0;
  let h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const k=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const r=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let off=0;off<end;off+=16){
    const w=[];for(let i=0;i<64;i++){if(i<16)w[i]=words[off+i]|0;else{const a=w[i-15],b=w[i-2];w[i]=(w[i-16]+(r(a,7)^r(a,18)^(a>>>3))+w[i-7]+(r(b,17)^r(b,19)^(b>>>10)))|0;}}
    let [a,b,c,d,e,f,g,z]=h;
    for(let i=0;i<64;i++){const t=(z+(r(e,6)^r(e,11)^r(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0,u=((r(a,2)^r(a,13)^r(a,22))+((a&b)^(a&c)^(b&c)))|0;z=g;g=f;f=e;e=(d+t)|0;d=c;c=b;b=a;a=(t+u)|0;}
    h=h.map((v,i)=>(v+[a,b,c,d,e,f,g,z][i])|0);
  }
  return h.map(v=>(v>>>0).toString(16).padStart(8,'0')).join('');
}
function canonical(value,depth=0,parents=new Set()){
  if(depth>64)throw Error('Estrutura de dados excessivamente profunda.');
  if(value===null)return 'null';
  if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Número inválido nos dados.');return JSON.stringify(value);}
  if(typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(value&&typeof value==='object'){
    if(parents.has(value))throw Error('Estrutura de dados cíclica.');parents.add(value);
    try{if(Array.isArray(value))return '['+value.map(v=>canonical(v,depth+1,parents)).join(',')+']';
      return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k],depth+1,parents)).join(',')+'}';
    }finally{parents.delete(value);}
  }
  throw Error('Tipo de dado não suportado.');
}
const digest=value=>sha256(canonical(value));
const clone=value=>JSON.parse(canonical(value));
module.exports={sha256,canonical,digest,clone};
