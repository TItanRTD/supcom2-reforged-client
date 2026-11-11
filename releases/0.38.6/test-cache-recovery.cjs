'use strict';
// Exercise the real old/new recognition control flow with deterministic builders.
// Each simulated reconstruction costs 31 s; no real busy wait or game is used.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),crypto=require('node:crypto');
const {patchFor}=require('./app/dist/node/server/gameplay.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const PROBE='supcom2_revival_ui_probe.scd';
const currentGame=patchFor('reforged-balance','1.0.0',undefined,undefined,'evidence-ai-6');
const oldGame=patchFor('reforged-balance','1.0.0',undefined,undefined,'evidence-ai-5');
function output(revision,options){
 const o=options&&typeof options==='object'?options:{};
 const key=revision+'|'+(o.gameplay?.id??'')+'|'+(o.hudScale??1);
 return{toc:Buffer.from('toc:'+key),archive:Buffer.from('archive:'+key),manifest:{hud:{scale:o.hudScale??1,gameplay:o.gameplay&&{patchId:o.gameplay.id,aiRevision:o.gameplay.aiRevision}}}};
}
async function fixture(root,version){
 const assets=path.join(root,'assets'),game=path.join(root,'game'),state=path.join(game,'revival-prepared/reforged-lobby-v1');
 await fs.mkdir(path.join(game,'gamedata'),{recursive:true});await fs.mkdir(state,{recursive:true});await fs.mkdir(path.join(assets,'lobby/art'),{recursive:true});
 const lua=Buffer.from('fixture lua');await fs.writeFile(path.join(game,'gamedata/lua.scd'),lua);
 for(const name of ['gamedata/ui.scd','gamedata/ui.scd.enc','toc.original.win.bdf'])await fs.writeFile(path.join(game,name),'fixture source');
 const textures=[];for(let i=0;i<90;i++){const name='rf'+i+'.dds',data=Buffer.alloc(20);data.write('DDS ');data.writeUInt32LE(1,12);data.writeUInt32LE(1,16);await fs.writeFile(path.join(assets,'lobby/art',name),data);textures.push({name,sha256:hash(data),width:1,height:1});}
 await fs.writeFile(path.join(assets,'lobby/art/art-manifest.json'),JSON.stringify({format:'s2r-lobby-art-v1',textures}));
 const control=output('control',false);await fs.writeFile(path.join(state,'control-toc.win.bdf'),control.toc);await fs.writeFile(path.join(state,'control-probe.scd'),control.archive);
 let now=0,last=0,maxQuiet=0;const calls=[],events=[];
 const progress=(stage,detail)=>{maxQuiet=Math.max(maxQuiet,now-last);last=now;events.push({stage,detail,at:now});};
 const builder=revision=>({PROBE_NAME:PROBE,build:(_ui,_toc,_enc,options)=>{
  calls.push(options===false?'control':revision);now+=31000;maxQuiet=Math.max(maxQuiet,now-last);
  if(now-last>90000)throw Object.assign(Error('Simulated 90-second no-progress timeout'),{code:'SIMULATED_STALL'});
  if(typeof options?.onProgress==='function')options.onProgress('pack',1,1);
  return output(options===false?'control':revision,options);
 }});
 const source=path.resolve(version==='old'?'work-0385/app/dist/node/desktop/native-lobby.js':'work-0386/app/dist/node/desktop/native-lobby.js');
 const m=new Module(source,module),ordinary=Module.createRequire(source);m.filename=source;
 m.require=request=>{
  if(request==='./profile-catalog')return{readProfileCatalog:async()=>version==='no-catalog'?null:({source:'f'.repeat(64),profiles:[{revision:'control',tocSha256:hash(control.toc),archiveSha256:hash(control.archive),manifest:{}}]})};
  if(request===path.join(assets,'hud/assets.cjs'))return{LUA_HASH:hash(lua)};
  if(request===path.join(assets,'lobby/indexed-probe.cjs'))return builder('current');
  if(request.startsWith(path.join(assets,'lobby/indexed-probe-v')))return builder(path.basename(request).slice('indexed-probe-v'.length,-4));
  return ordinary(request);
 };
 m._compile(await fs.readFile(source,'utf8'),source);
 const put=async(pair,gameplay)=>{await fs.writeFile(path.join(game,'toc.win.bdf'),pair.toc);await fs.writeFile(path.join(game,'gamedata',PROBE),pair.archive);await fs.writeFile(path.join(state,'lobby-manifest.json'),JSON.stringify({hud:{scale:1.125,gameplay:{patchId:gameplay.id}}}));await fs.writeFile(path.join(state,'published-gameplay.json'),JSON.stringify(gameplay));};
 const bytes=async()=>Promise.all([fs.readFile(path.join(game,'toc.win.bdf')),fs.readFile(path.join(game,'gamedata',PROBE))]);
 return{game,assets,state,put,bytes,calls,events,quiet:()=>maxQuiet,run:expected=>m.exports.prepareLobbyAssets(game,assets,true,true,1.125,false,progress,undefined,expected,true,undefined,false,undefined,currentGame)};
}
(async()=>{
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'reforged-cache-regression-'));
 try{
  const unknown={toc:Buffer.from('unrecognized toc'),archive:Buffer.from('unrecognized prepared archive')};
  const before=await fixture(path.join(base,'before'),'old');await before.put(unknown,oldGame);
  await assert.rejects(before.run(),e=>e.code==='SIMULATED_STALL');assert.ok(before.calls.length>=3);assert.ok(before.quiet()>90000);
  console.log('Reproduced old saved-gameplay reconstruction chain exceeding the 90-second no-progress window.');
  const after=await fixture(path.join(base,'after'),'new');await after.put(unknown,oldGame);const original=await after.bytes();
  await assert.rejects(after.run(),e=>e.code==='S2R_INTERFACE_UNKNOWN');assert.deepEqual(after.calls,['current']);assert.deepEqual(await after.bytes(),original);assert.ok(after.events.some(e=>e.stage==='preparing-reset-interface'));
  console.log('Unknown saved interface now requests clean recovery after one current check, with original bytes preserved.');
  const healthy=await fixture(path.join(base,'healthy'),'new');await healthy.put(output('current',{gameplay:currentGame,hudScale:1.125}),currentGame);
  const result=await healthy.run();assert.deepEqual(healthy.calls,['current']);assert.ok(result.cache);
  const count=healthy.calls.length;await healthy.run(result.cache);assert.equal(healthy.calls.length,count);
  assert.ok(healthy.events.some(e=>e.stage==='preparing-interface-work'));assert.ok(healthy.quiet()<=31000);
  console.log('Current interface verifies with one build; returned warm proof reuses it without rebuilding.');
  const badBackup=await fixture(path.join(base,'bad-backup'),'new');await badBackup.put(output('current',{gameplay:currentGame,hudScale:1.125}),currentGame);await fs.writeFile(path.join(badBackup.state,'control-probe.scd'),'changed backup');
  await assert.rejects(badBackup.run(),/restore backup differs/);assert.equal(await fs.readFile(path.join(badBackup.state,'control-probe.scd'),'utf8'),'changed backup');
  console.log('Changed restore backups remain protected.');
  const noCatalog=await fixture(path.join(base,'no-catalog'),'no-catalog');await noCatalog.put(output('control',false),oldGame);
  await noCatalog.run();assert.equal(noCatalog.calls.filter(v=>v==='current').length,1);assert.ok(!noCatalog.calls.some(v=>/^0/.test(v)));
  console.log('Verified control baseline still works when the optional catalog is unavailable.');
 }finally{await fs.rm(base,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
