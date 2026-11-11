'use strict';
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),assert=require('node:assert/strict');
const root=__dirname,native=root+'/payload/resources/native',hud=native+'/hud',oldHud=root+'/../work-0385/payload/resources/native/hud';
const read=f=>fs.readFileSync(f,'utf8');
const write=(f,v)=>{fs.writeFileSync(f+'.new',v);fs.renameSync(f+'.new',f);};
const edit=(f,a,b)=>{const s=read(f);assert.ok(s.includes(a),f+' missing '+a);write(f,s.replaceAll(a,b));};
const prior=require(hud+'/frozen-v0384.cjs'),changed={};
function freeze(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
 if(/^(frozen-|legacy-|profile-catalog)/.test(entry.name))continue;
 const f=path.join(dir,entry.name),name=path.relative(oldHud,f).split(path.sep).join('/');
 if(entry.isDirectory()){if(name!=='art')freeze(f);continue;}
 if(!/\.(cjs|lua|json|dds|zip|bin)$/.test(name)||['unit-handoff-0379/assets.zip','unit-handoff-03711/materials.zip'].includes(name))continue;
 const bytes=fs.readFileSync(f);let previous;try{previous=prior.readInput(name)}catch{}
 if(!previous||!bytes.equals(previous))changed[name]=bytes.toString('base64');
}}
freeze(oldHud);
write(hud+'/frozen-v0385-inputs.json.gz',z.gzipSync(JSON.stringify(changed),{level:9}));
const tail="...readSnapshot('frozen-v0384-inputs.json.gz')};",freezer=read(hud+'/frozen-v0384.cjs');
assert.ok(freezer.includes(tail));
write(hud+'/frozen-v0385.cjs',freezer.replace('Exact delivered 0.38.1','Exact delivered 0.38.5').replace(tail,"...readSnapshot('frozen-v0384-inputs.json.gz'),...readSnapshot('frozen-v0385-inputs.json.gz')};"));
write(native+'/lobby/indexed-probe-v0385.cjs',read(oldHud+'/../lobby/indexed-probe.cjs')
 .replace("require('../hud/assets.cjs').assets","require('../hud/frozen-v0385.cjs').assets")
 .replace("require('../hud/scenes.cjs').patch","require('../hud/frozen-v0385.cjs').scenes.patch")
 .replace("require('../hud/replay-presentation.cjs').compose","require('../hud/frozen-v0385.cjs').replayPresentation.compose"));
for(const f of ['package.json','dist/node/shared/model.js','dist/web/shared/model.js'])edit(root+'/app/'+f,'0.38.5','0.38.6');
const desktop=root+'/app/dist/node/desktop/',lobby=desktop+'native-lobby.js';
edit(desktop+'replay-version.js',"['0384',","['0385', '0384',");
edit(desktop+'profile-catalog.js',"['current', '0384'","['current', '0385', '0384'");
edit(lobby,"['current', '0384'","['current', '0385', '0384'");
edit(lobby,"revision==='current'||revision==='0384'","revision==='current'||revision==='0385'||revision==='0384'");
edit(lobby,"revision === 'current' ? builder : revision === '0384'","revision === 'current' ? builder : revision === '0385' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0385.cjs')) : revision === '0384'");
edit(lobby,"presentation === '0384' ?","presentation === '0385' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0385.cjs')) : presentation === '0384' ?");
edit(lobby,"presentation = '0385'","presentation = '0386'");
edit(lobby,"legacyReplay, '0385', terrain","legacyReplay, '0386', terrain");
edit(lobby,"'replay-presentation-0385'].includes(previous","'replay-presentation-0385', 'replay-presentation-0386'].includes(previous");
edit(lobby,"|| same(modern('0384', previousScale, false, previousGameplay.research, previousGameplay))","|| same(modern('0385', previousScale, false, previousGameplay.research, previousGameplay))\n            || same(modern('0384', previousScale, false, previousGameplay.research, previousGameplay))");
edit(lobby,"yield modern('0384', n, false);","yield modern('0385', n, false);\n                yield modern('0385', n, true);\n                yield modern('0384', n, false);");
edit(hud+'/replay-presentation.cjs','replay-presentation-0385','replay-presentation-0386');
edit(hud+'/reforged_hud.lua',"local version = '0.38.5'","local version = '0.38.6'");
edit(root+'/payload/resources/deployment/Repair-Discord.ps1','0.38.5','0.38.6');
console.log('Advanced client and preserved the 0.38.5 generator.');
