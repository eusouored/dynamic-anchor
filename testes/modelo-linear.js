'use strict';
// Modelo Linear: se a cópia na pasta de dados foi regravada pelo Premiere, o painel refaz a cópia a partir
// do original conferido (pasta nova) em vez de recusar com "O modelo Linear interno mudou".
const fs=require('fs'),path=require('path'),root=process.env.ANCHOR_TEST_ROOT||path.resolve(__dirname,'../plugin');
const {createNativeLinearTemplate}=require(path.join(root,'native-linear-template.js'));
function pasta(nome,arquivos={}){const p={name:nome,isFolder:true,files:arquivos,
 async getEntry(n){if(n.includes('/')){const [a,...r]=n.split('/');return (await p.getEntry(a)).getEntry(r.join('/'));}const f=p.files[n];if(!f)throw Error('sem '+n);return f;},
 async getEntries(){return Object.values(p.files);},
 async createFolder(n){if(p.files[n])throw Error('já existe');return p.files[n]=pasta(n);},
 async createFile(n){const f=arquivo(n,new Uint8Array());p.files[n]=f;return f;}};return p;}
function arquivo(nome,bytes){return {name:nome,isFolder:false,nativePath:'C:/dados/'+nome,bytes,async read(o){return o&&o.format?this.bytes.buffer.slice(this.bytes.byteOffset,this.bytes.byteOffset+this.bytes.byteLength):Buffer.from(this.bytes).toString();},async write(b){this.bytes=new Uint8Array(b);}};}
const ler=n=>new Uint8Array(fs.readFileSync(path.join(root,'assets/linear-dual',n)));
const plugin=pasta('plugin',{assets:pasta('assets',{'linear-dual':pasta('linear-dual',{'template-info.json':arquivo('template-info.json',new Uint8Array(fs.readFileSync(path.join(root,'assets/linear-dual/template-info.json')))),'reference.png':arquivo('reference.png',ler('reference.png')),'Anchor-linear-template.prproj':arquivo('Anchor-linear-template.prproj',ler('Anchor-linear-template.prproj'))})})});
const manifest=JSON.parse(fs.readFileSync(path.join(root,'assets/linear-dual/template-info.json'),'utf8'));
const base='linear-template-'+manifest.files['Anchor-linear-template.prproj'].slice(0,12);
// cópia antiga regravada pelo Premiere (bytes diferentes)
const data=pasta('dados',{[base]:pasta(base,{'reference.png':arquivo('reference.png',ler('reference.png')),'Anchor-linear-template.prproj':arquivo('Anchor-linear-template.prproj',new Uint8Array([1,2,3]))})});
let abriu=null;
const ppro={Project:{getActiveProject:async()=>({path:'C:/proj/usuario.prproj',getActiveSequence:async()=>null}),open:async p=>{abriu=abriu||p;return {path:p,getSequences:async()=>[]};}},OpenProjectOptions:()=>({}),TickTime:{createWithSeconds:s=>({seconds:s})}};
const uxp={storage:{localFileSystem:{getPluginFolder:async()=>plugin,getDataFolder:async()=>data},formats:{binary:'binary'}}};
(async()=>{
 const load=createNativeLinearTemplate({ppro,uxp});
 try{await load();}catch(e){var msg=e.message;}
 const nova=Object.keys(data.files).find(n=>n!==base);
 const ok=!/interno mudou/.test(msg||'')&&nova&&abriu&&abriu.includes(nova)===false?false:true;
 console.log(JSON.stringify({mensagem:msg,pastas:Object.keys(data.files),copiaNova:nova||null,abriuProjeto:abriu},null,1));
 // esperado: não recusa por "interno mudou"; cria pasta nova conferida; tenta abrir o projeto (a sequência simulada não existe)
 const passou=!/interno mudou/.test(msg||'')&&!!nova&&!!abriu&&/Sequência do modelo Linear não encontrada/.test(msg||'');
 console.log(passou?'ok: cópia regravada pelo Premiere foi refeita e o modelo foi aberto':'FALHA');process.exit(passou?0:1);
})();
