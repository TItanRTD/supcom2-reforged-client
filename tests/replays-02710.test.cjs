'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {ReplayFolderStore}=require('../dist/node/desktop/replay-settings');
const {LocalReplays}=require('../dist/node/desktop/replays');
const {prepareReplayPlayback,replayPlayback}=require('../dist/node/desktop/replay-playback');
const {TESTED_EXE_SHA256}=require('../dist/node/desktop/adapter');
async function temp(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'s2r-replays-02710-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;}
const bytes=()=>Buffer.concat([Buffer.from('Replay v1.9\r\n'),Buffer.alloc(128)]);

test('replay folder survives a store restart independently of game/account configuration',async t=>{
 const d=await temp(t),folder=path.join(d,'My replays & recordings'),file=path.join(d,'settings/replay-library.json');await fs.mkdir(folder);
 const store=new ReplayFolderStore(file);assert.equal(await store.load(),null);
 assert.equal(await store.save(folder),await fs.realpath(folder));assert.equal(await new ReplayFolderStore(file).load(),await fs.realpath(folder));
 await fs.rename(folder,folder+' moved');assert.equal(await new ReplayFolderStore(file).load(),folder);
 assert.deepEqual(await fs.readdir(path.dirname(file)),['replay-library.json']);
});
test('invalid folder selections preserve the previous saved preference',async t=>{
 const d=await temp(t),file=path.join(d,'replay-library.json'),store=new ReplayFolderStore(file);await store.save(d);const before=await fs.readFile(file);
 for(const value of [null,'relative',file,path.join(d,'missing')])await assert.rejects(store.save(value));
 assert.deepEqual(await fs.readFile(file),before);
 await fs.writeFile(file,'{"schema":1,"folder":"relative"}');await assert.rejects(store.load(),/saved replay folder/);
});
test('nested original-format recordings are detected by header and extension, with overlapping roots deduplicated',async t=>{
 const d=await temp(t),nested=path.join(d,'Archived/2013');await fs.mkdir(nested,{recursive:true});
 await fs.writeFile(path.join(nested,'old match.sC2RePlAy'),bytes());await fs.writeFile(path.join(d,'fake.SC2Replay'),'invalid contents');await fs.writeFile(path.join(d,'other-game.SCFAReplay'),bytes());
 const local=new LocalReplays(()=>[d,nested]),rows=await local.scan(d);assert.equal(rows.length,1);assert.equal(rows[0].name,'old match.sC2RePlAy');assert.equal(await local.resolve(rows[0].id),path.join(nested,rows[0].name));
});
test('replay scans enforce the 1000-result cap and prioritize the chosen folder',async t=>{
 const d=await temp(t),normal=path.join(d,'default'),chosen=path.join(d,'chosen');await fs.mkdir(normal);await fs.mkdir(chosen);
 await Promise.all(Array.from({length:1002},(_,i)=>fs.writeFile(path.join(normal,i+'.SC2Replay'),bytes())));
 await fs.writeFile(path.join(chosen,'Chosen legacy match.SC2Replay'),bytes());
 const local=new LocalReplays(()=>[normal]),rows=await local.scan(chosen);assert.equal(rows.length,1000);assert.ok(rows.some(r=>r.name==='Chosen legacy match.SC2Replay'));
});
test('a failed scan retains the last successful playable catalog',async t=>{
 const d=await temp(t);await fs.writeFile(path.join(d,'match.SC2Replay'),bytes());
 const local=new LocalReplays(()=>[d]),rows=await local.scan();
 const original=fs.readdir;fs.readdir=async()=>{throw Object.assign(Error('disk read failure'),{code:'EIO'});};
 try{await assert.rejects(local.scan(),/disk read failure/);}finally{fs.readdir=original;}
 assert.equal(await local.resolve(rows[0].id),path.join(d,'match.SC2Replay'));
});
test('legacy replay planning requests Reforged presentation with original simulation data',async t=>{
 const d=await temp(t),game={path:path.join(d,'Game files/bin/SupremeCommander2.exe'),profile:{exeSha256:TESTED_EXE_SHA256,verification:'exe-only'}},replay=path.join(d,'Legacy & saved match.SC2Replay');let preparations=0;
 const result=await prepareReplayPlayback(game,'assets',d,replay,'original',async(...args)=>{preparations++;assert.deepEqual(args,[game.path,'assets',d,undefined,false,true,undefined,true,undefined,false,undefined,true,{replayPresentation:true,replayFile:replay}]);return{candidatePath:path.join(d,'legacy-ui.exe'),gameLog:path.join(d,'game.sclog')};});
 assert.equal(preparations,1);assert.equal(result.executable,path.join(d,'legacy-ui.exe'));assert.deepEqual(result.args,['/log',result.logPath,'/replay',replay]);
});
test('Reforged replay planning retains its prepared executable and rejects unknown playback modes',async t=>{
 const d=await temp(t),game={path:path.join(d,'bin/SupremeCommander2.exe'),profile:{exeSha256:TESTED_EXE_SHA256,verification:'exe-only'}},replay=path.join(d,'match.SC2Replay');let preparations=0;
 const prepare=async(...args)=>{preparations++;assert.deepEqual(args,[game.path,'assets',d,undefined,false,true,undefined,true,undefined,false,undefined,false,{replayPresentation:true,replayFile:replay}]);return{candidatePath:path.join(d,'prepared.exe'),gameLog:path.join(d,'game.sclog')};};
 const result=await prepareReplayPlayback(game,'assets',d,replay,undefined,prepare);assert.equal(result.playback,'reforged');assert.equal(result.executable,path.join(d,'prepared.exe'));assert.equal(preparations,1);
 for(const invalid of [null,'guess','original /extra',{},1])assert.throws(()=>replayPlayback(invalid));
 await assert.rejects(prepareReplayPlayback(game,'assets',d,'relative.SC2Replay','original',prepare));assert.equal(preparations,1);
});
