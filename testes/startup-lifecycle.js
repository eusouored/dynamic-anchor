'use strict';
const assert=require('assert/strict'),{createStartupGate}=require('../plugin/startup'),S=require('../plugin/face-service');
function fixture(){const map=new Map(),doc={addEventListener:(e,f)=>map.set(e,f),removeEventListener:e=>map.delete(e)};const gate=createStartupGate(doc);let calls=0;gate.onActive(()=>calls++);return {gate,map,get calls(){return calls;},fire(name){map.get(name)?.({type:name});}};}
(async()=>{let passed=0;
async function test(name,fn){await fn();passed++;console.log('ok '+name);}
await test('restoring a workspace, hover and focus do not permit native reads',async()=>{const t=fixture();for(const name of ['mouseover','mousemove','mouseenter','focus','visibilitychange','load'])t.fire(name);await Promise.resolve();assert.equal(t.gate.active,false);assert.equal(t.calls,0);t.gate.dispose();});
await test('an explicit click activates once',async()=>{const t=fixture();t.fire('mousedown');await Promise.resolve();assert.equal(t.gate.active,true);assert.equal(t.calls,1);t.fire('mousedown');await Promise.resolve();assert.equal(t.calls,1);assert.equal(t.map.size,0);t.gate.dispose();});
await test('keyboard interaction activates once',async()=>{const t=fixture();t.fire('keydown');await Promise.resolve();assert.equal(t.calls,1);t.gate.dispose();});
await test('closing before an activation callback prevents native work',async()=>{const t=fixture();t.fire('mousedown');t.gate.dispose();await Promise.resolve();assert.equal(t.calls,0);assert.equal(t.gate.active,false);assert.equal(t.map.size,0);});
await test('a later callback does not bypass a disposed gate',async()=>{const t=fixture();t.gate.dispose();t.gate.onActive(()=>{throw Error('late native read');});await Promise.resolve();assert.equal(t.calls,0);});
const base={service:'anchor-rosto',api:1,version:'0.5.2',engine:'face-yunet-v1'};
await test('same-version legacy engine without lifetime protection requires replacement',async()=>{assert.throws(()=>S.checkStatus(base),e=>e.code==='outdated');});
await test('protected same-version engine remains compatible',async()=>{assert.equal(S.checkStatus({...base,features:['premiere-process-lifetime-v1']}).version,'0.5.2');});
console.log(passed+' startup/lifecycle tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
