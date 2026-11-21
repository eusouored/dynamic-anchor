'use strict';
const assert=require('assert/strict'),H=require('../plugin/head-reference');
const times=[0,1/30,2/30],selection={inPoint:0,outPoint:.1},options={fps:30,mediaFps:60};
const read=(time,mediaFrame,gap=false)=>({time,mediaFrame,sourceTime:mediaFrame/60,source:gap?'tracked':'detected',...(gap?{method:'bidirectional-csrt-head-gap-v1'}:{})});
const raw=[read(0,0),read(1/30,1,true),read(1/30,2,true),read(2/30,4)];let n=0;
function test(name,fn){fn();n++;console.log('ok '+name);}
test('real gap reads at 60 fps mapping to 30 fps produce unique evidence',()=>{const out=H.normalizeSamples(raw,times,selection,options);assert.equal(out.length,3);assert.equal(out[1].mediaFrame,2);H.validateSamples(out,times,selection,options);assert.equal(raw.length,4);});
test('strict validator still refuses duplicate sequence instants',()=>assert.throws(()=>H.validateSamples(raw,times,selection,options)));
test('identical source reads cannot be hidden by normalization',()=>assert.throws(()=>H.normalizeSamples([raw[0],raw[1],{...raw[1]},raw[3]],times,selection,options)));
test('duplicates outside the known gap recovery remain rejected',()=>assert.throws(()=>H.normalizeSamples(raw.map(s=>{const r={...s};delete r.method;return r;}),times,selection,options)));
test('an invalid discarded read remains rejected',()=>assert.throws(()=>H.normalizeSamples(raw.map((s,i)=>i===1?{...s,sourceTime:.3}:s),times,selection,options)));
test('unordered evidence remains rejected',()=>assert.throws(()=>H.normalizeSamples([raw[0],raw[3],raw[1]],times,selection,options)));
test('fewer than two unique measured frames remains rejected',()=>assert.throws(()=>H.normalizeSamples(raw.slice(1,3),times,selection,options)));
test('already valid evidence keeps its values',()=>{const valid=[raw[0],raw[2],raw[3]];assert.deepEqual(H.normalizeSamples(valid,times,selection,options),valid);});
console.log(n+' head-sample tests passed');
