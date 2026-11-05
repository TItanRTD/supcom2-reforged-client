import {mkdir,readFile,writeFile,rename,rm,readdir,lstat,stat,realpath,link} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const OWNER='community.sc2.revival.steam-runtime';
const markerName='reforged-runtime.json';
type Identity={dev:string;ino:string};
type RuntimeState={owner:string;schema:number;source:string;linked:Record<string,Identity>};
const same=(a:{dev:bigint|string;ino:bigint|string},b:{dev:bigint|string;ino:bigint|string})=>String(a.dev)===String(b.dev)&&String(a.ino)===String(b.ino);
const exists=async(p:string)=>lstat(p,{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
/** Pin one owned executable directory per installation, independent of research,
 * replay mode, client version, or directory modification times. */
export async function runtimeName(base:string,id:string,source:string,fresh=false){
 if(!/^[a-f0-9]{16}(?:-r[a-f0-9]{16})?$/.test(id))throw Error('Invalid runtime identity.');
 id=id.slice(0,16);
 const valid=(name:unknown):name is string=>typeof name==='string'&&new RegExp('^'+id+'(?:-r[a-f0-9]{16})?(?:-recovery|-g[0-9]{3,8})?$').test(name);
 const owned=async(name:string)=>{const file=path.join(base,name,markerName);await plainParents(file);const s=await exists(file);if(!s||!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.size>2_000_000n)return null;try{const m=JSON.parse(await readFile(file,'utf8'));return m.owner===OWNER&&m.schema===1&&m.source===source?Number(s.mtimeMs):null;}catch{return null;}};
 const pin=path.join(base,id+'-active.json');await plainParents(pin);const ps=await exists(pin);
 if(ps){if(!ps.isFile()||ps.isSymbolicLink()||ps.nlink!==1n||ps.size>4096n)throw Error('Invalid runtime selection file.');const p=JSON.parse(await readFile(pin,'utf8'));if(p.owner!==OWNER||p.source!==source||!valid(p.name))throw Error('Invalid runtime selection.');if(await owned(p.name)!==null&&(!fresh||p.name.endsWith('-recovery')))return p.name;}
 if(fresh)return id+'-recovery';
 const entries=await readdir(base,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return[];throw e;});
 const choices:{name:string;time:number}[]=[];
 for(const e of entries)if(e.isDirectory()&&!e.isSymbolicLink()&&valid(e.name)){const time=await owned(e.name);if(time!==null)choices.push({name:e.name,time});}
 choices.sort((a,b)=>b.time-a.time||a.name.localeCompare(b.name));return choices[0]?.name??id;
}
function relative(value:string){if(!value||/[\\:\x00-\x1f]/.test(value)||value.startsWith('/')||value.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('Invalid managed runtime path.');return value;}
async function plainParents(file:string){let p=path.dirname(file);while(p!==path.dirname(p)){const s=await exists(p);if(s&&(!s.isDirectory()||s.isSymbolicLink()))throw Error('A linked runtime directory is not supported: '+p);p=path.dirname(p);}}
async function atomic(file:string,bytes:Buffer|string){await plainParents(file);const s=await exists(file);if(s&&(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n))throw Error('A managed runtime output must be an independent file: '+file);const t=file+'.'+randomUUID()+'.tmp';try{await writeFile(t,bytes,{flag:'wx'});await rename(t,file);}finally{await rm(t,{force:true});}}
export function isSteamInstallation(executable:string){const parts=path.normalize(executable).toLowerCase().split(path.sep);const at=parts.lastIndexOf('steamapps');return at>=0&&parts[at+1]==='common'&&parts.length===at+5&&parts[at+3]==='bin'&&parts[at+4]==='supremecommander2.exe';}
/** Shares read-only game inputs with Steam using hard links. Only the runtime's
 * independent TOC, probe archive and named Reforged executable are ever written.
 * No Steam file is replaced, patched, chmodded, renamed or deleted. */
export async function syncSteamRuntime(sourceRoot:string,runtimeRoot:string,progress:(stage:string,detail?:string)=>unknown=()=>{},baselineName='toc.win.bdf'){
 const source=await realpath(sourceRoot);runtimeRoot=path.resolve(runtimeRoot);
 if(runtimeRoot===source||runtimeRoot.startsWith(source+path.sep)||source.startsWith(runtimeRoot+path.sep))throw Error('Reforged runtime must be separate from the Steam installation.');
 await plainParents(path.join(runtimeRoot,markerName));
 const rootStat=await exists(runtimeRoot);if(rootStat&&(!rootStat.isDirectory()||rootStat.isSymbolicLink()))throw Error('Invalid Reforged runtime directory.');
 await mkdir(runtimeRoot,{recursive:true});
 const marker=path.join(runtimeRoot,markerName);let state:RuntimeState={owner:OWNER,schema:1,source,linked:{}};
 if(await exists(marker)){
  const ms=await lstat(marker,{bigint:true});if(!ms.isFile()||ms.isSymbolicLink()||ms.nlink!==1n||ms.size>2_000_000)throw Error('Invalid Reforged runtime ownership file.');
  state=JSON.parse(await readFile(marker,'utf8'));
  if(state.owner!==OWNER||state.schema!==1||state.source!==source||!state.linked||typeof state.linked!=='object'||Array.isArray(state.linked))throw Error('This runtime belongs to a different game installation.');
  for(const [name,id]of Object.entries(state.linked)){relative(name);if(!id||typeof id.dev!=='string'||typeof id.ino!=='string'||!/^\d{1,30}$/.test(id.dev)||!/^\d{1,30}$/.test(id.ino))throw Error('Invalid runtime link identity.');}
 }else{
  if((await readdir(runtimeRoot)).length)throw Error('Refusing to reuse a nonempty folder without Reforged runtime ownership.');
  await atomic(marker,JSON.stringify(state));
 }
 const next:Record<string,Identity>={};let inspected=0;progress('preparing-runtime-files','Checking game-data links');
 async function walk(dir:string,rel=''){
  for(const entry of await readdir(dir,{withFileTypes:true})){
   const name=relative(rel?rel+'/'+entry.name:entry.name),lower=name.toLowerCase();
   if((!rel&&['toc.win.bdf','toc.original.win.bdf','revival-prepared',markerName].includes(lower))||lower.startsWith('gamedata/supcom2_revival_')||/^bin\/supremecommander2\.reforged/i.test(lower))continue;
   const from=path.join(source,name),to=path.join(runtimeRoot,name);
   if(entry.isSymbolicLink())throw Error('Steam game links need review before preparing Reforged: '+name);
   if(entry.isDirectory()){await plainParents(path.join(to,'placeholder'));await mkdir(to,{recursive:true});await walk(from,name);continue;}
   if(!entry.isFile())continue;
   const original=await stat(from,{bigint:true});await plainParents(to);const current=await exists(to);
   if(current){
    if(!current.isFile()||current.isSymbolicLink())throw Error('Unexpected runtime file: '+name);
    if(!same(current,original)){
     if(!state.linked[name]||!same(current,state.linked[name]))throw Error('A runtime file was changed outside Reforged: '+name);
     await rm(to);
    }
   }
   if(!current||!same(current,original)){
    try{await link(from,to);}catch(e){throw Error('Cannot link Steam game data on this drive. Reforged requires a writable NTFS runtime on the same drive as Steam. '+(e as Error).message);}
   }
   inspected++;if(inspected%32===0)progress('preparing-runtime-files','Checked '+inspected+' files; '+name);
   next[name]={dev:String(original.dev),ino:String(original.ino)};
  }
 }
 await walk(source);
 for(const [name,id]of Object.entries(state.linked))if(!next[name]){const to=path.join(runtimeRoot,name);await plainParents(to);const s=await exists(to);if(s){if(!s.isFile()||s.isSymbolicLink()||!same(s,id))throw Error('A removed Steam asset has an unexpected runtime replacement: '+name);await rm(to);}}
 await atomic(marker,JSON.stringify({...state,linked:next}));
 if(!['toc.win.bdf','toc.original.win.bdf'].includes(baselineName))throw Error('Invalid runtime baseline.');
 const baseline=await readFile(path.join(source,baselineName));
 const originalToc=path.join(runtimeRoot,'toc.original.win.bdf');
 if(await exists(originalToc)){if(!(await readFile(originalToc)).equals(baseline))throw Error('Steam updated the game index. This game version needs a reviewed Reforged runtime.');}else await atomic(originalToc,baseline);
 return {root:runtimeRoot,executable:path.join(runtimeRoot,'bin','SupremeCommander2.exe'),linkedFiles:Object.keys(next).length};
}
export async function prepareSteamRuntime(executable:string,assets:string,runRoot:string,legacyReplay=false,progress:(stage:string,detail?:string)=>unknown=()=>{},researchId?:string,freshRuntime=false){
 if(researchId!==undefined&&(!/^[a-f0-9]{64}$/.test(researchId)||legacyReplay))throw Error('Invalid research runtime identity.');
 let source=await realpath(executable),sourceRoot=path.dirname(path.dirname(source));
 // Selecting a managed copy must resolve back to its original installation;
 // otherwise research/replay launches recursively create new runtime identities.
 const marker=path.join(sourceRoot,markerName),ms=await exists(marker);
 if(ms){await plainParents(marker);if(!ms.isFile()||ms.isSymbolicLink()||ms.nlink!==1n||ms.size>2_000_000n)throw Error('Invalid runtime ownership.');const m=JSON.parse(await readFile(marker,'utf8'));if(m.owner!==OWNER||m.schema!==1||typeof m.source!=='string'||!path.isAbsolute(m.source)||m.source===sourceRoot)throw Error('Invalid runtime source.');source=await realpath(path.join(m.source,'bin','SupremeCommander2.exe'));sourceRoot=path.dirname(path.dirname(source));if(await exists(path.join(sourceRoot,markerName)))throw Error('Nested managed runtime sources are not supported.');}
 const id=createHash('sha256').update(sourceRoot.toLowerCase()).digest('hex').slice(0,16);
 if(legacyReplay){const expected=require(path.join(assets,'lobby','indexed-probe.cjs')).TOC_HASH;if(createHash('sha256').update(await readFile(path.join(sourceRoot,await exists(path.join(sourceRoot,'toc.original.win.bdf'))?'toc.original.win.bdf':'toc.win.bdf'))).digest('hex')!==expected)throw Error('Legacy replay UI requires the original Supreme Commander 2 installation. Choose its original executable.');}
 // AppData is preferred. A Steam library on another drive needs its own small
 // sibling runtime so hard links never fall back to copying gigabytes.
 const localBase=path.join(path.dirname(runRoot),'game-runtime');await mkdir(localBase,{recursive:true});
 const sourceInfo=await stat(sourceRoot,{bigint:true}),localInfo=await stat(localBase,{bigint:true});
 const base=sourceInfo.dev===localInfo.dev?localBase:path.join(isSteamInstallation(source)?path.dirname(path.dirname(path.dirname(sourceRoot))):path.dirname(sourceRoot),'S2R-Reforged');
 const baselineName=!isSteamInstallation(source)&&await exists(path.join(sourceRoot,'toc.original.win.bdf'))?'toc.original.win.bdf':'toc.win.bdf';
 if((researchId||freshRuntime||!isSteamInstallation(source))&&createHash('sha256').update(await readFile(path.join(sourceRoot,baselineName))).digest('hex')!==require(path.join(assets,'lobby','indexed-probe.cjs')).TOC_HASH)throw Error('Research requires the original game index.');
 const name=await runtimeName(base,id,sourceRoot,freshRuntime);
 const runtime=await syncSteamRuntime(sourceRoot,path.join(base,name),progress,baselineName);
 await atomic(path.join(base,id+'-active.json'),JSON.stringify({owner:OWNER,source:sourceRoot,name}));
 const builder=require(path.join(assets,'lobby','indexed-probe.cjs'));
 const toc=path.join(runtime.root,'toc.win.bdf'),probe=path.join(runtime.root,'gamedata',builder.PROBE_NAME);
 if(!(await exists(toc))||!(await exists(probe))){
 const inputs=await Promise.all([readFile(path.join(sourceRoot,'gamedata','ui.scd')),readFile(path.join(sourceRoot,baselineName)),readFile(path.join(sourceRoot,'gamedata','ui.scd.enc'))]);
 progress('preparing-seed-interface');
 const seed=builder.build(...inputs,false);
 // An interrupted first preparation may have only one seed output. Each is
 // independent of Steam and a later lobby transaction validates the pair.
 for(const [file,bytes]of [[toc,seed.toc],[probe,seed.archive]] as [string,Buffer][]){if(!(await exists(file)))await atomic(file,bytes);}
 }
 return runtime.executable;
}
