'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const native=path.resolve(__dirname,'payload/resources/native');
const source=fs.readFileSync(path.resolve(__dirname,'../orion-base/retail/lua.scd'));
const {assets}=require(native+'/hud/assets.cjs');
const {patchFor,verifyPatch}=require('./app/dist/node/server/gameplay.js');
const {rulesetFor}=require('./app/dist/node/server/research-publication.js');
const draft=structuredClone(require('./app/dist/node/server/data/research-retail.json').draft);
draft.title='AI edited-tree regression';draft.nodes.find(n=>n.id==='ULB_RANGE').cost=4;
const fixtures={};
for(const [name,profile,research]of [['stock','vanilla-1.260-iwbp'],['plus','vanilla-plus'],['balance','reforged-balance'],['edited','reforged-balance',rulesetFor(draft)]]){
 const game=patchFor(profile,'1.0.0',research,undefined,'evidence-ai-4');
 assert.deepEqual(verifyPatch(game),game);
 const built=assets(source,1,research,game);
 assert.equal(built.manifest.aiRevision,'evidence-ai-4');
 assert.equal(built.manifest.gameplay.aiRevision,'evidence-ai-4');
 const files=Object.fromEntries(built.scripts.filter(e=>/\.(lua|bp)$/.test(e.name)&&e.data[0]!==27).map(e=>[e.name.toLowerCase(),e.data.toString('utf8')]));
 for(const name of ['controller','effective','operations','tasks','planning'])assert.ok(files['lua/sim/reforged_ai_'+name+'.lua']);
 assert.ok(files['lua/system/reforged_ai_catalog.lua'].includes("Revision='evidence-ai-4'"));
 fixtures[name]={files,game};
 console.log('Assembled',name,game.id.slice(0,12),built.manifest.gameplay.simulationHash);
}
// Old requests remain byte-compatible and do not silently select the new AI.
const previous=require('../work-0382/payload/resources/native/hud/assets.cjs');
for(const profile of ['vanilla-1.260-iwbp','vanilla-plus','reforged-balance']){
 const game=patchFor(profile,'1.0.0');
 const before=previous.assets(source,1,undefined,game),after=assets(source,1,undefined,game);
 assert.equal(after.manifest.gameplay.simulationHash,before.manifest.gameplay.simulationHash);
}
fs.writeFileSync(path.join(__dirname,'build/ai-fixtures.json'),JSON.stringify(fixtures));
console.log('All previous no-AI-revision simulation hashes preserved.');
