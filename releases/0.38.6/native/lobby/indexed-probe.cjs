'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ui = require('./supcom2-ui.cjs');
const TOC_HASH = 'cdf78bcf66a88368db4517edf0a1e42b9c55e017f2a3e22b563179f78c3dbe4c';
const ENC_HASH = '175e6f24038ab6033c2ebf17e49a80ffbe3198c677e84cba1b41299365e4b4c5';
const PROBE_NAME = 'supcom2_revival_ui_probe.scd';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function check(ok, message) { if (!ok) throw new Error(message); }
function index(b) {
  const d = ui.readBdf(b), raw = d.raw;
  const u = o => { check(o >= 0 && o + 4 <= raw.length, 'Index pointer out of range'); return raw.readUInt32LE(o); };
  const string = o => {
    check(o < raw.length, 'Index string out of range');
    const end = raw.indexOf(0, o);
    check(end >= o, 'Unterminated index string');
    return raw.subarray(o, end).toString('utf8');
  };
  check(u(0) === 1, 'Unsupported index payload');
  const dirCount = u(4), dirAt = u(8), archiveCount = u(12), archiveAt = u(16);
  const fileCount = u(20), fileAt = u(24);
  check(dirCount < 100000 && archiveCount < 1000 && fileCount < 100000, 'Index count out of range');
  check(fileAt + fileCount * 24 <= raw.length, 'File table out of range');
  const directories = Array.from({length: dirCount}, (_, i) => string(u(dirAt + i * 4)));
  const archives = Array.from({length: archiveCount}, (_, i) => string(u(archiveAt + i * 4)));
  const files = Array.from({length: fileCount}, (_, i) => {
    const at = fileAt + i * 24;
    const words = Array.from({length: 6}, (_, j) => u(at + j * 4));
    const [directory, namePointer, variant, archive, entry, size] = words;
    check(directory < dirCount && (archive < archiveCount || archive === 0xffffffff), 'Bad file record');
    const name = string(namePointer);
    return {i, at, words, directory, name, variant, archive, entry, size,
      logicalPath: [directories[directory], name].filter(Boolean).join('/')};
  });
  const fixupCount = b.readUInt32LE(24);
  check(32 + fixupCount * 4 <= d.offset, 'Fixup table overlaps stream');
  const fixups = Array.from({length: fixupCount}, (_, i) => b.readUInt32LE(32 + i * 4));
  const expected = [8,16,24,
    ...Array.from({length: dirCount}, (_, i) => dirAt + 4 * i),
    ...Array.from({length: archiveCount}, (_, i) => archiveAt + 4 * i),
    ...Array.from({length: fileCount}, (_, i) => fileAt + 24 * i + 4)];
  assert.deepEqual([...fixups].sort((a,b) => a-b), expected.sort((a,b) => a-b),
    'Unknown index pointer-fixup schema');
  return {d, raw, directories, archives, files, fixups, dirAt, archiveAt, fileAt};
}
function normalized(entry) {
  return entry.name.replaceAll('\\', '/').toLowerCase().replace(/\.win\.(bdf|scm|sca|dds)$/, '.$1');
}
function verifyUiMappings(idx, entries, archiveNumber) {
  const records = idx.files.filter(f => f.archive === archiveNumber);
  check(records.length === entries.length, 'UI record count mismatch');
  for (const f of records) {
    const e = entries[f.entry];
    check(e && f.logicalPath.toLowerCase() === normalized(e) && e.data.length === f.size &&
      f.variant === (/\.(bdf|win\.(scm|sca|dds))$/i.test(e.name)?1:0), 'UI mapping mismatch: ' + f.logicalPath);
  }
  return records.length;
}
function writeIndex(original, idx, raw, fixups) {
  // All fields in this baseline's pointer table have been accounted for.
  const header = Buffer.from(original.subarray(0,32));
  header.writeUInt32LE(fixups.length, 24);
  const pointerTable = Buffer.alloc(fixups.length * 4);
  fixups.forEach((v,i) => pointerTable.writeUInt32LE(v,4*i));
  const streamAt = Math.floor((32 + pointerTable.length) / 32 + 1) * 32;
  const comp = zlib.deflateSync(raw, {level: 6});
  header.writeUInt32LE(comp.length, 16); header.writeUInt32LE(raw.length, 20);
  const oldSuffix = Math.ceil((idx.d.offset + idx.d.compressed) / 32) * 32;
  const newSuffix = Math.ceil((streamAt + comp.length) / 32) * 32;
  return Buffer.concat([header, pointerTable,
    Buffer.alloc(streamAt - 32 - pointerTable.length), comp,
    Buffer.alloc(newSuffix - streamAt - comp.length), original.subarray(oldSuffix)]);
}
function compareFiles(a,b) {
  return a.directory - b.directory || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || a.variant - b.variant;
}
function validateCanonical(idx) {
  for (const list of [idx.directories, idx.archives]) {
    check(list.every(n => n === n.toLowerCase()), 'Non-lowercase index path');
    check(list.every((n,i) => !i || list[i-1] < n), 'Unsorted or duplicate index paths');
  }
  check(idx.files.every((f,i) => !i || compareFiles(idx.files[i-1],f) < 0),
    'Unsorted or duplicate file records');
  const loose = new Map(idx.files.filter(f => f.archive === 0xffffffff)
    .map(f => [f.logicalPath.replaceAll('\\','/'),f]));
  for (const archive of idx.archives) {
    const f = loose.get(archive.replaceAll('\\','/'));
    check(f && f.variant === 0 && f.entry === 0, 'Missing physical archive record: ' + archive);
  }
  const expected = [
    ...idx.directories.map((_,i) => idx.dirAt + i*4), 8,
    ...idx.archives.map((_,i) => idx.archiveAt + i*4), 16,
    ...idx.files.map((_,i) => idx.fileAt + i*24 + 4), 24];
  assert.deepEqual(idx.fixups, expected, 'Noncanonical pointer traversal order');
}
const ORIGINAL_TITLE = '<LOC label_title_0008>HOST GAME';
const VISIBLE_TITLE = 'SUPCOM 2 REVIVAL - UI TEST';
function build(sourceUi, sourceToc, sourceEnc, customLobby = false) {
  check(hash(sourceUi) === ui.BASELINE, 'ui.scd does not match the inspected baseline');
  check(hash(sourceToc) === TOC_HASH, 'toc.win.bdf does not match the inspected baseline');
  check(hash(sourceEnc) === ENC_HASH, 'ui.scd.enc does not match the inspected baseline');
  const options=customLobby&&typeof customLobby==='object'?customLobby:{};
  const report=(phase,done,total)=>{if(typeof options.onProgress==='function')options.onProgress(phase,done,total);};
  report('resources');
  const idx = index(sourceToc), entries = ui.readZip(sourceUi);
  validateCanonical(idx);
  const uiArchive = idx.archives.indexOf('gamedata\\ui.scd');
  check(uiArchive >= 0, 'UI archive missing');
  check(verifyUiMappings(idx, entries, uiArchive) === 119, 'Expected 119 UI mappings');
  // Keep registration identical to the successful control; edit only the host title.
  const hudScenes=options.hud?[['pc_frontend_options.win.bdf','options'],['pc_frontend_options_videoadv.win.bdf','optionsadv'],['pc_hud_replay.win.bdf','replay'],['pc_hud.win.bdf','hud'],['pc_hud_selection.win.bdf','selection'],['pc_construction.win.bdf','construction'],['pc_hud_commands.win.bdf','commands'],['pc_hover_box.win.bdf','hover'],['pc_hud_idle_builders.win.bdf','idle'],['pc_ingame_scoreboard.win.bdf','scoreboard'],['pc_research_tree.win.bdf','research'],['pc_research_tip.win.bdf','researchtip'],['pc_hud_tip.win.bdf','hudtip'],['pc_ingame_menu.win.bdf','pause']]:[];
  const scenes = ['pc_frontend_mp_host.win.bdf','pc_frontend_skirmish.win.bdf',...(options.layout?['pc_frontend_mp_exclusions.win.bdf','pc_ingame_dialog.win.bdf']:[]),...hudScenes.map(([name])=>name),...(options.hud&&options.gameplay?.profileId!=='vanilla-1.260-iwbp'?['pc_frontend_custom_ai.win.bdf']:[])];
  const probeEntries = scenes.map(scene => {
    const matches = entries.filter(e => e.name.endsWith(scene));
    check(matches.length === 1, 'Missing/ambiguous scene: ' + scene);
    return matches[0];
  });
  const hostOriginal = probeEntries[0];
  const titlePatch = ui.patchScene(hostOriginal.data, ORIGINAL_TITLE, VISIBLE_TITLE);
  probeEntries[0] = {...hostOriginal, data:titlePatch.data};
  const lobbyPatches = [];
  if (customLobby) {
    // The legacy label pass preserves geometry; the optional layout pass runs below.
    for (const [from,to] of [
      ['<LOC label_title_0028>MULTIPLAYER LOBBY > PUBLIC','SUPREME COMMANDER 2: REFORGED'],
      ['<LOC label_title_player_0000>PLAYER','COMMANDER'],
      ['<LOC label_title_ready_0000>READY','READY'],
      ['<LOC label_launch_0005>LAUNCH','START BATTLE'],
      ['<LOC label_gametype_0002>OPTIONS','BATTLE SETTINGS']
    ]) {
      const patch = ui.patchScene(probeEntries[1].data,from,to);
      probeEntries[1] = {...probeEntries[1],data:patch.data};
      lobbyPatches.push(patch.change);
    }
  }
  let lobbyLayout=null;
  if(options.layout){const layout=require('./scene-layout.cjs').patch(probeEntries[1].data),extended=require('./scene-extend-0329.cjs').extend(layout.data,{playerBadges:options.playerBadges===true});probeEntries[1]={...probeEntries[1],data:require('./lobby-layout-0306.cjs').patch(extended.data)};lobbyLayout={...layout.manifest,mapBrowser:extended.manifest};}
  if(options.layout)probeEntries[2]={...probeEntries[2],data:require('./exclusions.cjs').patch(probeEntries[2].data).data};
  if(options.layout)probeEntries[3]={...probeEntries[3],data:require('./confirmation.cjs').patch(probeEntries[3].data).data};
  const hudPatches=[];
  for(const [name,kind]of hudScenes){const at=probeEntries.findIndex(e=>e.name.endsWith(name)),result=require('../hud/scenes.cjs').patch(probeEntries[at].data,kind,options.hudScale??1);probeEntries[at]={...probeEntries[at],data:result.data};hudPatches.push(result.manifest);}
  if(options.hud&&options.gameplay?.profileId!=='vanilla-1.260-iwbp'){const at=probeEntries.findIndex(e=>e.name.endsWith('pc_frontend_custom_ai.win.bdf'));probeEntries[at]={...probeEntries[at],data:require('../ai/custom-scene-0305.cjs').patch(probeEntries[at].data,1)};}
  const extra=options.textures??[];check(Array.isArray(extra)&&extra.length<=100,'Invalid custom texture list');
  for(const e of extra)check(typeof e.name==='string'&&/^textures\/ui\/common\/pc\/frontend\/[a-z0-9_]+\.dds$/.test(e.name)&&Buffer.isBuffer(e.data)&&e.data.subarray(0,4).toString()==='DDS ','Invalid custom lobby texture');
  probeEntries.push(...extra);
  if(options.playerBadges===true||options.replayPresentation&&!options.legacyReplay)probeEntries.push(...require("./player-badges/assets.cjs").textures(13));
  report('hud');
  let hudAssets=null;
  if(options.research&&options.legacyReplay)throw Error('Original replay playback cannot use published research.');
  if(options.hud){hudAssets=require('../hud/assets.cjs').assets(options.hud,options.hudScale??1,options.research,options.gameplay);if(options.replayPresentation){const revision=options.replaySimulationRevision||'current';let selected=hudAssets;if(!options.legacyReplay&&revision!=='current'){assert.ok(/^[0-9]{4,5}$/.test(revision));const frozen=path.join(__dirname,'../hud/frozen-v'+revision+'.cjs');const provider=fs.existsSync(frozen)?require(frozen):require('../hud/legacy-v'+revision+'/assets.cjs');selected=provider.assets(options.hud,options.hudScale??1,options.research,options.gameplay);}hudAssets=require('../hud/replay-presentation.cjs').compose(hudAssets,selected,require('./supcom2-ui.cjs').readZip(options.hud,2000),{legacy:options.legacyReplay===true||options.gameplay?.profileId==='vanilla-1.260-iwbp'&&selected.manifest.stockOrders!==true,revision});if(options.gameplay?.profileId==='vanilla-1.260-iwbp')require('../hud/gameplay-assets.cjs').keepPalette(hudAssets,selected);}else if(options.legacyReplay)hudAssets=require('../hud/legacy-replay-assets-v0362.cjs').presentationOnly(hudAssets);probeEntries.push(...hudAssets.textures,...hudAssets.overrides,...hudAssets.scripts);}
  if(options.hud&&options.layout){
    const fonts=hudAssets.scripts.find(e=>normalized(e)==='ui/fonts/fonts.lua');
    check(fonts,'The interface is missing frontend font definitions; it was not installed.');
    const front=probeEntries.find(e=>e.name.endsWith('pc_frontend_skirmish.win.bdf'));
    const parsed=require('./scene-layout.cjs').catalog(front.data);
    for(const c of parsed.controls.filter(c=>c.type==='label')){
      const at=parsed.raw.readUInt32LE(c.at+108),alias=parsed.raw.subarray(at,parsed.raw.indexOf(0,at)).toString('ascii');
      if(alias.startsWith('rf_frontend_'))check(fonts.data.includes(Buffer.from('["'+alias+'"]')),'Frontend font alias is undefined: '+alias);
    }
  }
  if(options.replayTerrain){
    check(options.replayPresentation&&Array.isArray(options.replayTerrain)&&options.replayTerrain.length<=1,'Terrain copies are replay presentation only');
    for(const e of options.replayTerrain){check(/^textures\/ui\/common\/pc\/ingame\/hud\/rft_maps_[a-z0-9_]+\.dds$/.test(e.name)&&Buffer.isBuffer(e.data)&&e.data.length<=262272&&e.data.toString('ascii',0,4)==='DDS ','Invalid replay terrain bitmap');probeEntries.push({name:e.name,data:e.data});
      if(e.map){check(/^\/maps\/[a-z0-9_ .()\[\]-]+\/[a-z0-9_ .()\[\]-]+\.scmap$/.test(e.map),'Invalid replay terrain map identity');probeEntries.push({name:'lua/ui/game/reforged_replayterrain.lua',data:Buffer.from('map='+require('../hud/research.cjs').literal(e.map)+'\ntexture='+require('../hud/research.cjs').literal('/'+e.name)+'\n')});}
    }
  }
  report('pack',0,probeEntries.length);
  const archive = ui.writeZip(probeEntries,{compress:!!options.hud,onProgress:(done,total)=>report('pack',done,total)});
  report('verify',0,probeEntries.length);
  assert.deepEqual(ui.readZip(archive,4096,['0379','03711','03712','03714','03715','03716','03717','03718','03721','0382'].includes(options.gameplay?.compiler),(done,total)=>report('verify',done,total)), probeEntries);
  report('index');
  const archivePath = 'gamedata\\' + PROBE_NAME;
  const archives = [...idx.archives, archivePath].sort();
  const newArchiveNumber = archives.indexOf(archivePath);
  const pointers = new Map(idx.archives.map((n,i) => [n, idx.raw.readUInt32LE(idx.archiveAt+i*4)]));
  const archiveString = Buffer.from(archivePath+'\0','ascii');
  const filename = Buffer.from(PROBE_NAME+'\0','ascii');
  const archiveNameAt = idx.raw.length;
  const filenameAt = archiveNameAt + archiveString.length;
  const stockPaths = new Set(idx.files.map(f => f.logicalPath.toLowerCase()));
  const probeByPath = new Map();
  probeEntries.forEach((entry, i) => {
    const name = normalized(entry);
    if (!probeByPath.has(name)) probeByPath.set(name, i);
  });
  const replacements = new Set(hudAssets ? [...hudAssets.scripts, ...hudAssets.overrides].map(normalized) : []);
  const addedEntries=probeEntries.slice(scenes.length).map((e,i)=>({e,entry:i+scenes.length})).filter(({e})=>!stockPaths.has(normalized(e)));
  // Maui bitmaps request variant 0; stock terrain minimaps are indexed only as
  // platform variant 1. Publish UI aliases to the SAME original archive entries.
  // No terrain bytes, map scripts or replay simulation are changed.
  const mapDirectory=idx.directories.indexOf('textures/ui/common/pc/ingame/hud');
  const mapAliases=options.hud?idx.files.filter(f=>f.variant===1&&/^maps\/[^/]+\/[^/]+\.minimap\.dds$/.test(f.logicalPath)).map(f=>({source:f,name:'rfm_'+f.logicalPath.replace(/[^a-z0-9_]/g,'_')+'.dds'})):[];
  check(!mapAliases.length||mapDirectory>=0,'Missing map preview alias directory');
  check(new Set(mapAliases.map(f=>f.name)).size===mapAliases.length,'Conflicting map preview aliases');
  const textureNameBlocks=[...addedEntries.map(({e})=>Buffer.from(normalized(e).split('/').pop()+'\0','ascii')),...mapAliases.map(f=>Buffer.from(f.name+'\0','ascii'))];
  const textureNameAt=filenameAt+filename.length;
  const arrayAt = Math.ceil((textureNameAt+textureNameBlocks.reduce((n,b)=>n+b.length,0))/4)*4;
  const fileAt = Math.ceil((arrayAt+archives.length*4)/4)*4;
  pointers.set(archivePath, archiveNameAt);
  const changed = [];
  const files = idx.files.map(f => {
    const words = [...f.words];
    if (f.archive !== 0xffffffff) words[3] = archives.indexOf(idx.archives[f.archive]);
    const target = f.archive === uiArchive || replacements.has(f.logicalPath) ? (probeByPath.get(f.logicalPath.toLowerCase()) ?? -1) : -1;
    if (target >= 0) {
      words[3] = newArchiveNumber; words[4] = target; words[5] = probeEntries[target].data.length;
      changed.push({logicalPath:f.logicalPath, oldArchive:idx.archives[f.archive], oldEntry:f.entry,
        newArchive:archivePath, newEntry:target, bytesUnchanged:target !== 0 && !customLobby});
    }
    return {...f,words};
  });
  check(changed.length === scenes.length+(options.hud?hudAssets.scripts.filter(e=>stockPaths.has(normalized(e))).length+hudAssets.overrides.length:0), 'Not all scene mappings were redirected');
  const directory = idx.directories.indexOf('gamedata');
  check(directory >= 0, 'gamedata directory missing');
  for(const {e,entry}of addedEntries){
    const logical=normalized(e),slash=logical.lastIndexOf('/'),dir=idx.directories.indexOf(logical.slice(0,slash)),name=logical.slice(slash+1);
    check(dir>=0&&!stockPaths.has(logical),'Custom texture conflicts with a stock file or directory');
    const variant=/\.win\.(bdf|scm|sca|dds)$/i.test(e.name)?1:0;files.push({directory:dir,name,variant,words:[dir,0,variant,newArchiveNumber,entry,e.data.length],newName:true});
  }
  for(const {source,name}of mapAliases)files.push({directory:mapDirectory,name,variant:0,words:[mapDirectory,0,0,archives.indexOf(idx.archives[source.archive]),source.entry,source.size],newName:true});
  files.push({directory,name:PROBE_NAME,variant:0,
    words:[directory,filenameAt,0,0xffffffff,0,archive.length]});
  let newNameAt=textureNameAt;for(const f of files)if(f.newName){f.words[1]=newNameAt;newNameAt+=Buffer.byteLength(f.name)+1;}
  files.sort(compareFiles);
  const raw = Buffer.alloc(Math.ceil((fileAt+files.length*24)/32)*32);
  idx.raw.copy(raw); archiveString.copy(raw,archiveNameAt); filename.copy(raw,filenameAt);let nameAt=textureNameAt;for(const b of textureNameBlocks){b.copy(raw,nameAt);nameAt+=b.length;}
  archives.forEach((n,i) => raw.writeUInt32LE(pointers.get(n),arrayAt+i*4));
  files.forEach((f,i) => f.words.forEach((v,j) => raw.writeUInt32LE(v,fileAt+i*24+j*4)));
  raw.writeUInt32LE(archives.length,12); raw.writeUInt32LE(arrayAt,16);
  raw.writeUInt32LE(files.length,20); raw.writeUInt32LE(fileAt,24);
  const fixups = [
    ...idx.directories.map((_,i) => idx.dirAt+i*4),8,
    ...archives.map((_,i) => arrayAt+i*4),16,
    ...files.map((_,i) => fileAt+i*24+4),24];
  const toc = writeIndex(sourceToc,idx,raw,fixups), rebuilt = index(toc);
  validateCanonical(rebuilt);
  verifyUiMappings(rebuilt,probeEntries,newArchiveNumber);
  assert.deepEqual(rebuilt.directories,idx.directories);
  const key = f => JSON.stringify([f.directory,f.name,f.variant]);
  const rebuiltByKey = new Map(rebuilt.files.map(f => [key(f),f]));
  const changedPaths = new Set(changed.map(f => f.logicalPath));
  for (const f of idx.files) {
    const g = rebuiltByKey.get(key(f));
    check(g, 'Original file lost: '+f.logicalPath);
    if (!changedPaths.has(f.logicalPath)) {
      assert.deepEqual([g.entry,g.size,g.variant], [f.entry,f.size,f.variant]);
      assert.equal(g.archive === 0xffffffff ? null : rebuilt.archives[g.archive],
        f.archive === 0xffffffff ? null : idx.archives[f.archive], 'Archive remap mismatch');
    }
  }
  const physical = rebuiltByKey.get(JSON.stringify([directory,PROBE_NAME,0]));
  assert.equal(physical.size,archive.length);
  assert.deepEqual(rebuilt.raw,raw);
  report('done');
  return {toc,archive,manifest:{
    format:options.layout?'s2r-native-lobby-layout-v1':customLobby?'s2r-native-lobby-v1':'supcom2-revival-visible-title-v0.3',lobbyPatches,lobbyLayout,...(options.hud?{hud:{...hudAssets.manifest,scenes:hudPatches,acceptance:'Windows HUD rendering, input, different resolutions, research rate and assigned faction must be confirmed in a real SupCom 2 match.'}}:{}),
    status:'STATICALLY VALIDATED; NOT WINDOWS/GAME-TESTED',
    experiment:options.layout?'Reforged lobby geometry and supplied faction textures; native events retained, Windows visual acceptance required':customLobby?'First Reforged native lobby labels; original native events and geometry retained':'Host Game title change only; skirmish scene stays byte-identical',
    expectedTitle:VISIBLE_TITLE,titlePatch:titlePatch.change,
    uiSha256:hash(sourceUi),tocSha256:hash(sourceToc),encSha256:hash(sourceEnc),
    newTocSha256:hash(toc),newProbeSha256:hash(archive),
    originalArchives:idx.archives.length,newArchives:archives.length,mapPreviewAliases:mapAliases.length,
    originalFiles:idx.files.length,newFiles:files.length,
    originalFixups:idx.fixups.length,newFixups:fixups.length,
    sortedArchives:true,sortedFiles:true,allArchivesHavePhysicalRecords:true,
    nativeFixupTraversalOrder:true,probeArchiveNumber:newArchiveNumber,
    changedScenes:changed,otherFileMappingsPreserved:true,
    scope:customLobby?'First native lobby branding pass, not a complete lobby redesign or networking replacement':'Visible title loading experiment; does not implement a custom lobby or change networking'
  }};
}
function main(args) {
  check(args.length === 4, 'Usage: node indexed-probe.cjs "ui.scd" "toc.win.bdf" "ui.scd.enc" "new-output-folder"');
  const [uiPath,tocPath,encPath,out] = args.map(p => path.resolve(p));
  check(!fs.existsSync(out), 'Output directory already exists');
  for (const source of [uiPath,tocPath,encPath]) {
    const st = fs.statSync(source); check(st.isFile() && st.size <= 32*1024*1024, 'Invalid input file');
  }
  const result = build(fs.readFileSync(uiPath),fs.readFileSync(tocPath),fs.readFileSync(encPath));
  fs.mkdirSync(path.join(out,'gamedata'),{recursive:true});
  fs.writeFileSync(path.join(out,'toc.win.bdf'),result.toc,{flag:'wx'});
  fs.writeFileSync(path.join(out,'gamedata',PROBE_NAME),result.archive,{flag:'wx'});
  fs.writeFileSync(path.join(out,'indexed-probe-manifest.json'),JSON.stringify(result.manifest,null,2),{flag:'wx'});
  console.log('Built v0.3 visible title test. Expected Host Game title: '+VISIBLE_TITLE);
}
module.exports = {index, build, validateCanonical, compareFiles, verifyUiMappings, TOC_HASH, ENC_HASH, PROBE_NAME, ORIGINAL_TITLE, VISIBLE_TITLE};
if (require.main === module) try {main(process.argv.slice(2));}
catch(e) {console.error('Stopped: '+e.message);process.exitCode=1;}

