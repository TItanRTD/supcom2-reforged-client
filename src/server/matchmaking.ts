import {randomInt,randomUUID} from 'node:crypto';
import {CLIENT_VERSION,MATCH_QUEUES,FACTIONS,LADDER_TEAM_COLOURS,LADDER_FFA_COLOURS,type Faction,type QueueMode,type GameProfile,type RoomMap,type MatchmakingStatus,type Colour} from '../shared/model';
import {ApiError,Lobby,roomMap} from './lobby';
import {RankedLadder} from './ladder';
const EXE='e80136ba3851ab6f37a8fb0b7fbcafd9d9276b2f1290911b554973d6a7477581';
interface Entry{token:string;id:string;name:string;since:number;seen:number;maps:RoomMap[];canHost:boolean;queues:QueueMode[];factions:Faction[];party?:string;pair?:Pair}
interface Pair{id:string;players:Entry[];teams:Map<string,number>;mode:QueueMode;map:RoomMap;accepted:Set<string>;until:number;roomId?:string;hostId:string}
interface Party{id:string;leader:string;members:Set<string>;invited:Set<string>}
/** One account enters several queues; one allocation atomically removes it from all. */
export class Matchmaker{
 private entries=new Map<string,Entry>();private prepared=new Map<string,Entry>();private parties=new Map<string,Party>();
 constructor(private lobby:Lobby,private now=Date.now,private ladder?:RankedLadder){}
 assertRenameAllowed(id:string){if(this.entries.has(id))throw new ApiError(409,'Cancel the matchmaking search before renaming.');}
 forgetPrepared(id:string){this.prepared.delete(id);}
 private partyFor(id:string){return [...this.parties.values()].find(p=>p.members.has(id));}
 party(token:string,action='state',target?:unknown){
  const current=this.lobby.snapshot(token),id=current.playerId;let p=this.partyFor(id);
  if(action!=='state'&&(this.entries.has(id)||current.room))throw new ApiError(409,'Leave your game or cancel the search before changing your party.');
  if(action==='create'){if(p)throw new ApiError(409,'You already have a party.');p={id:randomUUID(),leader:id,members:new Set([id]),invited:new Set()};this.parties.set(p.id,p);}
  else if(action==='invite'){
   if(!p||p.leader!==id)throw new ApiError(403,'Only the party leader can invite players.');
   const peer=this.lobby.presence().find(v=>typeof target==='string'&&(v.id===target||v.name.toLowerCase()===target.toLowerCase()));
   if(!peer||peer.id===id||this.partyFor(peer.id)||peer.roomId)throw new ApiError(409,'Choose an online player who is free to join.');if(p.members.size+p.invited.size>=4)throw new ApiError(409,'Parties support up to four players.');p.invited.add(peer.id);
  }else if(action==='accept'){
   if(p)throw new ApiError(409,'Leave your current party first.');const next=this.parties.get(String(target));
   if(!next||!next.invited.has(id)||next.members.size>=4||[...next.members].some(m=>this.entries.has(m)))throw new ApiError(409,'This invitation expired.');next.invited.delete(id);next.members.add(id);p=next;
   for(const other of this.parties.values())other.invited.delete(id);
  }else if(action==='leave'){
   if(p){if([...p.members].some(m=>this.entries.has(m)))throw new ApiError(409,'Cancel your party search first.');p.members.delete(id);if(!p.members.size)this.parties.delete(p.id);else if(p.leader===id)p.leader=[...p.members][0];p=undefined;}
  }else if(!['state','create','invite','accept'].includes(action))throw new ApiError(400,'Unknown party action.');
  const people=this.lobby.presence(),name=(id:string)=>people.find(v=>v.id===id)?.name??'Offline commander';
  return {party:p?{id:p.id,leader:p.leader,members:[...p.members].map(id=>({id,name:name(id),ready:!!this.prepared.get(id)&&this.prepared.get(id)!.seen+20000>this.now(),online:people.some(v=>v.id===id)}))}:null,invitations:[...this.parties.values()].filter(v=>v.invited.has(id)).map(v=>({id:v.id,from:name(v.leader)}))};
 }
 private validate(token:string,body:Record<string,unknown>,canHost:boolean):Entry{
  const current=this.lobby.snapshot(token);
  if(current.room)throw new ApiError(409,'Leave your current lobby before finding a match.');
  if(body.clientVersion!==CLIENT_VERSION)throw new ApiError(409,'Update the client and room server to the same release before matchmaking.');
  const profile=body.profile as GameProfile|undefined;
  if(profile?.verification!=='exe-only'||profile.exeSha256!==EXE)throw new ApiError(409,'Select the supported Supreme Commander 2 installation first.');
  if(!Array.isArray(body.maps)||body.maps.length<1||body.maps.length>250)throw new ApiError(400,'Choose installed multiplayer maps.');
  const queues=(body.queues??['1v1']) as QueueMode[];
  if(!Array.isArray(queues)||!queues.length||queues.length>7||new Set(queues).size!==queues.length||queues.some(q=>typeof q!=='string'||!Object.hasOwn(MATCH_QUEUES,q)))throw new ApiError(400,'Choose one or more ranked match types.');
  const factions=(body.factions??[]) as Faction[];
  // Omitted factions preserve the account preference; explicit choices are a pool.
  if(body.factions!==undefined&&(!Array.isArray(factions)||!factions.length||factions.length>3||new Set(factions).size!==factions.length||factions.some(f=>!FACTIONS.includes(f))))throw new ApiError(400,'Choose at least one Supreme Commander 2 faction.');
  const maps=new Map<string,RoomMap>();for(const raw of body.maps){const m=roomMap(raw);if(!m||m.players!==null&&m.players<2)throw new ApiError(400,'Choose maps with at least two start positions.');maps.set(m.id.toLowerCase(),m);}
  if(this.ladder&&!queues.some(q=>this.ladder!.getPool(q).length))throw new ApiError(409,'The administrator has not selected the ranked map pool yet.');
  if(this.ladder&&!queues.some(q=>this.ladder!.getPool(q).some(p=>[...maps.values()].some(m=>m.id.toLowerCase()===p.id.toLowerCase()&&m.metadataHash===p.metadataHash))))throw new ApiError(409,'Install a map from the current ranked pool and rescan maps.');
  this.lobby.act(token,'profile',{profile});
  return {token,id:current.playerId,name:this.lobby.presence().find(p=>p.id===current.playerId)!.name,since:this.now(),seen:this.now(),maps:[...maps.values()],canHost,queues:[...queues],factions:body.factions===undefined?[]:[...factions]};
 }
 prepare(token:string,body:Record<string,unknown>,canHost:boolean){const entry=this.validate(token,body,canHost);this.prepared.set(entry.id,entry);return this.party(token);}
 join(token:string,body:Record<string,unknown>,canHost:boolean):MatchmakingStatus{
  this.sweep();const current=this.lobby.snapshot(token),party=this.partyFor(current.playerId);if(party&&party.leader!==current.playerId)throw new ApiError(403,'Your party leader starts the search.');const entry=this.validate(token,body,canHost);this.prepared.set(entry.id,entry);
  if(this.entries.has(entry.id))throw new ApiError(409,'You are already finding a match.');
  if(party&&party.leader!==entry.id)throw new ApiError(403,'Your party leader starts the search.');
  const members=party?[...party.members].map(id=>id===entry.id?entry:this.prepared.get(id)): [entry];
  if(members.some(e=>!e||e.seen+20000<=this.now()||this.entries.has(e.id)||this.lobby.snapshot(e.token).room))throw new ApiError(409,'Every party member must open matchmaking with their installation and maps ready.');
  const modes=entry.queues.filter(q=>members.length===1||!q.startsWith('ffa')&&MATCH_QUEUES[q].teamSize>=members.length);
  if(!modes.length)throw new ApiError(400,'Choose a team queue large enough for your party. FFA is solo only.');
  const ready=members as Entry[];
  // A party enters only modes with at least one exact map shared by everybody.
  const common=modes.filter(q=>{
   const pool=this.ladder?.getPool(q)??entry.maps;
   return pool.some(m=>ready.every(e=>e.maps.some(n=>n.id.toLowerCase()===m.id.toLowerCase()&&n.metadataHash===m.metadataHash)));
  });
  if(!common.length)throw new ApiError(409,'Your party needs a shared map from at least one selected ranked pool. Rescan maps on every PC.');
  for(const e of ready)this.entries.set(e.id,{...e,queues:[...common],party:party?.id,since:this.now()});
  this.pair();return this.status(token,canHost);
 }
 stats(){const out={} as NonNullable<MatchmakingStatus['stats']>;const pairs=new Set([...this.entries.values()].map(e=>e.pair).filter(p=>p?.roomId));for(const q of Object.keys(MATCH_QUEUES) as QueueMode[]){const entries=[...this.entries.values()].filter(e=>!e.pair&&e.queues.includes(q));out[q]={queued:entries.length,active:[...pairs].filter(p=>p!.mode===q).length,oldestSeconds:entries.length?Math.max(0,Math.floor((this.now()-Math.min(...entries.map(e=>e.since)))/1000)):0};}return out;}
 status(token:string,canHost:boolean):MatchmakingStatus{
  this.sweep();const current=this.lobby.snapshot(token),e=this.entries.get(current.playerId);if(e&&e.token===token){e.seen=this.now();e.canHost=canHost;}
  this.sweep();this.pair();const entry=this.entries.get(current.playerId),meta={stats:this.stats(),rating:this.ladder?.rating(current.playerId)};
  if(!entry||entry.token!==token)return {phase:'idle',...meta};const p=entry.pair;
  if(!p)return {phase:'searching',queuedAt:new Date(entry.since).toISOString(),canHost:entry.canHost,queues:entry.queues,...meta};
  const peer=p.players.find(v=>v.id!==entry.id)!;
  return {phase:p.roomId?'assigned':'accepting',queuedAt:new Date(entry.since).toISOString(),matchId:p.id,queue:p.mode,map:p.map,opponent:peer.name,acceptBy:new Date(p.until).toISOString(),accepted:p.accepted.has(entry.id),opponentAccepted:p.accepted.has(peer.id),...(p.roomId?{roomId:p.roomId,role:p.hostId===entry.id?'host' as const:'guest' as const}:{}),...meta};
 }
 accept(token:string,id:unknown,canHost:boolean):MatchmakingStatus{
  this.status(token,canHost);const current=this.lobby.snapshot(token),e=this.entries.get(current.playerId),p=e?.pair;
  if(!e||e.token!==token||!p||p.id!==id||p.roomId||p.until<=this.now())throw new ApiError(409,'This match offer expired or changed.');if(current.room)throw new ApiError(409,'Leave your current lobby first.');p.accepted.add(e.id);
  if(p.accepted.size===p.players.length)this.allocate(p);return this.status(token,canHost);
 }
 cancel(token:string,id?:unknown):MatchmakingStatus{
  const current=this.lobby.snapshot(token),e=this.entries.get(current.playerId);if(e?.token===token){const p=e.pair;if(id&&p?.id!==id)throw new ApiError(409,'The match changed.');if(p&&this.canDepart(e,p)){this.entries.delete(e.id);if(current.room?.id===p.roomId)this.lobby.act(token,'leave',{});return {phase:'idle'};}const party=this.partyFor(e.id);for(const peer of [...this.entries.values()])if(peer.id===e.id||party?.members.has(peer.id))this.entries.delete(peer.id);if(p){if(p.roomId)this.lobby.closeRoom(p.roomId);if(p.roomId)for(const peer of p.players)this.entries.delete(peer.id);this.dissolve(p);}}return {phase:'idle'};
 }
 private canDepart(e:Entry,p:Pair){
  if(!p.roomId||e.id===p.hostId)return false;
  try{const room=this.lobby.snapshot(p.players.find(v=>v.id===p.hostId)!.token).room;
   return room?.id===p.roomId&&!!room.nativeHost&&(room.nativeHost.phase==='battle-observed'||this.ladder?.hasOwnOutcome(p.id,e.id)===true);
  }catch{return false;}
 }
 private dissolve(p:Pair){for(const e of p.players){e.pair=undefined;if(this.entries.has(e.id))e.seen=this.now();}}
 private sweep(){for(const e of [...this.entries.values()]){if(!this.entries.has(e.id))continue;const p=e.pair;let valid=e.seen+20000>this.now();try{const current=this.lobby.snapshot(e.token);if(p?.roomId)valid=current.room?.id===p.roomId&&(!!current.room.nativeHost||p.until>this.now());else if(current.room)valid=false;}catch{valid=false;}if(!valid){this.entries.delete(e.id);if(p&&this.canDepart(e,p))continue;if(e.party)for(const peer of this.entries.values())if(peer.party===e.party)this.entries.delete(peer.id);if(p){if(p.roomId){this.lobby.closeRoom(p.roomId);for(const peer of p.players)this.entries.delete(peer.id);}this.dissolve(p);}}else if(p&&!p.roomId&&p.until<=this.now()){for(const player of p.players)if(!p.accepted.has(player.id))this.entries.delete(player.id);this.dissolve(p);}}
  for(const [id,e]of this.prepared)if(e.seen+60000<this.now())this.prepared.delete(id);
  const online=new Set(this.lobby.presence().map(p=>p.id));for(const p of this.parties.values()){for(const id of p.members)if(!online.has(id))p.members.delete(id);for(const id of p.invited)if(!online.has(id))p.invited.delete(id);if(!p.members.size)this.parties.delete(p.id);else if(!p.members.has(p.leader))p.leader=[...p.members][0];}
 }
 private allocate(p:Pair){
  const host=p.players.find(v=>v.id===p.hostId)!;let roomId='';const ordered=[host,...p.players.filter(e=>e!==host)];
  // Army colours are unique, grouped by team, and decided before game launch.
  const counts=new Map<number,number>();
  const colours:Colour[]=ordered.map(e=>{const team=p.teams.get(e.id)!,index=counts.get(team)??0;counts.set(team,index+1);const colour=p.mode.startsWith('ffa')?LADDER_FFA_COLOURS[team-1]:LADDER_TEAM_COLOURS[team-1]?.[index];if(!colour)throw new ApiError(409,'Invalid ranked team colour allocation.');return colour;});
  try{
   for(const [i,e] of ordered.entries())this.lobby.setPreferred(e.token,{colour:colours[i],...(e.factions.length?{faction:e.factions[randomInt(e.factions.length)]}:{})});
   const created=this.lobby.act(host.token,'create',{name:(p.mode==='1v1'?host.name+' vs '+ordered[1].name:'Ranked '+MATCH_QUEUES[p.mode].label).slice(0,48),map:p.map,capacity:p.players.length});roomId=created.room!.id;
   for(const e of ordered.slice(1))this.lobby.act(e.token,'join',{roomId});
   for(const [i,e]of ordered.entries()){const row=this.lobby.snapshot(e.token).room!.players.find(p=>p.id===e.id)!;this.lobby.act(e.token,'player',{team:p.teams.get(e.id),colour:colours[i],faction:row.faction});}
   if(p.map.spawnTeams){const slots=new Map<number,number[]>();p.map.spawnTeams.forEach((team,slot)=>{if(team)slots.set(team,[...(slots.get(team)??[]),slot]);});const assignments=ordered.map(e=>{const available=slots.get(p.teams.get(e.id)!)!;return {id:e.id,slot:available.splice(randomInt(available.length),1)[0]};});this.lobby.assignStarts(roomId,assignments);}
   this.lobby.markMatchmade(roomId,p.id);p.roomId=roomId;p.until=this.now()+120000;for(const e of p.players)p.accepted.add(e.id);
   this.ladder?.register(p.id,ordered.map(e=>({id:e.id,name:e.name,team:p.teams.get(e.id)})),p.map,p.mode);
  }catch(error){if(roomId)this.lobby.closeRoom(roomId);this.dissolve(p);throw error;}
 }
 private pair(){
  const waiting=[...this.entries.values()].filter(e=>!e.pair).sort((a,b)=>a.since-b.since||a.id.localeCompare(b.id));
  for(const first of waiting){if(first.pair)continue;
   for(const mode of first.queues){
    const spec=MATCH_QUEUES[mode],eligible=waiting.filter(e=>!e.pair&&e.queues.includes(mode));
    const groups:Entry[][]=[];for(const e of eligible){if(groups.some(g=>g.includes(e)))continue;const group=e.party?eligible.filter(p=>p.party===e.party):[e];if(e.party&&group.length!==this.parties.get(e.party)?.members.size)continue;groups.push(group);}
    if(!groups.some(g=>g.includes(first)))continue;
    const anchor=groups.find(g=>g.includes(first))!;
    const pool=this.ladder?.getPool(mode)??first.maps;
    const anchorMaps=pool.filter(m=>anchor.every(e=>e.maps.some(n=>n.id.toLowerCase()===m.id.toLowerCase()&&n.metadataHash===m.metadataHash)));
    const candidates=groups.filter(g=>g!==anchor&&anchorMaps.some(m=>g.every(e=>e.maps.some(n=>n.id.toLowerCase()===m.id.toLowerCase()&&n.metadataHash===m.metadataHash)))).slice(0,31);
    // Bound work without excluding an anchor after the first 32 queued groups.
    let budget=4096;let found:{players:Entry[];map:RoomMap;teams:Map<string,number>}|undefined;
    const search=(index:number,chosen:Entry[][],count:number)=>{
     if(found||--budget<0||count>spec.players)return;
     if(count===spec.players){const players=chosen.flat();if(!players.includes(first)||!players.some(e=>e.canHost))return;
      const tolerance=5+(this.now()-Math.min(...players.map(e=>e.since)))/1000*0.15;
      const strengths=players.map(e=>this.ladder?.rating(e.id).strength??0);if(Math.max(...strengths)-Math.min(...strengths)>tolerance)return;
      const pool=this.ladder?.getPool(mode)??first.maps;
      const maps=pool.filter(m=>players.every(e=>e.maps.some(n=>n.id.toLowerCase()===m.id.toLowerCase()&&n.metadataHash===m.metadataHash)));if(!maps.length)return;
      const teams=new Map<string,number>();
      if(mode.startsWith('ffa'))players.forEach((e,i)=>teams.set(e.id,i+1));
      else{
       let best=Infinity,bestMask=0;for(let mask=1;mask<(1<<chosen.length);mask++){let size=0,a=0,b=0;for(let i=0;i<chosen.length;i++){const sum=chosen[i].reduce((n,e)=>n+(this.ladder?.rating(e.id).strength??0),0);if(mask&(1<<i)){size+=chosen[i].length;a+=sum;}else b+=sum;}if(size===spec.teamSize&&Math.abs(a-b)<best){best=Math.abs(a-b);bestMask=mask;}}
       if(!bestMask)return;chosen.forEach((g,i)=>g.forEach(e=>teams.set(e.id,bestMask&(1<<i)?1:2)));
       // Keep host on Team 1, as the native bootstrap expects before ready sync.
       const host=players.find(e=>e.canHost)!;if(teams.get(host.id)!==1)for(const e of players)teams.set(e.id,3-teams.get(e.id)!);
      }
      found={players,map:maps[this.ladder?randomInt(maps.length):0],teams};return;
     }
     for(let i=index;i<candidates.length;i++)search(i+1,[...chosen,candidates[i]],count+candidates[i].length);
    };search(0,[anchor],anchor.length);if(!found)continue;const f=found as {players:Entry[];map:RoomMap;teams:Map<string,number>};
    const p:Pair={id:randomUUID(),players:f.players,map:f.map,teams:f.teams,mode,accepted:new Set(),until:this.now()+30000,hostId:f.players.find(e=>e.canHost)!.id};for(const e of p.players)e.pair=p;if(this.ladder)this.allocate(p);break;
   }
  }
 }
}
