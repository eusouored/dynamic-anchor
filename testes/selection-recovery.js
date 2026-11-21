'use strict';
const assert=require('assert/strict');
const {watchSelection,selectionStamp}=require('../plugin/selection-watch');
let passed=0;
function setup(extra={}){
 let stamp='A',enabled=true,reads=0,probes=0,pulse,stopped=false;
 const jobs=new Map(),events=new Map(),dom=new Map();let id=0;
 const target={addEventListener(n,f){dom.set(n,f);},removeEventListener(n){dom.delete(n);}};
 const ppro={Constants:{SequenceEvent:{SELECTION_CHANGED:'selection',ACTIVATED:'sequence'},ProjectEvent:{ACTIVATED:'project',CLOSED:'closed',DIRTY:'dirty'}},EventManager:{addGlobalEventListener(n,f){events.set(n,f);},removeGlobalEventListener(n){events.delete(n);}}};
 const watcher=watchSelection(ppro,{onChange:async current=>{assert(current());reads++;},onDirty:()=>{},onError:e=>{throw e;},
  schedule:fn=>{jobs.set(++id,fn);return id;},unschedule:n=>jobs.delete(n),repeat:fn=>{pulse=fn;return 1;},stopRepeat:()=>{stopped=true;},
  target,doc:target,canRefresh:()=>enabled,probe:async()=>{probes++;return stamp;},...extra});
 async function drain(){while(jobs.size){const [key,fn]=jobs.entries().next().value;jobs.delete(key);await fn();}}
 return {watcher,events,dom,drain,set stamp(s){stamp=s;},set enabled(v){enabled=v;},get reads(){return reads;},get probes(){return probes;},get stopped(){return stopped;},get jobs(){return jobs.size;},pulse:()=>pulse()};
}
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
(async()=>{
 await test('recovers a selection whose host event was lost',async()=>{const t=setup();await t.drain();await t.watcher.recover();await t.drain();const n=t.reads;t.stamp='B';await t.watcher.recover();await t.drain();assert.equal(t.reads,n+1);t.watcher.dispose();});
 await test('unchanged fingerprint does not reread effects or export frames',async()=>{const t=setup();await t.drain();await t.watcher.recover();await t.drain();const n=t.reads;for(let i=0;i<10;i++)await t.watcher.recover();await t.drain();assert.equal(t.reads,n);t.watcher.dispose();});
 await test('no native probe or refresh while hidden or busy',async()=>{const t=setup();await t.drain();t.enabled=false;const r=t.reads,p=t.probes;t.events.get('selection')();await t.drain();await t.watcher.recover(true);assert.equal(t.reads,r);assert.equal(t.probes,p);t.enabled=true;await t.watcher.recover();await t.drain();assert.equal(t.reads,r+1);t.watcher.dispose();});
 await test('focus recovers a stale panel even with the same selection',async()=>{const t=setup();await t.drain();await t.watcher.recover();await t.drain();const n=t.reads;t.dom.get('focus')();await Promise.resolve();await Promise.resolve();await t.drain();assert.equal(t.reads,n+1);t.watcher.dispose();});
 await test('an incomplete UI selection can retry the same native fingerprint',async()=>{let missing=true;const t=setup({needsRefresh:()=>missing});await t.drain();await t.watcher.recover();await t.drain();const n=t.reads;await t.watcher.recover();await t.drain();assert.equal(t.reads,n+1);missing=false;await t.watcher.recover();await t.drain();assert.equal(t.reads,n+1);t.watcher.dispose();});
 await test('registration failure does not suppress later subscriptions or initial read',async()=>{const t=setup({onError:()=>{}});t.watcher.dispose();let calls=0,initial=0;const jobs=[];const w=watchSelection({Constants:{SequenceEvent:{SELECTION_CHANGED:'bad',ACTIVATED:'good'}},EventManager:{addGlobalEventListener(n){calls++;if(n==='bad')throw Error('unsupported');},removeGlobalEventListener(){}}},{onChange:async()=>{initial++;},onDirty:()=>{},onError:()=>{},schedule:f=>(jobs.push(f),1),unschedule:()=>{},recoveryMs:0,target:null,doc:null});await jobs.shift()();assert.equal(calls,2);assert.equal(initial,1);w.dispose();});
 await test('initial read works without any event support',async()=>{let n=0,fn;const w=watchSelection({}, {onChange:async()=>{n++;},onDirty:()=>{},schedule:f=>(fn=f,1),unschedule:()=>{},recoveryMs:0,target:null,doc:null});await fn();assert.equal(n,1);assert.equal(w.supported,false);w.dispose();});
 await test('dispose removes timer/listeners and ignores a late native result',async()=>{let resolve;const t=setup({probe:()=>new Promise(r=>{resolve=r;})});await t.drain();const n=t.reads;const task=t.watcher.recover();t.watcher.dispose();resolve('B');await task;await t.drain();assert.equal(t.reads,n);assert(t.stopped);assert.equal(t.dom.size,0);assert.equal(t.events.size,0);});
 await test('events during a pending read invalidate it and schedule the latest state',async()=>{let release,current,first=true;const t=setup({onChange:async c=>{current=c;if(first){first=false;await new Promise(r=>{release=r;});}}});const task=t.drain();await Promise.resolve();t.events.get('selection')();assert.equal(current(),false);release();await task;assert.equal(current(),true);t.watcher.dispose();});
 await test('fingerprint distinguishes clip/media/cut and performs no effect reads',async()=>{let media='one',start=1;const item={getName:async()=>'clip',getTrackIndex:async()=>0,getStartTime:async()=>({ticks:String(start)}),getEndTime:async()=>({ticks:'99'}),getInPoint:async()=>({ticks:'0'}),getOutPoint:async()=>({ticks:'98'}),getProjectItem:async()=>({getId:()=>media}),getComponentChain(){throw Error('expensive read');}};const p={Project:{getActiveProject:async()=>({guid:'p',getActiveSequence:async()=>({guid:'s',getSelection:async()=>({getTrackItems:async()=>[{...item}]})})})}};const a=await selectionStamp(p);assert.equal(await selectionStamp(p),a);media='two';assert.notEqual(await selectionStamp(p),a);const b=await selectionStamp(p);start=2;assert.notEqual(await selectionStamp(p),b);});
 console.log(passed+' selection-recovery tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
