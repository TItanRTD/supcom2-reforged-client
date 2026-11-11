'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const previous=require('../work-0381/app/dist/node/server/gameplay.js');
const current=require('./app/dist/node/server/gameplay.js');
const {ResearchWorkshopStore}=require('./app/dist/node/server/research.js');
(async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'reforged-migration-'));
 try{
  const research=new ResearchWorkshopStore(path.join(directory,'research.json'));
  const old=new previous.GameplayStore(directory,research);await old.load();
  const saved=JSON.parse(await fs.readFile(path.join(directory,'gameplay.json'),'utf8'));
  const balance=await old.active('reforged-balance');assert.equal(balance.compiler,'03721');
  saved.ladder={profileId:'reforged-balance',patchId:balance.id};
  await fs.writeFile(path.join(directory,'gameplay.json'),JSON.stringify(saved));
  const next=new current.GameplayStore(directory,research);await next.load();
  assert.equal((await next.active('reforged-balance')).compiler,'0382');
  assert.notEqual((await next.active('reforged-balance')).id,balance.id);
  assert.deepEqual(await next.getPatch(balance.id),balance);
  assert.deepEqual(next.currentLadder().id,balance.id);
  const reloaded=new current.GameplayStore(directory,research);await reloaded.load();
  assert.equal((await reloaded.catalog()).revision,(await next.catalog()).revision);
  assert.equal(reloaded.currentLadder().id,balance.id);
  console.log('New startup compiler published; previous patch bytes, ladder choice and restart identity preserved.');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
