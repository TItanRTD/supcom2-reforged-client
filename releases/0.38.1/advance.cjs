'use strict';
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const root=__dirname,native=root+'/payload/resources/native',hud=native+'/hud',oldHud=root+'/../work-0380/payload/resources/native/hud';
const read=f=>fs.readFileSync(f,'utf8');
const write=(f,v)=>{fs.writeFileSync(f+'.new',v);fs.renameSync(f+'.new',f);};
const edit=(f,a,b)=>{const s=read(f);assert.ok(s.includes(a),f+' missing '+a);write(f,s.replaceAll(a,b));};
const prior=require(hud+'/frozen-v03721.cjs'), changed={};
function freeze(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
        if(/^(frozen-|legacy-|profile-catalog)/.test(entry.name))continue;
        const f=path.join(dir,entry.name),name=path.relative(oldHud,f).split(path.sep).join('/');
        if(entry.isDirectory()){if(name!=='art')freeze(f);continue;}
        if(!/\.(cjs|lua|json|dds|zip|bin)$/.test(name)||['unit-handoff-0379/assets.zip','unit-handoff-03711/materials.zip'].includes(name))continue;
        const bytes=fs.readFileSync(f);let previous;
        try{previous=prior.readInput(name)}catch{}
        if(!previous||!bytes.equals(previous))changed[name]=bytes.toString('base64');
    }
}
freeze(oldHud);
const changes=JSON.stringify(changed);
assert.ok(Buffer.byteLength(changes)<16_000_000);
write(hud+'/frozen-v0380-inputs.json.gz',zlib.gzipSync(changes,{level:9}));
const oldTail="...readSnapshot('frozen-v03721-inputs.json.gz')};";
const freezer=read(hud+'/frozen-v03721.cjs');assert.ok(freezer.includes(oldTail));
write(hud+'/frozen-v0380.cjs',freezer.replace('Exact delivered 0.37.21','Exact delivered 0.38.0').replace(oldTail,"...readSnapshot('frozen-v03721-inputs.json.gz'),...readSnapshot('frozen-v0380-inputs.json.gz')};"));
write(native+'/lobby/indexed-probe-v0380.cjs',read(oldHud+'/../lobby/indexed-probe.cjs')
    .replace("require('../hud/assets.cjs').assets","require('../hud/frozen-v0380.cjs').assets")
    .replace("require('../hud/scenes.cjs').patch","require('../hud/frozen-v0380.cjs').scenes.patch")
    .replace("require('../hud/replay-presentation.cjs').compose","require('../hud/frozen-v0380.cjs').replayPresentation.compose"));
if (process.argv.includes('--freeze-only')) process.exit(0);
for(const f of ['package.json','dist/node/shared/model.js','dist/web/shared/model.js'])edit(root+'/app/'+f,'0.38.0','0.38.1');
const desktop=root+'/app/dist/node/desktop/',lobby=desktop+'native-lobby.js';
edit(desktop+'replay-version.js',"['03721', '03720'","['0380', '03721', '03720'");
edit(desktop+'profile-catalog.js',"['current', '03721'","['current', '0380', '03721'");
edit(lobby,"['current', '03721'","['current', '0380', '03721'");
edit(lobby,"revision==='current'||revision==='03721'","revision==='current'||revision==='0380'||revision==='03721'");
edit(lobby,"revision === 'current' ? builder : revision === '03721'","revision === 'current' ? builder : revision === '0380' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0380.cjs')) : revision === '03721'");
edit(lobby,"presentation === '03721' ?","presentation === '0380' ? require(node_path_1.default.join(assets, 'lobby', 'indexed-probe-v0380.cjs')) : presentation === '03721' ?");
edit(lobby,"presentation = '0380'","presentation = '0381'");
edit(lobby,"legacyReplay, '0380', terrain","legacyReplay, '0381', terrain");
edit(lobby,"'replay-presentation-0380'].includes(previous","'replay-presentation-0380', 'replay-presentation-0381'].includes(previous");
edit(lobby,"|| same(modern('03721', previousScale, false, previousGameplay.research, previousGameplay))","|| same(modern('0380', previousScale, false, previousGameplay.research, previousGameplay))\n            || same(modern('03721', previousScale, false, previousGameplay.research, previousGameplay))");
edit(lobby,"yield modern('03721', n, false);","yield modern('0380', n, false);\n                yield modern('0380', n, true);\n                yield modern('03721', n, false);");
edit(hud+'/replay-presentation.cjs','replay-presentation-0380','replay-presentation-0381');
edit(hud+'/reforged_hud.lua',"local version = '0.38.0'","local version = '0.38.1'");
edit(root+'/payload/resources/deployment/Repair-Discord.ps1','0.38.0','0.38.1');
console.log('Advanced the client and preserved the 0.38.0 replay generator.');
