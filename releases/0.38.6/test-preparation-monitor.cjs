'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const file=path.join(__dirname,'app/dist/node/desktop/preparation-monitor.js');
let now=0,serial=0;const polls=new Map(),delays=new Map();const m={exports:{}};
const sandbox={module:m,exports:m.exports,require:Module.createRequire(file),__dirname:path.dirname(file),Date:{now:()=>now},setInterval:fn=>{polls.set(++serial,fn);return serial;},clearInterval:id=>polls.delete(id),setTimeout:fn=>{delays.set(++serial,fn);return serial;},clearTimeout:id=>delays.delete(id)};
vm.runInNewContext(fs.readFileSync(file,'utf8'),sandbox,{filename:file});
const {PreparationRunner}=m.exports;
function worker(){const w=new EventEmitter();w.stops=0;w.terminate=async()=>{w.stops++;};return w;}
function advance(ms){now+=ms;for(const fn of[...polls.values()])fn();}
(async()=>{
 let w;const runner=new PreparationRunner(()=>w=worker()),limits={stallMs:90,totalMs:1000,pollMs:1};
 const done=runner.run([],{},limits);await assert.rejects(runner.run([],{},limits),/previous game preparation/);
 for(let i=1;i<=6;i++){now+=30;w.emit('message',{kind:'progress',stage:'preparing-interface-work',detail:'Checking files '+i+'/6'});advance(0);}
 w.emit('message',{kind:'complete',result:{ok:true}});assert.deepEqual(await done,{ok:true});assert.equal(w.stops,1);assert.equal(runner.active,null);
 const silent=runner.run([],{},limits),failed=assert.rejects(silent,/timed out/);advance(91);await failed;assert.equal(w.stops,1);assert.equal(runner.active,null);
 const repeated=runner.run([],{},limits),rejected=assert.rejects(repeated,/timed out/);
 w.emit('message',{kind:'progress',stage:'preparing-interface-work',detail:'Unchanged'});now+=50;w.emit('message',{kind:'progress',stage:'preparing-interface-work',detail:'Unchanged'});advance(41);await rejected;assert.equal(w.stops,1);
 assert.equal(polls.size,0);assert.equal(delays.size,0);
 console.log('Real monitor accepts completed-work progress, rejects silent/duplicate-only progress, terminates timed-out workers and preserves one-writer ownership.');
})().catch(e=>{console.error(e);process.exitCode=1});
