(() => {
 'use strict';
 const startup=require('./startup.js').gate;
 const $=id=>document.getElementById(id),panel=$('bancada'),api=window.AnchorIntegration,G=require('./preview-geometry.js'),H=require('./preview-host.js'),W=require('./selection-watch.js'),PREVIEW_LIMIT_MS=12000,PREVIEW_DELAY_MS=500;
 panel.style.width='100%';panel.style.height='100%';panel.style.marginLeft='0px';panel.style.marginRight='0px';
 // sourcePicked vale para o take em que a origem foi escolhida (pickedFor); a releitura do mesmo take não a desfaz.
 let source=0,sourcePicked=false,pickedFor,format=null,selected=null,frame=null,reading=false,closed=false,epoch=0,lastKey,mode='auto';
 const hide=(id,on)=>$(id).classList.toggle('hidden',!!on),event=(id,type='change')=>$(id).dispatchEvent(new Event(type,{bubbles:true}));
 async function discard(){const previous=frame;frame=null;$('bFirstImage').setAttribute('src','');$('bFirstImage').style.display='none';if(previous)try{await previous.file.delete();}catch(_){} }
 function reflow(){
  const width=panel.clientWidth,height=panel.clientHeight;panel.classList.toggle('narrow',width<360);panel.classList.toggle('low',height<=360);
  const footer=panel.querySelector('footer'),take=$('takeCard'),scroll=$('scroller'),top=take.offsetTop+take.offsetHeight;
  const viewport=Math.max(32,height-top-footer.offsetHeight);scroll.style.top=top+'px';scroll.style.height=viewport+'px';
  if(format){
   const first=G.fit(format.ratio,Math.max(24,$('bFace').clientWidth||width-32),height<=360?Math.max(32,viewport*.35):200,280);
   $('bFirstFrame').style.width=first.width+'px';$('bFirstFrame').style.height=first.height+'px';{const host=$('bFirstFrame').parentElement,free=Math.max(0,(host?host.clientWidth:first.width)-first.width);$('bFirstFrame').style.marginLeft=Math.floor(free/2)+'px';}
  }else{
   $('bFirstFrame').style.width='100%';$('bFirstFrame').style.height='60px';
  }
  // Use a display-only 16:9 frame until the host supplies the sequence format.
  const targetFrame=$('targetFrame');
  const target=G.fit(format?format.ratio:16/9,Math.max(24,panel.querySelector('.target-wrap').clientWidth),height<=360?Math.max(40,viewport*.4):180,480);
  targetFrame.style.width=target.width+'px';targetFrame.style.height=target.height+'px';targetFrame.style.marginLeft='auto';
  for(const [cls,f] of [['safe-action',.05],['safe-title',.10]]){const g=targetFrame.querySelector('.'+cls);if(g){const x=Math.round(target.width*f),y=Math.round(target.height*f);g.style.left=x+'px';g.style.right=x+'px';g.style.top=y+'px';g.style.bottom=y+'px';}}
  const sliderHeight=Math.max(40,target.height-68);
  for(const axis of ['X','Y'])$('offset'+axis).style.height=sliderHeight+'px';
  // Marker and guides share the same painted inner frame.
  const dot=$('targetDot'), bounds=dot.parentElement.getBoundingClientRect();
  dot.style.left=markerAnchor($('offsetX').value,bounds.width);
  dot.style.top=markerAnchor($('offsetY').value,bounds.height);
  for(const axis of ['X','Y'])$('bValue'+axis).textContent=$('offset'+axis).value;
  const chooser=$('faceChooserArea'),imageRatio=Number(chooser.getAttribute('data-image-ratio'));
  if(imageRatio>0&&chooser.clientWidth>0)chooser.style.height=Math.round(chooser.clientWidth/imageRatio)+'px';
 }
 function markerAnchor(offset,extent){
  const percent=50+(Number(offset)||0);
  if(percent===50||extent<=24)return '50%';
  const radiusPercent=100*Math.min(12,extent/4)/extent;
  return Math.max(radiusPercent,Math.min(100-radiusPercent,percent))+'%';
 }
 let speedHold=0;
 function markSpeed(i){for(const item of panel.querySelectorAll('#bSpeed .b-seg-item')){const on=Number(item.getAttribute('data-speed'))===i;item.classList.toggle('selected',on);item.setAttribute('aria-checked',String(on));item.setAttribute('tabindex',on?'0':'-1');}}
 const reviewHidden=()=>source!==0||$('faceDetails').classList.contains('hidden')||!($('faceQuality').textContent||'').trim();
 function sync(){
  const busy=api.busy;for(const id of ['bSource','bZoom','bDestination'])$(id).disabled=busy;$('bSpeed').classList.toggle('disabled',!!busy);
  for(const item of panel.querySelectorAll('#bSpeed .b-seg-item')){const hid=$(['faceSampleNormal','faceSampleFast','faceSampleUltra'][Number(item.getAttribute('data-speed'))]),off=!busy&&!!hid&&hid.disabled;item.classList.toggle('unavailable',off);item.setAttribute('aria-disabled',String(off||!!busy));if(off)item.setAttribute('title','O motor instalado não oferece este modo.');else item.removeAttribute('title');}
  if($('applyLabel').textContent==='Aplicar')$('applyLabel').textContent='Aplicar rastreamento';
  hide('bFace',source!==0);hide('bMask',source===0);hide('bReview',reviewHidden());hide('bBlur',!$('useTransform').checked);panel.querySelector('.b-result').style.display=source===0?'none':'block';panel.querySelector('.b-compose-fold').style.display=source===0?'block':'none';
  const current=['modeAuto','modeFixed','modeNone'].findIndex(id=>$(id).getAttribute('aria-pressed')==='true');mode=['auto','fixed','none'][Math.max(0,current)];$('bZoom').selectedIndex=Math.max(0,current);$('bDestination').selectedIndex=$('useTransform').checked?1:0;
  const speed=['faceSampleNormal','faceSampleFast','faceSampleUltra'].findIndex(id=>$(id).getAttribute('aria-pressed')==='true');if(speed>=0&&Date.now()>speedHold)markSpeed(speed);
  for(const b of panel.querySelectorAll('[data-shutter]')){const on=b.getAttribute('data-shutter')===String($('shutterAngle').value);b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));b.disabled=busy;b.setAttribute('aria-disabled',String(busy));}
  {const none=!format,blocked={offsetX:none||busy||!$('useX').checked,offsetY:none||busy||!$('useY').checked,targetFrame:none||busy,btnResetOffset:none||busy};for(const id of Object.keys(blocked)){$(id).disabled=blocked[id];$(id).setAttribute('aria-disabled',String(blocked[id]));}}
  panel.classList.toggle('no-take',!(selected&&selected.key));
  const choosing=!$('faceChooser').classList.contains('hidden');$('bFirstFrame').classList.toggle('hidden',choosing);
  reflow();
  ddSync();
 }
 $('bSource').addEventListener('change',async()=>{sourcePicked=true;pickedFor=selected?selected.key:undefined;source=$('bSource').selectedIndex;api.selectTrackingSource(source);epoch++;lastKey=undefined;await discard();sync();refresh();});
 for(const item of panel.querySelectorAll('#bSpeed .b-seg-item')){const pick=()=>{if(api.busy)return;const i=Number(item.getAttribute('data-speed'));const id=['faceSampleNormal','faceSampleFast','faceSampleUltra'][i];if(id&&$(id).disabled)return;markSpeed(i);speedHold=Date.now()+1200;if(id)$(id).click();setTimeout(sync,120);};item.addEventListener('click',pick);item.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick();return;}
   // Grupo de opções: setas, Home e End movem a escolha (Rápido e Ultra ficam ao alcance do teclado).
   const items=[...panel.querySelectorAll('#bSpeed .b-seg-item')],at=items.indexOf(item);let to=-1;
   if(e.key==='ArrowRight'||e.key==='ArrowDown')to=(at+1)%items.length;else if(e.key==='ArrowLeft'||e.key==='ArrowUp')to=(at-1+items.length)%items.length;else if(e.key==='Home')to=0;else if(e.key==='End')to=items.length-1;
   if(to>=0){e.preventDefault();if(api.busy)return;items[to].focus();items[to].click();}});}
 $('bZoom').addEventListener('change',()=>{const id=['modeAuto','modeFixed','modeNone'][$('bZoom').selectedIndex];if(id)$(id).click();sync();});
 $('bDestination').addEventListener('change',()=>{$('useTransform').checked=$('bDestination').selectedIndex===1;event('useTransform');sync();});
 for(const b of panel.querySelectorAll('[data-shutter]'))b.addEventListener('click',()=>{if(api.busy)return;$('shutterAngle').value=b.getAttribute('data-shutter');event('shutterAngle');sync();});
 for(const id of ['shutterAngle','offsetX','offsetY','useX','useY','useTransform'])for(const type of ['input','change'])$(id).addEventListener(type,sync);
 $('bAdvancedToggle').addEventListener('click',()=>setTimeout(reflow,40));
 $('btnRefreshSelection').addEventListener('click',()=>{if(!api.busy){lastKey=undefined;refresh();}});
 async function refresh(){
  if(!startup.active||reading||closed||api.busy)return;reading=true;
  try{
   const next=await W.bounded(H.read(require('premierepro')),W.HOST_LIMIT_MS,'O Premiere não informou o take selecionado a tempo.');
   const changedFormat=format&&selected&&String(selected.sequence.guid)===String(next.sequence.guid)&&(format.width!==next.format.width||format.height!==next.format.height||format.pixelAspect!==next.format.pixelAspect);
   format=next.format;selected=next;if(changedFormat&&api.notifySequenceFormat)api.notifySequenceFormat();
   if(next.key!==pickedFor)sourcePicked=false;
   if(next.key!==lastKey){lastKey=next.key;const ticket=++epoch;await discard();$('bFirstMessage').textContent=next.reason||'Lendo o primeiro frame…';sync();
    // 1.7.6: a prévia corre à parte. Quem acompanha a seleção não espera o Premiere exportar o quadro.
    // Espera a seleção assentar e nunca exporta o quadro durante uma análise ou aplicação,
    // para não disputar o Premiere com elas; adiada, a prévia é pedida de novo na próxima leitura.
    if(next.key&&source===0)setTimeout(()=>{if(ticket!==epoch||closed||source!==0)return;if(api.busy||(api.hostStalled&&api.hostStalled())){if(lastKey===next.key)lastKey=undefined;return;}preview(next,ticket);},PREVIEW_DELAY_MS);
   }
   // Origem padrão pelo tipo do trajeto já carregado (máscara abre em Máscara, rosto em Rosto), salvo escolha manual.
   {const kind=api.loadedSourceKind?api.loadedSourceKind():null;if((kind===0||kind===1)&&kind!==source&&!sourcePicked){source=kind;$('bSource').selectedIndex=kind;api.selectTrackingSource(kind);}}
   sync();
  }catch(error){epoch++;lastKey=undefined;selected=null;format=null;await discard();$('bFirstMessage').textContent='Primeiro frame indisponível. '+String(error.message||error);if(!/^Abra um(?: projeto|a sequência) no Premiere\.$/.test(String(error.message||error)))console.warn('[Dynamic Anchor Bancada] preview',error);sync();}
  finally{reading=false;}
 }
 async function preview(next,ticket){
  const current=()=>ticket===epoch&&!closed&&source===0;
  const job=H.capture(require('premierepro'),require('uxp'),next,current);
  try{
   const captured=await W.bounded(job,PREVIEW_LIMIT_MS,'O Premiere não exportou o primeiro frame em '+PREVIEW_LIMIT_MS/1000+' s.');
   if(!current()){await captured.file.delete();return;}frame=captured;$('bFirstImage').setAttribute('src',frame.url);$('bFirstImage').style.display='block';$('bFirstMessage').textContent='';
  }catch(error){
   // Exportação que responde depois do limite: o arquivo atrasado é apagado.
   if(error&&error.code==='host-timeout'){job.then(late=>late.file.delete()).catch(()=>{});if(api.note)api.note('PRÉVIA: '+error.message);}
   // A failed or superseded thumbnail must not erase valid sequence geometry
   // or disable framing controls. The next selected take can still refresh.
   if(!current())return;
   $('bFirstMessage').textContent='Prévia indisponível.';$('bFirstMessage').setAttribute('title',String(error.message||error));
   console.warn('[Dynamic Anchor Bancada] capture',error);
  }
 }
 const theme=name=>{panel.classList.toggle('light',String(name).toLowerCase()==='light');reflow();};try{theme(document.theme.getCurrent());document.theme.onUpdated.addListener(theme);}catch(_){}
 // Borda pintada (teste no Premiere, opção 2): a caixa de fora tem a cor da borda e uma camada interna 1 px menor
 // tem o fundo. O Premiere cortava a metade direita da linha de borda; preenchimento não é cortado.
 function paint(el,kind){if(!el)return;const first=el.firstElementChild;if(el.getAttribute('data-rl-paint')&&first&&first.classList.contains('rl-in')&&el.childNodes.length===1)return;const inner=document.createElement('div');inner.className='rl-in';while(el.firstChild)inner.appendChild(el.firstChild);el.appendChild(inner);el.setAttribute('data-rl-paint',kind);}
 // Ângulos do obturador: mesmo controle segmentado da velocidade (uma caixa, pílula laranja no escolhido)
 (function(){const row=panel.querySelector('#bBlur .b-blur-row');if(!row||$('bShutterSeg'))return;const ps=[...row.querySelectorAll('.b-preset')];if(!ps.length)return;
  const g=document.createElement('div');g.className='b-seg b-shutter-seg';g.id='bShutterSeg';g.setAttribute('role','group');g.setAttribute('aria-label','Ângulo do obturador');row.insertBefore(g,ps[0]);for(const b of ps){b.classList.add('b-seg-item');g.appendChild(b);}})();
 function paintAll(){for(const b of panel.querySelectorAll('.file-button'))if(b.id!=='btnFacePick')paint(b,'button');paint($('bShutterSeg'),'seg');for(const f of panel.querySelectorAll('.number-field'))paint(f,'field');paint($('bSpeed'),'seg');paint($('bFirstFrame'),'frame');paint($('targetFrame'),'frame');paint($('faceChooserArea'),'frame');}

 paint($('btnApply'),'button');paintAll();
 // Seletores desenhados pelo plugin: o sp-dropdown nativo cobria o canto direito da caixa.
 // O nativo continua no DOM (escondido) e recebe a escolha via selectedIndex + evento change.
 const ddBoxes=[];
 function ddLabel(box){const dd=box.querySelector('sp-dropdown'),items=[...dd.querySelectorAll('sp-menu-item')],i=Math.max(0,Number(dd.selectedIndex)||0);return items[i]?items[i].textContent:(dd.getAttribute('placeholder')||'');}
 function ddClose(except){for(const b of ddBoxes)if(b!==except){b.classList.remove('open');b.querySelector('.b-dd-menu').classList.add('hidden');b.querySelector('.b-dd-btn').setAttribute('aria-expanded','false');}}
 for(const box of panel.querySelectorAll('.b-dd')){
  const dd=box.querySelector('sp-dropdown');if(!dd)continue;dd.classList.add('b-dd-native');
  const btn=document.createElement('div');btn.className='b-dd-btn';btn.setAttribute('role','button');btn.setAttribute('tabindex','0');btn.setAttribute('aria-haspopup','listbox');btn.setAttribute('aria-label',dd.getAttribute('aria-label')||'');
  btn.innerHTML='<span class="b-dd-text"></span><img class="b-dd-chev b-dd-chev-dark" src="icons/chevron-dd.png" alt=""><img class="b-dd-chev b-dd-chev-light" src="icons/chevron-dd-light.png" alt="">';
  const menu=document.createElement('div');menu.className='b-dd-menu hidden';menu.setAttribute('role','listbox');const list=document.createElement('div');list.className='b-dd-list';menu.appendChild(list);
  [...dd.querySelectorAll('sp-menu-item')].forEach((it,i)=>{const o=document.createElement('div');o.className='b-dd-option';o.setAttribute('role','option');o.textContent=it.textContent;
   o.setAttribute('tabindex','-1');
   o.addEventListener('click',e=>{e.stopPropagation();if(api.busy||dd.disabled)return;dd.selectedIndex=i;dd.dispatchEvent(new Event('change',{bubbles:true}));ddClose();ddSync();btn.focus();});
   o.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();o.click();}else if(e.key==='Escape'){e.preventDefault();ddClose();btn.focus();}else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const choices=[...list.children],next=(i+(e.key==='ArrowDown'?1:-1)+choices.length)%choices.length;choices[next].focus();}});list.appendChild(o);});
  box.appendChild(btn);box.appendChild(menu);ddBoxes.push(box);
  const placeMenu=()=>{const view=$('scroller').getBoundingClientRect(),anchor=box.getBoundingClientRect(),natural=list.children.length*28+8,below=view.bottom-anchor.bottom-4,above=anchor.top-view.top-4,up=below<natural&&above>below,height=Math.max(28,Math.min(natural,up?above:below));menu.style.top=(up?-height-4:anchor.height+4)+'px';menu.style.maxHeight=height+'px';menu.style.overflowY='auto';};
  const toggle=e=>{if(e)e.stopPropagation();if(dd.disabled||btn.getAttribute('aria-disabled')==='true')return;const opening=!box.classList.contains('open');ddClose(box);if(opening)placeMenu();box.classList.toggle('open',opening);menu.classList.toggle('hidden',!opening);ddSync();};
  btn.addEventListener('click',toggle);btn.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '||e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();toggle();if(box.classList.contains('open'))list.children[Math.max(0,Number(dd.selectedIndex)||0)].focus();}else if(e.key==='Escape')ddClose();});
 }
 function sliderSync(){for(const axis of ['X','Y']){const sl=$('offset'+axis);if(!sl)continue;const track=sl.querySelector('.slider-track'),fill=sl.querySelector('.slider-fill');if(!track||!fill)continue;let low=track.querySelector('.rl-low');if(!low){low=document.createElement('span');low.className='rl-low';track.appendChild(low);}const min=Number(sl.getAttribute('min')),max=Number(sl.getAttribute('max')),pct=(Number(sl.value)-min)/(max-min)*100,v=sl.getAttribute('data-vertical'),pos=Math.round(sl.clientHeight*(v==='up'?100-pct:pct)/100);if(!sl.clientHeight||!Number.isFinite(pos))continue;const thumb=sl.querySelector('.slider-thumb');if(thumb)thumb.style.top=pos+'px';fill.style.height=pos+'px';low.style.top=pos+'px';}}
 // UXP lays out asynchronously. Measuring immediately after clearing width
 // freezes the previous label's width and truncates the next status forever.
 function chipSync(){const c=$('takeChip');if(c&&c.style.width!=='auto')c.style.width='auto';if(c)c.setAttribute('title',c.textContent||'');for(const s of panel.querySelectorAll('.b-dd-text'))s.setAttribute('title',s.textContent||'');}
 function ddSync(){paintAll();sliderSync();chipSync();hide('bReview',reviewHidden());for(const box of ddBoxes){const dd=box.querySelector('sp-dropdown'),btn=box.querySelector('.b-dd-btn'),t=ddLabel(box);const span=btn.querySelector('.b-dd-text');if(span.textContent!==t)span.textContent=t;btn.setAttribute('aria-disabled',String(!!dd.disabled));
  if(dd.disabled||api.busy){box.classList.remove('open');box.querySelector('.b-dd-menu').classList.add('hidden');}
  btn.setAttribute('aria-expanded',String(box.classList.contains('open')));
  const i=Number(dd.selectedIndex)||0;[...box.querySelectorAll('.b-dd-option')].forEach((o,k)=>{o.classList.toggle('selected',k===i);o.setAttribute('aria-selected',String(k===i));});}}
 document.addEventListener('click',()=>ddClose());
 const visible=()=>!closed&&document.hidden!==true&&panel.clientWidth>0&&panel.clientHeight>0;
 const ddTimer=setInterval(()=>{if(startup.active&&visible())ddSync();},300);window.addEventListener('unload',()=>clearInterval(ddTimer));ddSync();
 window.AnchorBancada={sync,reflow,refresh,get format(){return format;},get source(){return source;},get frame(){return frame;}};
 // UI-only maintenance: native selection reads now follow selection events.
 const timer=setInterval(()=>{if(startup.active&&visible())sync();},1500);
 window.addEventListener('resize',reflow);
 window.addEventListener('unload',()=>{closed=true;epoch++;clearInterval(timer);discard();});
 api.selectTrackingSource(source);sync();
 $('bFirstMessage').textContent='Selecione um take e clique neste painel para ativar a leitura.';
 // main.js starts the selection watcher on activation; it also refreshes this preview.
})();
