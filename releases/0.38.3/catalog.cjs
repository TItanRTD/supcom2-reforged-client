'use strict';
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),assert=require('node:assert/strict');
const {Worker,isMainThread,workerData,parentPort}=require('node:worker_threads');
const {profileSourceDigest,digest,readProfileCatalog}=require('./app/dist/node/desktop/profile-catalog.js');
const native=path.resolve('work-0383/payload/resources/native');
const prior=JSON.parse(z.gunzipSync(fs.readFileSync('work-0383/build/catalog-0382.json.gz')));
const inputs=['ui.scd','toc.win.bdf','ui.scd.enc'].map(name=>fs.readFileSync('orion-base/retail/'+name));
const hud=fs.readFileSync('orion-base/retail/lua.scd');
const art=path.join(native,'lobby/art');
const textures=require(art+'/art-manifest.json').textures.map(t=>({name:'textures/ui/common/pc/frontend/'+t.name,data:fs.readFileSync(path.join(art,t.name))}));
const current=prior.profiles.filter(p=>p.revision==='current'&&!p.superseded);
const compact=p=>({...p,manifest:{format:p.manifest.format,...(p.manifest.hud?{hud:Object.fromEntries(Object.entries(p.manifest.hud).filter(([k])=>k!=='scenes'))}:{})}});
if(!isMainThread){
 const {build}=require(native+'/lobby/indexed-probe.cjs');
 const result=current.filter((_,i)=>i%2===workerData).map(p=>{
  const built=build(...inputs,{layout:true,textures,hud,hudScale:p.scale,legacyReplay:p.legacyReplay,playerBadges:!p.legacyReplay});
  if(!p.legacyReplay)assert.notEqual(digest(built.archive),p.archiveSha256);
  return compact({...p,tocSha256:digest(built.toc),archiveSha256:digest(built.archive),manifest:built.manifest});
 });parentPort.postMessage(result);
}else(async()=>{
 const groups=await Promise.all(Array.from({length:2},(_,workerData)=>new Promise((resolve,reject)=>{
  const w=new Worker(__filename,{workerData});w.once('message',resolve);w.once('error',reject);w.once('exit',n=>{if(n)reject(Error('Profile worker exited '+n));});
 })));
 const profiles=[...groups.flat(),...prior.profiles.map(p=>compact(p.revision==='current'?{...p,revision:'0382',superseded:true}:p))];
 const raw=JSON.stringify({...prior,clientVersion:'0.38.3',source:await profileSourceDigest(native),profiles});
 assert.ok(Buffer.byteLength(raw)<16_000_000);
 const catalogPath=native+'/profile-catalog.json.gz';
 const stagedPath=catalogPath+'.'+process.pid+'.tmp';
 fs.writeFileSync(stagedPath,z.gzipSync(raw,{level:9}));
 fs.renameSync(stagedPath,catalogPath);
 const loaded=await readProfileCatalog(native,inputs,hud);assert.ok(loaded);assert.equal(loaded.profiles.length,prior.profiles.length+current.length);
 for(const p of prior.profiles)assert.ok(loaded.profiles.some(q=>q.tocSha256===p.tocSha256&&q.archiveSha256===p.archiveSha256),'Lost old profile');
 console.log('Retained',prior.profiles.length,'published profiles; generated',current.length,'new profiles;',loaded.profiles.length,'total;',Buffer.byteLength(raw),'expanded bytes');
})().catch(e=>{console.error(e);process.exitCode=1});
