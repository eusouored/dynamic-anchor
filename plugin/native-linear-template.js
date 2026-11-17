'use strict';
// A small native project with one artificial still and one Spatial Linear key.
// It stays open in the background; the user's project is never saved here.
function createNativeLinearTemplate({ppro,uxp}){
  const I=require('./integrity.js');let cached=null,loading=null;
  const norm=s=>String(s).replace(/\\/g,'/').replace(/^\/\/\?\//,'').toLowerCase();
  const clean=s=>s.startsWith(String.fromCharCode(92,92,63,92))?s.slice(4):s;
  async function load(){
    if(cached){try{if(await cached.param.isTimeVarying())return cached;}catch(_){}cached=null;}
    const fs=uxp.storage.localFileSystem,plugin=await fs.getPluginFolder(),data=await fs.getDataFolder();
    const manifest=JSON.parse(await(await plugin.getEntry('assets/linear-dual/template-info.json')).read());
    // O modelo do pacote é conferido pelo resumo; a cópia na pasta de dados é só um cache dele.
    // O Premiere pode regravar um projeto que abre (conversão/salvamento automático): uma cópia que
    // não confere é refeita a partir do original conferido, numa pasta nova (a antiga pode estar aberta).
    const sources={};
    for(const name of ['reference.png','Anchor-linear-template.prproj']){
      const binary=await(await plugin.getEntry('assets/linear-dual/'+name)).read({format:uxp.storage.formats.binary});
      if(I.digest(Array.from(new Uint8Array(binary)))!==manifest.files[name])throw Error('O modelo Linear do pacote está alterado. Reinstale o Dynamic Anchor. Nada foi aplicado.');
      sources[name]=binary;
    }
    const base='linear-template-'+manifest.files['Anchor-linear-template.prproj'].slice(0,12);
    const matches=async folder=>{for(const name of Object.keys(sources)){let entry=null;try{entry=await folder.getEntry(name);}catch(_){return false;}
      const bytes=await entry.read({format:uxp.storage.formats.binary});if(I.digest(Array.from(new Uint8Array(bytes)))!==manifest.files[name])return false;}return true;};
    const fresh=async folderName=>{const created=await data.createFolder(folderName);
      for(const [name,binary] of Object.entries(sources))await(await created.createFile(name,{overwrite:true})).write(binary,{format:uxp.storage.formats.binary});return created;};
    let folder=null;
    const candidates=(await data.getEntries()).filter(e=>e&&e.isFolder!==false&&typeof e.name==='string'&&(e.name===base||e.name.startsWith(base+'-'))).sort((a,b)=>a.name.length-b.name.length);
    for(const candidate of candidates){try{if(await matches(candidate)){folder=candidate;break;}}catch(_){}}
    if(!folder){try{folder=await fresh(base);}catch(_){folder=await fresh(base+'-'+Date.now().toString(36));}}
    if(!await matches(folder))throw Error('Não foi possível preparar o modelo Linear na pasta do plugin. Nada foi aplicado.');
    const path=(await folder.getEntry('Anchor-linear-template.prproj')).nativePath;
    const previous=await ppro.Project.getActiveProject();if(!previous)throw Error('Abra o projeto antes de aplicar.');
    const previousPath=previous.path,previousSequence=await previous.getActiveSequence();
    const previousId=previousSequence?String(previousSequence.guid):null;
    const position=previousSequence?Number((await previousSequence.getPlayerPosition()).seconds):null;
    let model=null,result=null;
    try{
      model=await ppro.Project.open(path,ppro.OpenProjectOptions());
      if(!model||norm(model.path)!==norm(path))throw Error('O Premiere não abriu o modelo Linear.');
      const seq=(await model.getSequences()).find(s=>String(s.guid)===manifest.sequenceId);
      if(!seq)throw Error('Sequência do modelo Linear não encontrada.');
      const clips=await(await seq.getVideoTrack(0)).getTrackItems(1,false);
      if(clips.length!==1)throw Error('O modelo Linear deve conter somente a referência artificial.');
      const chain=await clips[0].getComponentChain();let param=null;
      for(let i=0;i<await chain.getComponentCount();i++){const c=await chain.getComponentAtIndex(i);if(await c.getMatchName()==='AE.ADBE Motion')param=await c.getParam(0);}
      if(!param||!await param.isTimeVarying())throw Error('Ponto Linear do modelo indisponível.');
      const times=await param.getKeyframeListAsTickTimes();
      if(!Array.isArray(manifest.keyTimes)||manifest.keyTimes.length!==2||times.length!==2||times.some((t,i)=>Math.abs(Number(t.seconds)-manifest.keyTimes[i])>1e-7))throw Error('Tempos do modelo Linear incompatíveis.');
      result={param,start:manifest.keyTime,starts:manifest.keyTimes,project:model};
    }finally{
      const active=await ppro.Project.getActiveProject();
      // Do not override a third project chosen by the user during async loading.
      if(active&&norm(active.path)===norm(path)){
        const restored=await ppro.Project.open(clean(previousPath),ppro.OpenProjectOptions());
        if(!restored||norm(restored.path)!==norm(previousPath))throw Error('Retorne ao projeto anterior antes de aplicar.');
        if(previousId){const seq=(await restored.getSequences()).find(s=>String(s.guid)===previousId);if(!seq)throw Error('A sequência anterior mudou.');await restored.openSequence(seq);await restored.setActiveSequence(seq);if(Number.isFinite(position))await seq.setPlayerPosition(ppro.TickTime.createWithSeconds(position));}
      }else if(!active||norm(active.path)!==norm(previousPath))throw Error('O projeto ativo mudou. Nada foi aplicado.');
    }
    cached=result;return result;
  }
  return async()=>{if(!loading)loading=load().finally(()=>{loading=null;});return loading;};
}
module.exports={createNativeLinearTemplate};
