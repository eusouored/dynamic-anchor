'use strict';
function describeMovement({quality={},smooth=0,tremor=false,rotation=false}={}){
  const parts=[],amount=Number(String(smooth).replace(',','.'));
  if(quality.filter==='adaptive')parts.push('suavização adaptativa');
  if(quality.filter==='outliers')parts.push('atenuar oscilações isoladas');
  if(tremor){parts.push('redução de tremor (experimental)');if(rotation&&amount>0)parts.push('suavização da rotação '+amount+'%');}
  else if(amount>0)parts.push('suavização geral '+amount+'%');
  if(!parts.length)parts.push('sem suavização adicional');
  if(quality.center==='area')parts.push('centro do polígono');
  return parts.join(' · ');
}
function describePhase(message){
  const phases={'conferir-existente':'Conferindo efeito existente…','aplicar-movimento':'Aplicando movimento…','conferir-resultado':'Conferindo resultado…'};
  const match=/^ETAPA_UI:\s*([a-z-]+)\s*$/.exec(String(message));
  return match&&phases[match[1]]||null;
}
// Explicit DOM controls avoid the host's native HTML button skin.
function initializeUI(document){
  const buttons=[...document.querySelectorAll('[role="button"]')],checks=[...document.querySelectorAll('[role="checkbox"]')],sliders=[...document.querySelectorAll('[role="slider"]')];
  const numbers=[...document.querySelectorAll('.number-field')];
  const controls=[...buttons,...checks,...sliders];
  const attribute=(element,name,value)=>{if(element.getAttribute(name)!==value)element.setAttribute(name,value);};
  const emit=(element,name)=>element.dispatchEvent(new Event(name,{bubbles:true}));
  const taskIds=['track','frame','tools'];
  // 0.9.45: a página única não tem abas; o código das abas fica para painéis antigos e para os testes do ui.
  const tabIds=new Set(taskIds.map(id=>'nav'+id.charAt(0).toUpperCase()+id.slice(1)));
  const taskTabs=[...(document.querySelectorAll?document.querySelectorAll('.task-tab'):[])].filter(tab=>tabIds.has(tab.id)).sort((a,b)=>[...tabIds].indexOf(a.id)-[...tabIds].indexOf(b.id));
  const taskPanes=taskIds.map(id=>document.getElementById('task'+id.charAt(0).toUpperCase()+id.slice(1))).filter(Boolean);
  let activeTask='track';
  // 0.9.45: página única. Sem abas, as seções ficam sempre visíveis e "ir para" só rola até a seção.
  const scrollTo=element=>{try{if(element&&typeof element.scrollIntoView==='function')element.scrollIntoView({block:'start'});}catch(_){}};
  function selectTask(id,{focus=true,announce=true}={}){
    if(!taskIds.includes(id))return false;
    const changed=activeTask!==id;
    activeTask=id;
    if(!taskTabs.length){
      if(changed)scrollTo(taskPanes.find(pane=>pane.id==='task'+id.charAt(0).toUpperCase()+id.slice(1)));
      if(announce&&changed&&typeof document.dispatchEvent==='function'){try{const event=new Event('anchor-task-change',{bubbles:true});event.detail={id};document.dispatchEvent(event);}catch(_){}}
      return true;
    }
    for(const tab of taskTabs){const selected=tab.id==='nav'+id.charAt(0).toUpperCase()+id.slice(1);attribute(tab,'aria-selected',String(selected));tab.setAttribute('tabindex',selected?'0':'-1');}
    for(const pane of taskPanes){const selected=pane.id==='task'+id.charAt(0).toUpperCase()+id.slice(1);pane.className=pane.className.replace(/\s*hidden\b/g,'').trim()+(selected?'':' hidden');attribute(pane,'aria-hidden',String(!selected));}
    if(focus){const tab=taskTabs.find(item=>item.getAttribute('aria-selected')==='true');if(tab&&typeof tab.focus==='function')tab.focus();}
    if(announce&&changed&&typeof document.dispatchEvent==='function'){
      try{const event=new Event('anchor-task-change',{bubbles:true});event.detail={id};document.dispatchEvent(event);}catch(_){}
    }
    return true;
  }
  function revealTaskFor(id){
    const target=document.getElementById(String(id||''));if(!target)return false;
    const path=[];let node=target,pane=null;
    while(node&&node!==document.body){
      path.push(node);
      if(node.getAttribute&&node.getAttribute('role')==='tabpanel'||taskPanes.includes(node)){pane=node;break;}
      node=node.parentNode;
    }
    if(!pane)return false;
    const task=taskIds.find(id=>pane.id==='task'+id.charAt(0).toUpperCase()+id.slice(1));
    if(!task)return false;
    if(taskTabs.length)selectTask(task);else activeTask=task;
    const toggles=[...document.querySelectorAll('.fold-toggle,.advanced-button')];
    for(const ancestor of path){
      const toggle=toggles.find(item=>item.getAttribute('aria-controls')===ancestor.id);
      if(toggle&&ancestor.className&&String(ancestor.className).split(/\s+/).includes('hidden')){
        attribute(toggle,'aria-expanded','true');
        ancestor.className=String(ancestor.className).replace(/\s*hidden\b/g,'').trim();
        const arrow=toggle.querySelector('.chevron');if(arrow)arrow.setAttribute('src','icons/chevron-down.svg');
      }
    }
    if(target.className&&String(target.className).split(/\s+/).includes('hidden'))target.className=String(target.className).replace(/\s*hidden\b/g,'').trim();
    if(!taskTabs.length){
      scrollTo(target);
      // Notify the operation runner even within the same section: otherwise
      // its finally block restores the old scroll and hides the chooser again.
      if(typeof document.dispatchEvent==='function'){try{const event=new Event('anchor-task-change',{bubbles:true});event.detail={id:task};document.dispatchEvent(event);}catch(_){}}
    }
    return true;
  }
  for(const tab of taskTabs){
    tab.addEventListener('click',()=>selectTask(tab.id==='navTrack'?'track':tab.id==='navFrame'?'frame':'tools',{focus:true}));
    tab.addEventListener('keydown',event=>{
      const i=taskTabs.indexOf(tab);let next=null;
      if(event.key==='ArrowRight'||event.key==='ArrowDown')next=taskTabs[(i+1)%taskTabs.length];
      else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=taskTabs[(i+taskTabs.length-1)%taskTabs.length];
      else if(event.key==='Home')next=taskTabs[0];else if(event.key==='End')next=taskTabs[taskTabs.length-1];
      if(next){event.preventDefault();selectTask(next.id==='navTrack'?'track':next.id==='navFrame'?'frame':'tools',{focus:true});}
      else if(event.key==='Enter'||event.key===' '){event.preventDefault();selectTask(tab.id==='navTrack'?'track':tab.id==='navFrame'?'frame':'tools',{focus:true});}
    });
  }
  const sync=()=>{
    for(const element of controls)attribute(element,'aria-disabled',String(!!element.disabled));
    for(const element of checks){attribute(element,'aria-checked',String(!!element.checked));const visual=element.querySelector('.check-visual');if(visual)visual.textContent=element.checked?'✓':'';}
    for(const element of sliders){
      const value=Number(element.value),min=Number(element.getAttribute('min')),max=Number(element.getAttribute('max')),percent=(value-min)/(max-min)*100;
      attribute(element,'aria-valuenow',String(value));
      const vertical=element.getAttribute('data-vertical'),pct=vertical==='up'?100-percent:percent;
      const position=vertical?Math.round((element.clientHeight||92)*pct/100)+'px':element.clientWidth?Math.round(element.clientWidth*percent/100)+'px':percent+'%';
      const thumb=element.querySelector('.slider-thumb'),fill=element.querySelector('.slider-fill');
      if(vertical){thumb.style.top=position;fill.style.height=position;}else{if(thumb.style.left!==position)thumb.style.left=position;if(fill.style.width!==position)fill.style.width=position;}
      if(element.disabled)element.setAttribute('tabindex','-1');else element.setAttribute('tabindex','0');
    }
    for(const wrapper of numbers){const field=wrapper.querySelector('sp-textfield'),display=wrapper.querySelector('.number-display');if(display.textContent!==field.value)display.textContent=field.value;attribute(wrapper,'aria-disabled',String(!!field.disabled));}
  };
  for(const element of [...buttons,...checks,...sliders])element.disabled=element.hasAttribute('disabled');
  for(const button of buttons){
    button.addEventListener('click',event=>{if(button.disabled)event.stopImmediatePropagation();});
    button.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!button.disabled)button.click();}});
  }
  for(const toggle of document.querySelectorAll('.fold-toggle')){
    const content=document.getElementById(toggle.getAttribute('aria-controls'));
    toggle.addEventListener('click',()=>{
      if(toggle.disabled||!content)return;
      const open=toggle.getAttribute('aria-expanded')!=='true';
      toggle.setAttribute('aria-expanded',String(open));
      content.className='fold-body'+(open?'':' hidden');
      const arrow=toggle.querySelector('.chevron');
      if(arrow)arrow.setAttribute('src',open?'icons/chevron-down.svg':'icons/chevron-right.svg');
    });
  }
  for(const element of checks){
    element.checked=element.hasAttribute('checked');
    const toggle=()=>{if(element.disabled)return;element.checked=!element.checked;sync();emit(element,'change');};
    element.addEventListener('click',toggle);
    element.addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();toggle();}});
  }
  let active=null;
  const finishDrag=()=>{if(active){const element=active.element;active=null;emit(element,'change');}};
  for(const element of sliders){
    element.value=element.getAttribute('value')||'0';
    const min=Number(element.getAttribute('min')),max=Number(element.getAttribute('max'));
    element.setAttribute('aria-valuemin',String(min));element.setAttribute('aria-valuemax',String(max));
    const set=value=>{element.value=String(Math.max(min,Math.min(max,Math.round(value))));sync();emit(element,'input');};
    const move=event=>{if(element.disabled)return;const rect=element.getBoundingClientRect(),vertical=element.getAttribute('data-vertical');if(vertical&&rect.height>0&&Number.isFinite(event.clientY)){const t=(event.clientY-rect.top)/rect.height;set(min+(vertical==='up'?1-t:t)*(max-min));}else if(rect.width>0&&Number.isFinite(event.clientX))set(min+(event.clientX-rect.left)/rect.width*(max-min));};
    element.addEventListener('mousedown',event=>{if(element.disabled)return;event.preventDefault();if(typeof element.focus==='function')element.focus();active={element,move};move(event);});
    element.addEventListener('click',event=>{if(!element.disabled){move(event);emit(element,'change');}});
    element.addEventListener('keydown',event=>{
      if(element.disabled)return;const vertical=element.getAttribute('data-vertical'),direction=vertical?{ArrowUp:vertical==='down'?-1:1,ArrowDown:vertical==='down'?1:-1,PageUp:vertical==='down'?-10:10,PageDown:vertical==='down'?10:-10}[event.key]:{ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1}[event.key];
      if(direction){event.preventDefault();set(Number(element.value)+direction*(event.shiftKey?10:1));emit(element,'change');}
      else if(event.key==='Home'||event.key==='End'){event.preventDefault();set(element.getAttribute('data-vertical')==='down'?(event.key==='Home'?max:min):(event.key==='Home'?min:max));emit(element,'change');}
    });
  }
  document.addEventListener('mousemove',event=>{if(event.buttons===0)finishDrag();else if(active)active.move(event);});
  document.addEventListener('mouseup',finishDrag);
  document.addEventListener('mouseleave',finishDrag);
  if(typeof window!=='undefined'&&window.addEventListener)window.addEventListener('blur',finishDrag);
  for(const wrapper of numbers){
    const field=wrapper.querySelector('sp-textfield');
    const editing=on=>{wrapper.className=String(wrapper.className).replace(/\s*\bediting\b/g,'').trim()+(on?' editing':'');};
    const edit=()=>{if(field.disabled)return;editing(true);field.focus();};
    wrapper.addEventListener('click',edit);
    wrapper.addEventListener('keydown',event=>{if(event.target===wrapper&&(event.key==='Enter'||event.key===' ')){event.preventDefault();edit();}});
    field.addEventListener('input',sync);
    field.addEventListener('blur',()=>{editing(false);sync();});
    field.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key==='Escape'){event.preventDefault();editing(false);wrapper.focus();sync();}});
  }
  if(taskTabs.length)selectTask('track',{announce:false,focus:false});
  sync();return {sync,describeMovement,describePhase,selectTask,revealTaskFor,get activeTask(){return activeTask;}};
}
module.exports={initializeUI,describeMovement,describePhase};
