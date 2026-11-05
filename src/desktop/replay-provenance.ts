import {validateReplayMetadata} from '../server/replay-metadata';
import {verifyRuleset,type ResearchRuleset} from '../server/research-publication';
import {readFile,lstat,writeFile,copyFile,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ReplayPlayback,BrowserPlayer} from '../shared/model';
import {replayHeader,REPLAY_LIMIT} from '../server/community';
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function smallJson(file:string){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>8_388_608)throw Error('Invalid replay metadata.');return JSON.parse(await readFile(file,'utf8'));}
export function replayPlayers(value:unknown):BrowserPlayer[]{
 const r=(value as {roster?:{ReadOK?:boolean;Entries?:unknown[]}}|null)?.roster;
 if(r?.ReadOK!==true||!Array.isArray(r.Entries)||r.Entries.length>32)return [];
 const players=r.Entries.flatMap((entry)=>{const p=entry as {Name?:unknown;Team?:unknown;AI?:unknown;Observer?:unknown};return p&&typeof p.Name==='string'&&p.Name.trim().length>0&&p.Name.length<=64&&!/[\x00-\x1f\x7f]/.test(p.Name)&&Number.isInteger(p.Team)&&(p.Team===-1||Number(p.Team)>=1&&Number(p.Team)<=8)&&typeof p.AI==='boolean'&&typeof p.Observer==='boolean'?[{name:p.Name.trim(),team:Number(p.Team),ai:p.AI,observer:p.Observer}]:[];});
 return players.length===r.Entries.length&&players.filter(p=>!p.observer).length<=8?players:[];
}
export function replayFormat(roster:BrowserPlayer[]){
 const p=roster.filter(p=>!p.observer);if(p.length<2)return p.length===1?'Solo':'Custom game';
 const teams=new Map<number,number>();for(const v of p)teams.set(v.team,(teams.get(v.team)??0)+1);
 if(p.length===2&&(teams.size===2||p.every(p=>p.team===-1)))return '1v1';
 if(p.every(p=>p.team===-1)||teams.size===p.length)return 'FFA';
 if(!teams.has(-1)&&teams.size>=2)return [...teams.values()].sort((a,b)=>b-a).join('v');
 return 'Custom game';
}
function component(s:string){return s.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/[. ]+$/g,'').trim();}
/** Copy-before-unlink never replaces another recording; a crash retains a playable source. */
export async function finishSavedReplay(file:string,players:BrowserPlayer[],version:string,at=new Date(),research?:ResearchRuleset){
 const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>REPLAY_LIMIT)throw Error('Invalid saved replay.');const bytes=await readFile(file);if(!replayHeader(bytes))throw Error('Saved replay is incomplete.');
 const roster=players.filter(p=>!p.observer),stamp=at.toISOString().replace(/[:.]/g,'-'),names=roster.map(p=>p.name).join(', ')||'Unknown players';
 const stem=component(`${replayFormat(players)} - ${names}`).slice(0,140).replace(/[. ]+$/g,'');
 const target=path.join(path.dirname(file),`${stem} - ${stamp}.SC2Replay`);let saved=file;
 try{await copyFile(file,target,constants.COPYFILE_EXCL);saved=target;await unlink(file);}catch(e){if(saved===target)throw e;if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
 await writeFile(saved+'.reforged.json',JSON.stringify({format:'s2r-replay-v1',sha256:digest(bytes),playback:'reforged',clientVersion:version,players,gameType:replayFormat(players),...(research?{research:verifyRuleset(research)}:{})},null,2),{flag:'wx'});
 return saved;
}
/** Unmarked recordings use original simulation data. Names alone never select a ruleset. */
export async function detectReplayPlayback(file:string):Promise<ReplayPlayback>{
 try{const m=await smallJson(file+'.reforged.json');if(m.format==='s2r-replay-v1'&&m.playback==='reforged'&&typeof m.sha256==='string'&&/^[a-f0-9]{64}$/.test(m.sha256)){
  const st=await lstat(file);if(st.isFile()&&!st.isSymbolicLink()&&st.size<=REPLAY_LIMIT&&digest(await readFile(file))===m.sha256)return 'reforged';
 }}catch{/* Legacy and externally copied replays may have no provenance file. */}
 // Earlier client versions saved match.SC2Replay inside their own prepared run.
 if(path.basename(file).toLowerCase()==='match.sc2replay')try{const m=await smallJson(path.join(path.dirname(file),'direct-host-manifest.json'));if(typeof m==='object'&&m!==null&&m.format==='supcom2-revival-direct-host-v0.4'&&m.hudPresentation?.readOnly===false&&/^0\.27\.\d+$/.test(m.clientVersion))return 'reforged';}catch{}
 return 'original';
}

export async function readReplayResearch(file:string):Promise<ResearchRuleset|undefined>{
 let m;try{m=await smallJson(file+'.reforged.json');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 if(m.research===undefined)return;
 const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>REPLAY_LIMIT||digest(await readFile(file))!==m.sha256)throw Error('Replay research metadata no longer matches this recording.');
 return verifyRuleset(m.research);
}

export async function readReplayMetadata(file:string){
 try{const m=await smallJson(file+'.reforged.json');return validateReplayMetadata(m,digest(await readFile(file)));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}

/** A version is trusted only when its companion still matches this recording. */
export async function readReplayVersion(file:string):Promise<string|undefined>{
 let m;try{m=await smallJson(file+'.reforged.json');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 const st=await lstat(file);
 if(m.format!=='s2r-replay-v1'||m.playback!=='reforged'||!st.isFile()||st.isSymbolicLink()||st.size>REPLAY_LIMIT||digest(await readFile(file))!==m.sha256)throw Error('Replay version metadata no longer matches this recording.');
 if(typeof m.clientVersion!=='string'||!/^0\.\d{1,3}\.\d{1,3}$/.test(m.clientVersion))throw Error('Invalid replay client version.');
 return m.clientVersion;
}
