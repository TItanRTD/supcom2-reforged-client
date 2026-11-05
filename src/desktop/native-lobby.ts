import {collectReplayTerrain,replayTerrainMap,terrainMap,type ReplayTerrain} from './replay-terrain';
import {validateReplayRevision,type ReplayRevision} from './replay-version';
import {verifyRuleset,type ResearchRuleset} from '../server/research-publication';
import {readFile,writeFile,rename,rm,mkdir,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {readProfileCatalog} from './profile-catalog';
export interface LobbyProfileCache{source:string;replayPresentation?:boolean;revision?:ReplayRevision;custom:boolean;modernHud:boolean;scale:number;legacyReplay:boolean;researchId:string;terrainSha?:string;profile:{custom:boolean;tocSha256:string;archiveSha256:string;hud?:any}}
let cached:{key:string;variants:Map<string,any>}|null=null;
// Match the native ZIP reader; reject unsupported output before writing it.
const MAX_INTERFACE_ARCHIVE=96*1024*1024,MAX_INTERFACE_TOC=16*1024*1024;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function ordinary(p:string){if((await lstat(p)).isSymbolicLink())throw Error('Lobby assets must not be symbolic links.');}
async function atomic(p:string,bytes:Buffer|string){const temp=p+'.'+randomUUID()+'.tmp';try{await writeFile(temp,bytes,{flag:'wx'});await rename(temp,p);}finally{await rm(temp,{force:true});}}
/** Writes only the two existing probe assets in the explicitly selected test copy.
 * A fixed journal supports recovery between the two individual atomic renames. */
export async function prepareLobbyAssets(root:string,assets:string,custom:boolean,modernHud=false,hudScale=1,legacyReplay=false,progress:(stage:string,detail?:string)=>unknown=()=>{},research?:ResearchRuleset,expected?:LobbyProfileCache,recoverUnknown=false,replayTarget?:ReplayRevision,replayPresentation=false,replayFile?:string){
 const targetRevision=validateReplayRevision(replayTarget);
 if(replayPresentation&&(!custom||!modernHud))throw Error('Replay presentation requires the modern isolated interface.');
 if(targetRevision!=='current'&&(!custom||!modernHud||legacyReplay))throw Error('Historical simulation requires Reforged replay mode.');
 if(research){research=verifyRuleset(research);if(legacyReplay||!custom||!modernHud)throw Error('Research changes require a Reforged custom game.');}
 if(legacyReplay&&(!custom||!modernHud))throw Error('Legacy replay UI requires the modern presentation profile.');
 if(!Number.isFinite(hudScale)||hudScale<0.75||hudScale>2.5||Math.round(hudScale*8)!==hudScale*8)throw Error('Invalid HUD scale.');
 root=await realpath(root);
 if(root.toLowerCase().split(path.sep).includes('steamapps'))throw Error('Custom lobby tests require the separate game copy.');
 const data=path.join(root,'gamedata');await ordinary(data);
 const sourcePaths=[path.join(data,'ui.scd'),path.join(root,'toc.original.win.bdf'),path.join(data,'ui.scd.enc')];
 for(const p of sourcePaths)await ordinary(p);
 progress('preparing-read-interface-inputs');
 const inputs=await Promise.all(sourcePaths.map(p=>readFile(p)));
 const luaPath=path.join(data,'lua.scd');let hudLua:Buffer|undefined;
 if(modernHud){await ordinary(luaPath);hudLua=await readFile(luaPath);if(hash(hudLua)!==require(path.join(assets,'hud','assets.cjs')).LUA_HASH)throw Error('The game Lua archive differs from the inspected SupCom 2 baseline; HUD assets were not changed.');}
 const terrain=replayPresentation&&replayFile?await collectReplayTerrain(root,await replayTerrainMap(replayFile),progress):undefined;
 const builder=require(path.join(assets,'lobby','indexed-probe.cjs'));
 const artRoot=path.join(assets,'lobby','art');
 const manifest=JSON.parse(await readFile(path.join(artRoot,'art-manifest.json'),'utf8'));
 if(manifest.format!=='s2r-lobby-art-v1'||!Array.isArray(manifest.textures)||manifest.textures.length!==90)throw Error('The packaged lobby artwork manifest is invalid.');
 const textures=await Promise.all(manifest.textures.map(async(t:{name:string;sha256:string;width:number;height:number})=>{
  if(!/^rf[a-z0-9_]*\.dds$/.test(t.name))throw Error('Invalid packaged lobby texture name.');
  const bytes=await readFile(path.join(artRoot,t.name));
  if(hash(bytes)!==t.sha256||bytes.toString('ascii',0,4)!=='DDS '||bytes.readUInt32LE(12)!==t.height||bytes.readUInt32LE(16)!==t.width)throw Error('Packaged lobby artwork is missing or changed: '+t.name);
  return {name:'textures/ui/common/pc/frontend/'+t.name,data:bytes};
 }));
 const key=[path.resolve(assets),...inputs.map(hash),...textures.map(t=>hash(t.data)),hudLua?hash(hudLua):'',terrain?terrain.name+':'+terrain.sha256:''].join(':');
 if(!cached||cached.key!==key)cached={key,variants:new Map()};
 const cache=cached.variants;
 const build=(id:string,options:any,b=builder)=>{if(!cache.has(id)){const result=b.build(...inputs,options);if(cache.size>=4)cache.delete(cache.keys().next().value!);cache.set(id,result);}return cache.get(id);};
 const control=()=>build('control',false);
 const modern=(revision:string,scale:number,readOnlyProfile=legacyReplay,rules:ResearchRuleset|undefined=revision===targetRevision&&!readOnlyProfile?research:undefined)=>build('hud-'+revision+'-'+scale+(readOnlyProfile?'-legacy-replay':'')+(rules?'-research-'+rules.id:''),{layout:true,textures,hud:hudLua,hudScale:scale,...(rules?{research:rules}:{}),...(readOnlyProfile&&['current','0335','0334','0333','0332','0331','0327','0326','0325','0324','0323','0322','0321','0320','0313','0312','0311','0310','0306','0305','0304','0301','0300','0292','0291','0290','0282','0280','02733','02732','02731','02730','02729','02728','02727','02726','02725','02723','02722','02721','02720','02719','02711'].includes(revision)?{legacyReplay:true}:{})},revision==='current'?builder:revision==='0335'?require(path.join(assets,'lobby','indexed-probe-v0335.cjs')):revision==='0334'?require(path.join(assets,'lobby','indexed-probe-v0334.cjs')):revision==='0333'?require(path.join(assets,'lobby','indexed-probe-v0333.cjs')):revision==='0332'?require(path.join(assets,'lobby','indexed-probe-v0332.cjs')):revision==='0331'?require(path.join(assets,'lobby','indexed-probe-v0331.cjs')):revision==='0329'?require(path.join(assets,'lobby','indexed-probe-v0329.cjs')):revision==='0328'?require(path.join(assets,'lobby','indexed-probe-v0328.cjs')):revision==='0327'?require(path.join(assets,'lobby','indexed-probe-v0327.cjs')):revision==='0326'?require(path.join(assets,'lobby','indexed-probe-v0326.cjs')):revision==='0325'?require(path.join(assets,'lobby','indexed-probe-v0325.cjs')):revision==='0324'?require(path.join(assets,'lobby','indexed-probe-v0324.cjs')):revision==='0323'?require(path.join(assets,'lobby','indexed-probe-v0323.cjs')):revision==='0322'?require(path.join(assets,'lobby','indexed-probe-v0322.cjs')):revision==='0321'?require(path.join(assets,'lobby','indexed-probe-v0321.cjs')):revision==='0320'?require(path.join(assets,'lobby','indexed-probe-v0320.cjs')):revision==='0313'?require(path.join(assets,'lobby','indexed-probe-v0313.cjs')):revision==='0312'?require(path.join(assets,'lobby','indexed-probe-v0312.cjs')):revision==='0311'?require(path.join(assets,'lobby','indexed-probe-v0311.cjs')):revision==='0310'?require(path.join(assets,'lobby','indexed-probe-v0310.cjs')):revision==='0306'?require(path.join(assets,'lobby','indexed-probe-v0306.cjs')):revision==='0305'?require(path.join(assets,'lobby','indexed-probe-v0305.cjs')):revision==='0304'?require(path.join(assets,'lobby','indexed-probe-v0304.cjs')):revision==='0301'?require(path.join(assets,'lobby','indexed-probe-v0301.cjs')):revision==='0300'?require(path.join(assets,'lobby','indexed-probe-v0300.cjs')):revision==='0292'?require(path.join(assets,'lobby','indexed-probe-v0292.cjs')):revision==='0291'?require(path.join(assets,'lobby','indexed-probe-v0291.cjs')):revision==='0290'?require(path.join(assets,'lobby','indexed-probe-v0290.cjs')):revision==='0282'?require(path.join(assets,'lobby','indexed-probe-v0282.cjs')):revision==='0280'?require(path.join(assets,'lobby','indexed-probe-v0280.cjs')):revision==='02733'?require(path.join(assets,'lobby','indexed-probe-v02733.cjs')):revision==='02732'?require(path.join(assets,'lobby','indexed-probe-v02732.cjs')):revision==='02731'?require(path.join(assets,'lobby','indexed-probe-v02731.cjs')):revision==='02730'?require(path.join(assets,'lobby','indexed-probe-v02730.cjs')):revision==='02729'?require(path.join(assets,'lobby','indexed-probe-v02729.cjs')):revision==='02728'?require(path.join(assets,'lobby','indexed-probe-v02728.cjs')):revision==='02727'?require(path.join(assets,'lobby','indexed-probe-v02727.cjs')):revision==='02726'?require(path.join(assets,'lobby','indexed-probe-v02726.cjs')):revision==='02725'?require(path.join(assets,'lobby','indexed-probe-v02725.cjs')):revision==='02723'?require(path.join(assets,'lobby','indexed-probe-v02723.cjs')):revision==='02722'?require(path.join(assets,'lobby','indexed-probe-v02722.cjs')):revision==='02721'?require(path.join(assets,'lobby','indexed-probe-v02721.cjs')):revision==='02720'?require(path.join(assets,'lobby','indexed-probe-v02720.cjs')):revision==='02719'?require(path.join(assets,'lobby','indexed-probe-v02719.cjs')):revision==='02711'?require(path.join(assets,'lobby','indexed-probe-v02711.cjs')):revision==='02710'?require(path.join(assets,'lobby','indexed-probe-v02710.cjs')):revision==='0279'?require(path.join(assets,'lobby','indexed-probe-v0279.cjs')):revision==='0278'?require(path.join(assets,'lobby','indexed-probe-v0278.cjs')):revision==='0277'?require(path.join(assets,'lobby','indexed-probe-v0277.cjs')):revision==='0276'?require(path.join(assets,'lobby','indexed-probe-v0276.cjs')):revision==='0275'?require(path.join(assets,'lobby','indexed-probe-v0275.cjs')):revision==='0274'?require(path.join(assets,'lobby','indexed-probe-v0274.cjs')):revision==='0273'?require(path.join(assets,'lobby','indexed-probe-v0273.cjs')):revision==='0272'?require(path.join(assets,'lobby','indexed-probe-v0272.cjs')):revision==='0271'?require(path.join(assets,'lobby','indexed-probe-v0271.cjs')):revision==='0266'?require(path.join(assets,'lobby','indexed-probe-v0266.cjs')):revision==='0265'?require(path.join(assets,'lobby','indexed-probe-v0265.cjs')):revision==='0264'?require(path.join(assets,'lobby','indexed-probe-v0264.cjs')):revision==='0263'?require(path.join(assets,'lobby','indexed-probe-v0263.cjs')):revision==='0262'?require(path.join(assets,'lobby','indexed-probe-v0262.cjs')):revision==='0261'?require(path.join(assets,'lobby','indexed-probe-v0261.cjs')):revision==='0260'?require(path.join(assets,'lobby','indexed-probe-v0260.cjs')):revision==='0252'?require(path.join(assets,'lobby','indexed-probe-v0252.cjs')):revision==='0250'?require(path.join(assets,'lobby','indexed-probe-v0250.cjs')):revision==='0244'?require(path.join(assets,'lobby','indexed-probe-v0244.cjs')):revision==='0243'?require(path.join(assets,'lobby','indexed-probe-v0243.cjs')):revision==='0242'?require(path.join(assets,'lobby','indexed-probe-v0242.cjs')):revision==='0241'?require(path.join(assets,'lobby','indexed-probe-v0241.cjs')):revision==='0240'?require(path.join(assets,'lobby','indexed-probe-v0240.cjs')):(revision==='17'||revision==='18'||revision==='19')?{build:require(path.join(assets,'lobby','indexed-probe-v02316.cjs'))[revision==='19'?'buildV19':revision==='18'?'buildV18':'buildV17']}:require(path.join(assets,'lobby','indexed-probe-v023'+revision+'.cjs')));
 const replayBuild=(revision:string,scale:number,legacy:boolean,presentation='0336',mapTexture?:ReplayTerrain,rules?:ResearchRuleset)=>build('replay-ui'+presentation+'-'+revision+'-'+scale+'-'+legacy+'-'+(mapTexture?mapTexture.name+':'+mapTexture.sha256:'')+(rules?'-research-'+rules.id:''),{layout:true,textures,hud:hudLua,hudScale:scale,legacyReplay:legacy,replayPresentation:true,replaySimulationRevision:revision,...(['0326','0327','0328','0329','0330','0331','0332','0335','0336'].includes(presentation)&&mapTexture?{replayTerrain:[{name:mapTexture.name,data:mapTexture.data,map:mapTexture.map}]}:{}),...(rules?{research:rules}:{})},presentation==='0335'?require(path.join(assets,'lobby','indexed-probe-v0335.cjs')):presentation==='0332'?require(path.join(assets,'lobby','indexed-probe-v0334.cjs')):presentation==='0330'||presentation==='0331'?require(path.join(assets,'lobby','indexed-probe-v0331.cjs')):presentation==='0329'?require(path.join(assets,'lobby','indexed-probe-v0329.cjs')):presentation==='0328'?require(path.join(assets,'lobby','indexed-probe-v0328.cjs')):presentation==='0327'?require(path.join(assets,'lobby','indexed-probe-v0327.cjs')):presentation==='0326'?require(path.join(assets,'lobby','indexed-probe-v0326.cjs')):presentation==='0325'?require(path.join(assets,'lobby','indexed-probe-v0325.cjs')):presentation==='0324'?require(path.join(assets,'lobby','indexed-probe-v0324.cjs')):presentation==='0323'?require(path.join(assets,'lobby','indexed-probe-v0323.cjs')):presentation==='0322'?require(path.join(assets,'lobby','indexed-probe-v0322.cjs')):presentation==='0321'?require(path.join(assets,'lobby','indexed-probe-v0321.cjs')):presentation==='0320'?require(path.join(assets,'lobby','indexed-probe-v0320.cjs')):presentation==='0313'?require(path.join(assets,'lobby','indexed-probe-v0313.cjs')):presentation==='0312'?require(path.join(assets,'lobby','indexed-probe-v0312.cjs')):builder);
 const latest=(scale:number)=>replayPresentation?replayBuild(targetRevision,scale,legacyReplay,'0336',terrain,research):custom?(modernHud?modern(targetRevision,scale):build('lobby',{layout:true,textures})):control();
 const probe=path.join(data,builder.PROBE_NAME),toc=path.join(root,'toc.win.bdf');
 for(const p of [probe,toc]){await ordinary(p);const stat=await lstat(p),limit=p===probe?MAX_INTERFACE_ARCHIVE:MAX_INTERFACE_TOC;if(!stat.isFile()||stat.size>limit)throw Object.assign(Error('The prepared interface exceeds its supported file bounds; it was preserved. '+path.basename(p)+': '+stat.size+' bytes; limit '+limit+' bytes.'),{code:'S2R_INTERFACE_UNKNOWN'});}
 const state=path.join(root,'revival-prepared','reforged-lobby-v1');
 try{await ordinary(path.dirname(state));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await mkdir(state,{recursive:true});await ordinary(path.dirname(state));await ordinary(state);
 const journal=path.join(state,'transaction.json');let pending:null|{target:string}=null;
 try{await ordinary(journal);pending=JSON.parse(await readFile(journal,'utf8'));if(!pending||!['control','custom'].includes(pending.target)||Object.keys(pending).length!==1)throw Error('Invalid journal.');}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('The custom lobby transaction needs review; no unknown files were overwritten.');}
 let previousScale=1;let previousResearchId:string|undefined;let previousReplay:{revision:ReplayRevision;legacy:boolean;presentation:string;terrainMap?:string}|undefined;
 try{await ordinary(path.join(state,'lobby-manifest.json'));const previous=JSON.parse(await readFile(path.join(state,'lobby-manifest.json'),'utf8'));previousResearchId=typeof previous?.hud?.researchId==='string'?previous.hud.researchId:undefined;const n=previous?.hud?.scale;if(typeof n==='number'&&n>=0.75&&n<=2.5&&Math.round(n*8)===n*8)previousScale=n;if(['replay-presentation-0312','replay-presentation-0313','replay-presentation-0320','replay-presentation-0321','replay-presentation-0322','replay-presentation-0323','replay-presentation-0324','replay-presentation-0325','replay-presentation-0326','replay-presentation-0327','replay-presentation-0328','replay-presentation-0329','replay-presentation-0330','replay-presentation-0331','replay-presentation-0332','replay-presentation-0335','replay-presentation-0336'].includes(previous?.hud?.mode)&&typeof previous.hud.originalSimulation==='boolean'){previousReplay={revision:validateReplayRevision(previous.hud.simulationRevision),legacy:previous.hud.originalSimulation,presentation:previous.hud.mode.slice(-4),terrainMap:terrainMap(previous.hud.replayTerrain?.map)};}}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const scales=[...new Set([hudScale,previousScale])].filter(n=>n!==1);
 const current=await Promise.all([readFile(toc),readFile(probe)]);
 const same=(r:any)=>current[0].equals(r.toc)&&current[1].equals(r.archive);
 progress('preparing-check-interface-cache');
 const catalog=await readProfileCatalog(assets,inputs,hudLua);
 const actualTocHash=hash(current[0]),actualArchiveHash=hash(current[1]);
 const installed=catalog?.profiles.find(p=>actualTocHash===p.tocSha256&&actualArchiveHash===p.archiveSha256);
 const baselineRecord=catalog?.profiles.find(p=>p.revision==='control');
 const backupVerified=async()=>{
  if(!baselineRecord)return false;
  try{for(const [name,expected]of [['control-toc.win.bdf',baselineRecord.tocSha256],['control-probe.scd',baselineRecord.archiveSha256]]){const file=path.join(state,name);await ordinary(file);if(hash(await readFile(file))!==expected)return false;}return true;}catch{return false;}
 };
 // An in-memory expectation comes only from this client's completed worker.
 // Revalidate the packaged catalog/source and both actual files before reuse.
 if((research||replayPresentation)&&expected&&catalog&&expected.source===catalog.source&&(expected.terrainSha??'')===(terrain?terrain.name+':'+terrain.sha256:'')&&(expected.revision??'current')===targetRevision&&expected.custom===custom&&expected.modernHud===modernHud&&expected.scale===hudScale&&expected.legacyReplay===legacyReplay&&expected.researchId===(research?.id??'')&&!!expected.replayPresentation===replayPresentation&&actualTocHash===expected.profile.tocSha256&&actualArchiveHash===expected.profile.archiveSha256&&await backupVerified()){
  progress('preparing-check-interface-cache',replayPresentation?'Verified current replay presentation':'Verified prepared research '+research!.id.slice(0,12));return {...expected.profile,cache:expected};
 }
 const unknownInterface=()=>Object.assign(Error('This copy has an unrecognized prepared interface. Its files were preserved.'),{code:'S2R_INTERFACE_UNKNOWN'});
 const catalogHasTarget=catalog?.profiles.some(p=>p.revision===targetRevision&&p.custom===custom&&p.modernHud===modernHud&&p.scale===hudScale&&p.legacyReplay===legacyReplay);
 const pendingKnown=pending&&catalog?.profiles.some(p=>p.tocSha256===actualTocHash)&&catalog.profiles.some(p=>p.archiveSha256===actualArchiveHash);
 let previousResearchKnown=false;
 let previousResearch:ResearchRuleset|undefined=research?.id===previousResearchId?research:undefined;
 if(!previousResearch&&previousResearchId){
  // The saved rules are only reconstruction inputs, never authority to overwrite.
  // Both actual interface files must match a packaged generator byte for byte.
  try{const file=path.join(state,'published-research.json'),st=await lstat(file);if(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size<=8_388_608){const rules=verifyRuleset(JSON.parse(await readFile(file,'utf8')));if(rules.id===previousResearchId)previousResearch=rules;}}catch{}
 }
 let previousReplayKnown=false;
 if(!installed&&previousReplay&&hudLua){const legacyTerrain=Number(previousReplay.presentation)<335;const previousTerrain=!legacyTerrain&&previousReplay.terrainMap===terrain?.map?terrain:previousReplay.terrainMap?await collectReplayTerrain(root,previousReplay.terrainMap,progress,legacyTerrain):undefined;const previous=replayBuild(previousReplay.revision,previousScale,previousReplay.legacy,previousReplay.presentation,previousTerrain,previousResearch);previousReplayKnown=(!previousResearchId||!!previousResearch)&&same(previous);}
 // Check the previous replay first, avoiding five expensive non-replay reconstructions.
 if(!installed&&previousResearch&&hudLua&&!previousReplayKnown){previousResearchKnown=['current','0335','0334','0333','0332','0331','0329','0328','0327','0326'].some(revision=>same(modern(revision,previousScale,false,previousResearch)));}
 if(recoverUnknown&&!research&&!replayPresentation&&catalogHasTarget&&!installed&&!pendingKnown&&!previousReplayKnown&&!previousResearchKnown)throw unknownInterface();
 // The catalog contains release-generated expectations, never a hash supplied by
 // mutable game state. Current files and all packaged generators/art are hashed.
 if(!research&&!replayPresentation&&!pending&&installed?.revision===targetRevision&&installed.custom===custom&&installed.modernHud===modernHud&&installed.scale===hudScale&&installed.legacyReplay===legacyReplay&&await backupVerified()){
  return {custom,tocSha256:installed.tocSha256,archiveSha256:installed.archiveSha256,...(modernHud?{hud:installed.manifest.hud}:{})};
 }
 progress('preparing-build-interface','HUD scale '+hudScale);
 const target=latest(hudScale);
 if(target.archive.length>MAX_INTERFACE_ARCHIVE||target.toc.length>MAX_INTERFACE_TOC)throw Error('The generated interface exceeds the supported file bounds; existing game files were preserved.');
 if(replayPresentation&&terrain)target.manifest.hud.replayTerrain={map:terrain.map,sha256:terrain.sha256,source:terrain.source,embedded:terrain.embedded};
 // The common launch verifies the actual two files against the current generated
 // overlay. Historical reconstruction is needed only for an older installation.
 const checked:any[]=[target];
 function* candidates():Generator<any>{
  yield control();
  yield build('labels',true);
  if(hudLua){
   for(const n of [...new Set([hudScale,previousScale,1])]){yield modern('current',n);yield modern('current',n,!legacyReplay);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('0335',n,false);yield modern('0335',n,true);yield modern('0334',n,false);yield modern('0334',n,true);yield modern('0333',n,false);yield modern('0333',n,true);yield modern('0332',n,false);yield modern('0332',n,true);yield modern('0331',n,false);yield modern('0331',n,true);yield modern('0329',n,false);yield modern('0329',n,true);yield modern('0328',n,false);yield modern('0328',n,true);yield modern('0327',n,false);yield modern('0327',n,true);yield modern('0326',n,false);yield modern('0326',n,true);yield modern('0325',n,false);yield modern('0325',n,true);yield modern('0324',n,false);yield modern('0324',n,true);yield modern('0323',n,false);yield modern('0323',n,true);yield modern('0322',n,false);yield modern('0322',n,true);yield modern('0321',n,false);yield modern('0321',n,true);yield modern('0320',n,false);yield modern('0320',n,true);yield modern('0313',n,false);yield modern('0313',n,true);yield modern('0312',n,false);yield modern('0312',n,true);yield modern('0311',n,false);yield modern('0311',n,true);yield modern('0310',n,false);yield modern('0310',n,true);yield modern('0306',n,false);yield modern('0306',n,true);yield modern('0305',n,false);yield modern('0305',n,true);yield modern('0304',n,false);yield modern('0304',n,true);yield modern('0301',n,false);yield modern('0301',n,true);yield modern('0300',n,false);yield modern('0300',n,true);yield modern('0292',n,false);yield modern('0292',n,true);yield modern('0291',n,false);yield modern('0291',n,true);yield modern('0290',n,false);yield modern('0290',n,true);yield modern('0282',n,false);yield modern('0282',n,true);yield modern('0280',n,false);yield modern('0280',n,true);yield modern('02733',n,false);yield modern('02733',n,true);yield modern('02732',n,false);yield modern('02732',n,true);yield modern('02731',n,false);yield modern('02731',n,true);yield modern('02730',n,false);yield modern('02730',n,true);yield modern('02729',n,false);yield modern('02729',n,true);yield modern('02728',n,false);yield modern('02728',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02727',n,false);yield modern('02727',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02726',n,false);yield modern('02726',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02725',n,false);yield modern('02725',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02723',n,false);yield modern('02723',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02722',n,false);yield modern('02722',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02721',n,false);yield modern('02721',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02720',n,false);yield modern('02720',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02719',n,false);yield modern('02719',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])]){yield modern('02711',n,false);yield modern('02711',n,true);}
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('02710',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0279',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0278',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0277',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0276',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0275',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0274',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0273',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0272',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0271',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0266',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0265',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0264',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0263',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0262',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0261',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0260',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0252',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0250',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0244',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0243',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0242',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0241',n);
   for(const n of [...new Set([previousScale,hudScale,1])])yield modern('0240',n);
   for(let revision=20;revision>=0;revision--){
    for(const n of [...new Set([previousScale,hudScale,1])])if(n===1||revision>=8)yield modern(String(revision),n);
   }
  }
  yield build('lobby',{layout:true,textures});yield build('labels',true);
  for(const [revision,count]of [['0221',90],['0220',88],['0210',61],['0200',59],['0191',53],['0180',53],['0160',53],['0141',41],['014',29],['0131',29],['013',29]] as const){
   yield build(revision,{layout:true,textures:textures.slice(0,count)},require(path.join(assets,'lobby','indexed-probe-v'+revision+'.cjs')));
  }
  const legacyRoot=path.join(assets,'lobby','legacy-v012'),previousManifest=JSON.parse(readLegacyManifest());
  const previousTextures=previousManifest.textures.map((t:{name:string;sha256:string})=>{
   if(!/^rf[a-z0-9_]*\.dds$/.test(t.name))throw Error('Invalid legacy artwork manifest');
   const fs=require('node:fs');let data=fs.readFileSync(path.join(artRoot,t.name));if(hash(data)!==t.sha256)data=fs.readFileSync(path.join(legacyRoot,t.name));
   if(hash(data)!==t.sha256)throw Error('Legacy lobby upgrade assets differ from their reviewed bytes');return {name:'textures/ui/common/pc/frontend/'+t.name,data};
  });
  yield build('012',{layout:true,textures:previousTextures},require(path.join(assets,'lobby','indexed-probe-v012.cjs')));
 }
 function readLegacyManifest(){return require('node:fs').readFileSync(path.join(assets,'lobby','legacy-v012','art-manifest.json'),'utf8');}
 let known=same(target)||!pending&&!!installed||!!pendingKnown||previousReplayKnown||previousResearchKnown;
 if(!known&&recoverUnknown){const baseline=control();if(same(baseline))known=true;else throw unknownInterface();}
 if(!known)for(const candidate of candidates()){
  progress('preparing-check-older-interface','Checked '+checked.length+' profiles');
  checked.push(candidate);
  if(same(candidate)||(pending&&checked.some(r=>current[0].equals(r.toc))&&checked.some(r=>current[1].equals(r.archive)))){known=true;break;}
 }
 if(!known)throw Error('The prepared lobby files differ from the supported versions. Restore your working UI probe before retrying.');
 if(!await backupVerified()){
 const baseline=control();
 for(const [name,bytes] of [['control-toc.win.bdf',baseline.toc],['control-probe.scd',baseline.archive]] as const){
  const backup=path.join(state,name);try{await writeFile(backup,bytes,{flag:'wx'});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await ordinary(backup);if(!(await readFile(backup)).equals(bytes))throw Error('The lobby restore backup differs from the known control.');}
 }
 }
 progress('preparing-save-interface');
 if(!same(target)){
  await atomic(journal,JSON.stringify({target:custom?'custom':'control'}));
  await atomic(probe,target.archive);await atomic(toc,target.toc);
 }
 if(research){const file=path.join(state,'published-research.json');try{const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('Invalid saved research file.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}await atomic(file,JSON.stringify(research));}
 await rm(journal,{force:true});
 await atomic(path.join(state,'lobby-manifest.json'),JSON.stringify({...target.manifest,active:custom?'custom':'control'},null,2));
 const profile={custom,tocSha256:hash(target.toc),archiveSha256:hash(target.archive),...(modernHud?{hud:target.manifest.hud}: {})};
 return {...profile,...((research||replayPresentation)&&catalog?{cache:{source:catalog.source,terrainSha:terrain?terrain.name+':'+terrain.sha256:'',replayPresentation,revision:targetRevision,custom,modernHud,scale:hudScale,legacyReplay,researchId:research?.id??'',profile} as LobbyProfileCache}:{})};
}
