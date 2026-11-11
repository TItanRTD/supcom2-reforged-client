'use strict';
const path=require('node:path'),fs=require('node:fs/promises'),os=require('node:os'),assert=require('node:assert/strict');
const app=path.resolve(process.env.PACKAGED_APP||path.join(__dirname,'app'))+'/dist/node/server';
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'s2r-03614-server-'));let server;
 try{
  const {Accounts}=require(app+'/accounts.js'),{MatchHistory,ReplayVault}=require(app+'/community.js'),{MailService}=require(app+'/mail.js'),{AdminGate}=require(app+'/admin.js'),{ReleaseStore}=require(app+'/releases.js');
  server=require(app+'/http.js').makeServer({host:'127.0.0.1',publicOrigin:'https://supcom2reforged.com',accounts:new Accounts(path.join(root,'accounts.json')),history:new MatchHistory(path.join(root,'matches.json')),replays:new ReplayVault(path.join(root,'replays')),mail:new MailService(path.join(root,'mail.json')),admin:new AdminGate(path.join(root,'admin.json')),releases:new ReleaseStore(path.join(root,'updates'))});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const base='http://127.0.0.1:'+server.address().port;
  assert.equal((await(await fetch(base+'/health')).json()).version,'0.38.6');
  assert.equal((await fetch(base+'/changelog')).status,200);assert.equal((await fetch(base+'/support')).status,200);assert.equal((await fetch(base+'/client/assets/support-battlefield.jpg')).status,200);
  const entries=await(await fetch(base+'/api/public/changelog')).json();
  assert.equal(entries[0].version,'0.38.6');assert.ok(entries[0].body.includes('launch timeout'));
  const priorSupport=process.env.S2R_SUPPORT_URL;delete process.env.S2R_SUPPORT_URL;
  assert.equal((await(await fetch(base+'/api/public/support')).json()).url,'https://supcom2reforged.com/support');
  process.env.S2R_SUPPORT_URL='https://example.com/support';assert.equal((await(await fetch(base+'/api/public/support')).json()).url,'https://example.com/support');
  process.env.S2R_SUPPORT_URL='javascript:alert(1)';assert.equal((await(await fetch(base+'/api/public/support')).json()).url,'https://supcom2reforged.com/support');
  if(priorSupport===undefined)delete process.env.S2R_SUPPORT_URL;else process.env.S2R_SUPPORT_URL=priorSupport;
  console.log('Isolated server health, website route and public changelog API passed for 0.38.6');
 }finally{if(server)await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
