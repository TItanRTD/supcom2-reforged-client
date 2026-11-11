'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const previous=require('../work-0383/app/dist/node/server/gameplay.js');
const current=require('./app/dist/node/server/gameplay.js');
const {ResearchWorkshopStore}=require('./app/dist/node/server/research.js');
const {rulesetFor}=require('./app/dist/node/server/research-publication.js');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reforged-ai-migration-'));
 try{
  const research=new ResearchWorkshopStore(path.join(directory,'research.json'));
  const old=new previous.GameplayStore(directory,research);await old.load();
  const saved=JSON.parse(await fs.readFile(path.join(directory,'gameplay.json'),'utf8'));
  const draft=structuredClone(require('./app/dist/node/server/data/research-retail.json').draft);draft.title='Migration edited tree';draft.nodes.find(n=>n.id==='ULB_RANGE').cost=4;
  const rules=rulesetFor(draft),custom=previous.patchFor('reforged-balance','1.0.2',rules,undefined,'evidence-ai-4');await old.writePatch(custom);
  saved.patches.push({id:custom.id,profileId:custom.profileId,version:custom.version,compiler:custom.compiler,researchId:rules.id});saved.active['reforged-balance']=custom.id;
  const originals=await Promise.all(['vanilla-1.260-iwbp','vanilla-plus'].map(p=>old.active(p)));originals.push(custom);
  saved.ladder={profileId:'reforged-balance',patchId:custom.id};
  await fs.writeFile(path.join(directory,'gameplay.json'),JSON.stringify(saved));
  const next=new current.GameplayStore(directory,research);await next.load();
  for(const before of originals){
   const after=await next.active(before.profileId);assert.equal(after.aiRevision,'evidence-ai-5');assert.notEqual(after.id,before.id);assert.deepEqual(after.research,before.research);
   if(before.profileId==='reforged-balance')assert.equal(after.compiler,'0382');
   assert.deepEqual(await next.getPatch(before.id),before);
  }
  assert.equal(next.currentLadder().id,custom.id);
  const reloaded=new current.GameplayStore(directory,research);await reloaded.load();
  assert.equal((await reloaded.catalog()).revision,(await next.catalog()).revision);assert.equal(reloaded.currentLadder().id,custom.id);
  for(const before of originals)assert.equal((await reloaded.active(before.profileId)).id,(await next.active(before.profileId)).id);
  console.log('All three presets upgraded once to AI5; edited research, historical patches and the pinned ladder survive restart.');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
