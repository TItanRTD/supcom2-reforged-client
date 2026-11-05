import {immutableJson} from './immutable-json';
import {validateReplayMetadata} from './replay-metadata';
import {readFile,writeFile,mkdir,rename,lstat,open,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import type {IncomingMessage} from 'node:http';
import {ApiError} from './lobby';
import {ratings,profile} from './skill';
export type MatchMode='1v1'|'team'|'ffa';
interface Result{matchId:string;mode:MatchMode;at:string;confirmedBy:string;players:{accountId:string;rank:number}[]}
export class MatchHistory{
 private results:Result[]=[];private serial:Promise<unknown>=Promise.resolve();
 constructor(private file?:string){}
 private async load(){if(!this.file)return this.results;try{const d=JSON.parse(await readFile(this.file,'utf8'));if(d.schema!==1||!Array.isArray(d.results))throw Error('Invalid match history');return d.results as Result[];}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}}
 async confirm(value:Record<string,unknown>,actor:string,known:Set<string>){
  const work=this.serial.then(async()=>{if(typeof value.matchId!=='string'||! /^[a-f0-9-]{36}$/.test(value.matchId)||!['1v1','team','ffa'].includes(value.mode as string)||!Array.isArray(value.players)||value.players.length<2||value.players.length>8)throw new ApiError(400,'Choose a match, mode and 2–8 players.');
   const players=value.players.map(p=>{if(!p||typeof p!=='object'||!known.has(p.accountId)||!Number.isInteger(p.rank)||p.rank<1||p.rank>8)throw new ApiError(400,'Invalid match participant or finishing rank.');return {accountId:p.accountId as string,rank:p.rank as number};});
   if(new Set(players.map(p=>p.accountId)).size!==players.length||value.mode==='1v1'&&(players.length!==2||players.every(p=>p.rank===players[0].rank)))throw new ApiError(400,'Invalid participants or 1v1 result.');
   const results=await this.load();if(results.some(r=>r.matchId===value.matchId))throw new ApiError(409,'This match has already been recorded.');if(results.length>=100000)throw new ApiError(503,'Match history capacity reached.');
   results.push({matchId:value.matchId,mode:value.mode as MatchMode,at:new Date().toISOString(),confirmedBy:actor,players});
   if(this.file){await mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify({schema:1,results}),{flag:'wx',mode:0o600});await rename(temp,this.file);}else this.results=results;
  });this.serial=work.catch(()=>{});await work;
 }
 async confirmed(){return (await this.load()).map(r=>({...r,players:r.players.map(p=>({...p}))}));}
 async rating(id:string){const state=ratings((await this.load()).map(r=>({players:r.players.map(p=>({id:p.accountId,rank:p.rank,...(r.mode==='team'?{team:p.rank}:{})}))})));return profile(state,id);}
 async lobbyGames(ids:string[]){const rows=new Map(ids.map(id=>[id,0]));for(const match of await this.load())for(const p of match.players)if(rows.has(p.accountId))rows.set(p.accountId,rows.get(p.accountId)!+1);return rows;}
 async leaderboard(mode:MatchMode|'custom',accounts:{id:string;username:string;disabled:boolean}[]){const state=ratings((await this.load()).map(r=>({players:r.players.map(p=>({id:p.accountId,rank:p.rank,...(r.mode==='team'?{team:p.rank}:{})}))})));const rows=new Map(accounts.filter(a=>!a.disabled).map(a=>[a.id,{id:a.id,name:a.username,games:0,wins:0,losses:0,rating:profile(state,a.id).rating}]));
  for(const r of await this.load()){if(mode!=='custom'&&r.mode!==mode)continue;const best=Math.min(...r.players.map(p=>p.rank));for(const p of r.players){const row=rows.get(p.accountId);if(row){row.games++;if(p.rank===best)row.wins++;else row.losses++;}}}
  return {mode,ratingName:'Custom Forge Rating',ratingStatus:'custom',resultSource:'administrator-confirmed',players:[...rows.values()].sort((a,b)=>b.rating-a.rating||b.wins-a.wins||b.games-a.games||a.name.localeCompare(b.name)).map((p,i)=>({...p,position:p.games?i+1:null}))};
 }
}
export const REPLAY_LIMIT=64*1024*1024;
export function replayHeader(bytes:Uint8Array){return Buffer.from(bytes).subarray(0,64).includes(Buffer.from('Replay v1.9\r\n'));}
interface ReplayRecord{id:string;name:string;ownerId:string;owner:string;size:number;at:string}
export class ReplayVault{
 private serial:Promise<unknown>=Promise.resolve();
 constructor(private directory?:string){}
 private async records():Promise<ReplayRecord[]>{if(!this.directory)return [];try{const data=JSON.parse(await readFile(path.join(this.directory,'index.json'),'utf8'));if(data.schema!==1||!Array.isArray(data.replays))throw Error('Invalid replay index');return data.replays;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}}
 async list(){return (await this.records()).slice().sort((a,b)=>b.at.localeCompare(a.at));}
 async upload(req:IncomingMessage,name:unknown,ownerId:string,owner:string){
  if(!this.directory)throw new ApiError(503,'Community replay storage is not configured.');
  if(typeof name!=='string'||!name.trim()||name.length>160||/[\x00-\x1f\\/]/.test(name))throw new ApiError(400,'Invalid replay name.');
  await mkdir(this.directory,{recursive:true});const temp=path.join(this.directory,'.upload-'+randomUUID()),file=await open(temp,'wx',0o600),hash=createHash('sha256');let size=0,header=Buffer.alloc(0);
  try{for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>REPLAY_LIMIT)throw new ApiError(413,'Replay limit is 64 MiB.');if(header.length<64)header=Buffer.concat([header,b.subarray(0,64-header.length)]);if(header.length>=64&&!replayHeader(header))throw new ApiError(400,'This is not a supported SupCom 2 replay.');hash.update(b);await file.writeFile(b);}await file.close();
   if(size<16||!replayHeader(header))throw new ApiError(400,'This is not a supported SupCom 2 replay.');
   const id=hash.digest('hex');const work=this.serial.then(async()=>{const rows=await this.records();const existing=rows.find(r=>r.id===id);if(existing)return existing;
    if(rows.length>=1000||rows.reduce((n,r)=>n+r.size,0)+size>1024*1024*1024)throw new ApiError(507,'Community replay storage is full.');
    const record={id,name:(name as string).trim(),ownerId,owner,size,at:new Date().toISOString()};const destination=path.join(this.directory!,id+'.SC2Replay');await rename(temp,destination);
    const index=path.join(this.directory!,'index.json'),pending=index+'.'+randomUUID()+'.tmp';try{await writeFile(pending,JSON.stringify({schema:1,replays:[...rows,record]}),{flag:'wx',mode:0o600});await rename(pending,index);}catch(e){await unlink(destination).catch(()=>{});await unlink(pending).catch(()=>{});throw e;}return record;
   });this.serial=work.catch(()=>{});return await work;
  }finally{await file.close().catch(()=>{});await unlink(temp).catch(()=>{});}
 }
 async saveMetadata(id:string,raw:unknown,ownerId:string){
  const item=await this.get(id);if(item.record.ownerId!==ownerId)throw new ApiError(403,'Only the replay uploader can attach its provenance.');
  let meta;try{meta=validateReplayMetadata(raw,id);}catch(e){throw new ApiError(400,(e as Error).message);}
  const target=path.join(this.directory!,id+'.reforged.json'),bytes=JSON.stringify(meta);if(Buffer.byteLength(bytes)>8_388_608)throw new ApiError(413,'Replay provenance exceeds its size limit.');
  try{await immutableJson(target,bytes);}catch(e){throw new ApiError(409,(e as Error).message);}return{saved:true};
 }
 async metadata(id:string){await this.get(id);const target=path.join(this.directory!,id+'.reforged.json');try{const s=await lstat(target);if(!s.isFile()||s.isSymbolicLink()||s.size>8_388_608)throw Error('Invalid replay provenance.');return validateReplayMetadata(JSON.parse(await readFile(target,'utf8')),id);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
 async get(id:string){if(!this.directory||! /^[a-f0-9]{64}$/.test(id))throw new ApiError(404,'Replay not found.');const row=(await this.records()).find(r=>r.id===id);if(!row)throw new ApiError(404,'Replay not found.');const file=path.join(this.directory,id+'.SC2Replay'),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size!==row.size)throw new ApiError(409,'Replay storage changed.');return {file,record:row};}
}
