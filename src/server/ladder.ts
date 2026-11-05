import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiError,roomMap} from './lobby';
import {MATCH_QUEUES,type QueueMode,type RoomMap} from '../shared/model';
import {ratings,profile} from './skill';
interface Contender{id:string;name:string;team?:number}
interface NativeOutcome{name:string;outcome:'victory'|'defeat'|'draw';tick:number;faction?:'UEF'|'CYBRAN'|'ILLUMINATE'}
interface Match{id:string;players:Contender[];mode?:QueueMode;map:RoomMap;at:number;reports:Record<string,string>;observations?:Record<string,NativeOutcome[]>;winner?:string;ranks?:Record<string,number>;settled?:boolean;disputed?:boolean}
/** Persisted OpenSkill ladder. Complete authenticated native outcomes are
 * required; observations that disagree leave a match disputed and unrated. */
export class RankedLadder{
 private ratingCache?:ReturnType<typeof ratings>;private pool:RoomMap[]=[];private pools:Partial<Record<QueueMode,RoomMap[]>>={};private matches:Match[]=[];private revision=0;private written=0;private loaded=false;private loading?:Promise<void>;private serial:Promise<unknown>=Promise.resolve();
 constructor(private file?:string,private now=Date.now){}
 async load(){if(this.loaded)return;return this.loading??=this.read();}
 private async read(){
  if(this.file)try{const s=await readFile(this.file,'utf8');if(s.length>20_000_000)throw Error('Ranked store is too large.');const d=JSON.parse(s);if(d.schema!==1||!Array.isArray(d.pool)||!Array.isArray(d.matches))throw Error('Invalid ranked store.');this.pool=this.validatePool(d.pool);for(const [mode,maps] of Object.entries(d.pools??{})){if(!Object.hasOwn(MATCH_QUEUES,mode))throw Error('Unknown ranked pool');this.pools[mode as QueueMode]=this.validatePool(maps,mode as QueueMode);}this.matches=d.matches;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  this.loaded=true;
 }
 private validatePool(raw:unknown,mode:QueueMode='1v1'){if(!Array.isArray(raw)||raw.length>32)throw new ApiError(400,'Choose up to 32 maps for this queue.');const list=raw.map(m=>{const v=roomMap(m);if(!v||v.players===null||v.players<MATCH_QUEUES[mode].players)throw new ApiError(400,'Maps need at least '+MATCH_QUEUES[mode].players+' verified start positions for '+mode+'.');if(v.spawnTeams){if(v.spawnTeams.some((team,slot)=>team>0&&slot>=8))throw new ApiError(400,'This build supports assigning the first eight native starts only.');const q=MATCH_QUEUES[mode],counts=new Map<number,number>();for(const team of v.spawnTeams)if(team)counts.set(team,(counts.get(team)??0)+1);const teams=mode.startsWith('ffa')?q.players:2;if(counts.size!==teams||Array.from({length:teams},(_,i)=>counts.get(i+1)).some(n=>n!==q.teamSize))throw new ApiError(400,'Assign exactly '+q.teamSize+' starts to each of '+teams+' teams for '+mode+'.');}return v;});if(new Set(list.map(m=>m.id.toLowerCase())).size!==list.length)throw new ApiError(400,'Remove duplicate ladder maps.');return list;}
 getPool(mode:QueueMode='1v1'){return (mode==='1v1'?this.pool:this.pools[mode]??[]).map(m=>structuredClone(m));}
 getPools(){return Object.fromEntries(Object.keys(MATCH_QUEUES).map(m=>[m,this.getPool(m as QueueMode)]));}
 async setPool(raw:unknown,mode:QueueMode='1v1'){if(!Object.hasOwn(MATCH_QUEUES,mode))throw new ApiError(400,'Unknown queue.');await this.load();const next=this.validatePool(raw,mode);const work=this.serial.then(async()=>{const old=this.getPool(mode);if(mode==='1v1')this.pool=next;else this.pools[mode]=next;try{await this.persist();}catch(e){if(mode==='1v1')this.pool=old;else this.pools[mode]=old;throw e;}});this.serial=work.catch(()=>{});await work;return this.getPool(mode);}
 register(id:string,players:Contender[],map:RoomMap,mode:QueueMode='1v1'){if(this.matches.some(m=>m.id===id))return;this.revision++;this.matches.push({id,players:players.map((p,i)=>({...p,team:p.team??i+1})),mode,map,at:this.now(),reports:{}});if(this.matches.length>100000)throw new ApiError(503,'Ladder history capacity reached.');}
 registerCustom(id:string,players:Contender[],map:RoomMap,mode:QueueMode){
  const current=this.matches.find(m=>m.id===id);if(!current){this.register(id,players,map,mode);return;}
  const next=players.map((p,i)=>({...p,team:p.team??i+1}));
  if(JSON.stringify([current.players,current.map,current.mode])===JSON.stringify([next,map,mode]))return;
  // Launch preparation can be cancelled. Only an entirely unreported custom
  // setup may change; ranked assignments and observed outcomes stay immutable.
  if(current.settled||Object.keys(current.reports).length||Object.keys(current.observations??{}).length)throw new ApiError(409,'This custom run already has outcomes. Its starting setup is locked.');
  Object.assign(current,{players:next,map,mode,at:this.now()});this.revision++;
 }
 importConfirmed(results:{matchId:string;mode:string;at:string;players:{accountId:string;rank:number}[]}[],accounts:{id:string;username:string}[]){
  const seen=new Set(this.matches.map(m=>m.id)),names=new Map(accounts.map(a=>[a.id,a.username]));
  for(const r of results){if(seen.has(r.matchId)||r.players.some(p=>!names.has(p.accountId)))continue;seen.add(r.matchId);const players=r.players.map((p,i)=>({id:p.accountId,name:names.get(p.accountId)!,team:r.mode==='team'?p.rank:i+1}));const ranks=Object.fromEntries(r.players.map(p=>[p.accountId,p.rank]));this.matches.push({id:r.matchId,players,map:{id:'/maps/confirmed/confirmed_scenario.lua',name:'Confirmed custom result',players:players.length,metadataHash:'0'.repeat(64)},at:Date.parse(r.at),reports:{},ranks,winner:players.find(p=>ranks[p.id]===Math.min(...Object.values(ranks)))!.id,settled:true});this.revision++;this.ratingCache=undefined;}
 }
 async flush(){if(this.written===this.revision)return;const work=this.serial.then(async()=>{if(this.written!==this.revision){const version=this.revision;await this.persist();this.written=version;}});this.serial=work.catch(()=>{});await work;}
 private async persist(){if(!this.file)return;await mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify({schema:1,pool:this.pool,pools:this.pools,matches:this.matches}),{flag:'wx',mode:0o600});await rename(temp,this.file);}
 private skillState(){return this.ratingCache??=ratings(this.matches.filter(m=>m.settled).map(m=>({players:m.players.map((p,i)=>({id:p.id,team:p.team??i+1,rank:m.ranks?.[p.id]??(m.winner==='draw'?1:m.winner===p.id||m.players.find(w=>w.id===m.winner)?.team===p.team&&p.team!==undefined?1:2)}))})));}
 rating(id:string){return profile(this.skillState(),id);}
 hasOwnOutcome(id:string,account:string){const m=this.matches.find(m=>m.id===id),player=m?.players.find(p=>p.id===account);return !!player&&(!!m!.observations?.[account]?.some(e=>e.name===player.name)||Object.hasOwn(m!.reports,account));}
 async reportEvents(id:unknown,account:string,raw:unknown){
  await this.load();const work=this.serial.then(async()=>{
   const m=this.matches.find(m=>m.id===id);if(!m||!m.players.some(p=>p.id===account))throw new ApiError(403,'You are not a participant in this ladder match.');
   if(!Array.isArray(raw)||raw.length<1||raw.length>8)throw new ApiError(400,'Invalid native outcomes.');
   const events:NativeOutcome[]=raw.map(e=>{if(!e||typeof e.name!=='string'||!m.players.some(p=>p.name.toLowerCase()===e.name.toLowerCase())||!['victory','defeat','draw'].includes(e.outcome)||!Number.isInteger(e.tick)||e.tick<0||e.tick>1728000||e.faction!==undefined&&!['UEF','CYBRAN','ILLUMINATE'].includes(e.faction))throw new ApiError(400,'Invalid native outcome.');return {name:m.players.find(p=>p.name.toLowerCase()===e.name.toLowerCase())!.name,outcome:e.outcome,tick:e.tick,...(e.faction?{faction:e.faction}:{})};});
   if(new Set(events.map(e=>e.name)).size!==events.length)throw new ApiError(400,'Duplicate native outcome.');
   if(!events.some(e=>e.name===m.players.find(p=>p.id===account)!.name))throw new ApiError(400,'Report your own native outcome.');
   if(m.settled){if(JSON.stringify(m.observations?.[account])!==JSON.stringify(events))throw new ApiError(409,'This result is already recorded.');return {status:'recorded'};}if(this.now()-m.at>48*3600_000)throw new ApiError(409,'This result window expired.');
   m.observations??={};const prior=m.observations[account];if(prior&&JSON.stringify(prior)!==JSON.stringify(events))throw new ApiError(409,'This client already reported a different result.');m.observations[account]=events;
   const own=m.players.map(p=>m.observations![p.id]?.find(e=>e.name===p.name));
   const complete=own.every(Boolean);let conflict=false;
   for(const list of Object.values(m.observations))for(const e of list){const index=m.players.findIndex(p=>p.name===e.name),self=own[index];if(self&&(self.outcome!==e.outcome||Math.abs(self.tick-e.tick)>2||self.faction&&e.faction&&self.faction!==e.faction))conflict=true;}
   m.disputed=conflict;
   if(complete&&!conflict&&own.some(e=>e!.outcome!=='defeat')){
    const teams=new Map<number,{ids:string[];time:number;won:boolean;draw:boolean}>();
    m.players.forEach((p,i)=>{const key=p.team??i+1,t=teams.get(key)??{ids:[],time:0,won:false,draw:false};t.ids.push(p.id);t.time=Math.max(t.time,own[i]!.tick);t.won ||=own[i]!.outcome==='victory';t.draw ||=own[i]!.outcome==='draw';teams.set(key,t);});
    const groups=[...teams.values()];if(groups.some(t=>t.won&&t.draw)||groups.filter(t=>t.won).length>1)m.disputed=true;
    else{m.ranks={};for(const t of groups){const rank=t.won||t.draw?1:1+groups.filter(o=>o.won||o.draw||o.time>t.time).length;for(const id of t.ids)m.ranks[id]=rank;}m.winner=groups.every(t=>t.draw)?'draw':m.players.find(p=>m.ranks![p.id]===1)?.id;m.settled=true;this.ratingCache=undefined;}
   }
   await this.persist();return {status:m.settled?'recorded':m.disputed?'disputed':'waiting-for-opponent'};
  });this.serial=work.catch(()=>{});return work;
 }
 async report(id:unknown,account:string,winner:unknown){
  await this.load();const work=this.serial.then(async()=>{
   const m=this.matches.find(m=>m.id===id);if(!m||!m.players.some(p=>p.id===account))throw new ApiError(403,'You are not a participant in this ladder match.');
   let ranks:Record<string,number>|undefined;
   if(Array.isArray(winner)){
    if(winner.length!==m.players.length)throw new ApiError(400,'Report every match participant.');
    ranks={};for(const raw of winner){if(!raw||typeof raw!=='object'||typeof raw.name!=='string'||!Number.isInteger(raw.rank)||raw.rank<1||raw.rank>m.players.length)throw new ApiError(400,'Invalid finishing rank.');const p=m.players.find(p=>p.name.toLowerCase()===raw.name.toLowerCase());if(!p||ranks[p.id]!==undefined)throw new ApiError(400,'Unknown or duplicate participant.');ranks[p.id]=raw.rank;}
    for(const p of m.players)if(m.players.some(q=>p.team!==undefined&&q.team===p.team&&ranks![p.id]!==ranks![q.id]))throw new ApiError(400,'Teammates must share a finishing rank.');
   }else if(typeof winner!=='string'||winner!=='draw'&&!m.players.some(p=>p.name.toLowerCase()===winner.toLowerCase()))throw new ApiError(400,'Unknown native match winner.');
   if(!ranks&&m.players.length>2)throw new ApiError(400,'Team and FFA matches require complete finishing ranks.');
   const result=ranks?JSON.stringify(m.players.map(p=>ranks![p.id])):winner==='draw'?'draw':m.players.find(p=>p.name.toLowerCase()===(winner as string).toLowerCase())!.id;
   if(m.settled){if(m.reports[account]!==result)throw new ApiError(409,'This result is already recorded.');return {status:'recorded'};}
   if(this.now()-m.at>48*3600_000)throw new ApiError(409,'This result window expired.');
   if(m.reports[account]&&m.reports[account]!==result)throw new ApiError(409,'This client already reported a different result.');
   m.reports[account]=result;const reports=Object.values(m.reports);m.disputed=reports.length===m.players.length&&new Set(reports).size!==1;
   if(reports.length===m.players.length&&!m.disputed){m.winner=ranks?m.players.find(p=>ranks![p.id]===Math.min(...Object.values(ranks!)))!.id:result;m.ranks=ranks;m.settled=true;this.ratingCache=undefined;}await this.persist();return {status:m.settled?'recorded':m.disputed?'disputed':'waiting-for-opponent'};
  });this.serial=work.catch(()=>{});return work;
 }
 statistics(id:string){
  const blank=()=>({games:0,wins:0,losses:0,draws:0,winRate:0});
  const modes=new Map<string,Record<string,ReturnType<typeof blank>>>();let total=0,unknown=0;
  for(const m of this.matches){
   if(!m.settled||m.disputed)continue;const p=m.players.find(p=>p.id===id);if(!p)continue;
   const own=m.observations?.[id]?.find(e=>e.name===p.name),faction=own?.faction??'UNKNOWN';
   const mode=m.mode??(m.players.length===2?'1v1':'other');let rows=modes.get(mode);if(!rows){rows=Object.fromEntries(['UEF','CYBRAN','ILLUMINATE','UNKNOWN'].map(f=>[f,blank()]));modes.set(mode,rows);}
   const r=rows[faction];if(!r)continue;r.games++;total++;if(faction==='UNKNOWN')unknown++;
   const winning=m.players.find(w=>w.id===m.winner),won=m.ranks?m.ranks[id]===1:m.winner===id||p.team!==undefined&&winning?.team===p.team;
   if(m.winner==='draw'||own?.outcome==='draw')r.draws++;else if(won)r.wins++;else r.losses++;
  }
  for(const rows of modes.values())for(const row of Object.values(rows))row.winRate=row.games?Math.round(row.wins/row.games*1000)/10:0;
  return {rating:this.rating(id),games:total,unknownFactionGames:unknown,modes:Object.fromEntries([...modes].sort(([a],[b])=>a.localeCompare(b)))};
 }
 leaderboard(accounts:{id:string;username:string;disabled:boolean}[]){return {mode:'ladder',ratingName:'Ladder Forge Rating',ratingStatus:'ranked',resultSource:'matching-native-client-reports',players:accounts.filter(a=>!a.disabled).map(a=>{const r=this.rating(a.id);let wins=0,losses=0,draws=0;for(const m of this.matches)if(m.settled&&m.players.some(p=>p.id===a.id)){if(m.winner==='draw')draws++;else if(m.ranks?.[a.id]===1||m.winner===a.id)wins++;else losses++;}return {id:a.id,name:a.username,...r,wins,losses,draws,position:null as number|null};}).sort((a,b)=>b.rating-a.rating||b.games-a.games||a.name.localeCompare(b.name)).map((r,i)=>({...r,position:r.games?i+1:null}))};}
}
