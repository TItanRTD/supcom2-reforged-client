import {writeFile,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {COLOUR_DEFINITIONS,type HostRoomRequest,type Snapshot} from '../shared/model';
import {RankedCountdown,type RankedPlan} from './ranked-lobby';
import {calculateLobbyBalance} from '../shared/balance';
import {nativeBalanceLines} from './lobby-balance';
const MAGIC=0x42523253;
interface ServiceValue{rankedRequested:boolean;players:{name:string;games:number|null;rating?:number|null;uncertainty?:number|null;strength?:number|null}[];ack:number;sample?:unknown;ladder?:RankedPlan}
export function encodeLobbyServices(value:ServiceValue,sequence:number,staging?:ReturnType<RankedCountdown['update']>){
 const b=Buffer.alloc(2048);b.writeUInt32LE(MAGIC,0);b.writeUInt32LE(1,4);b.writeUInt32LE(sequence>>>0,8);b.writeUInt32LE(value.rankedRequested?1:0,12);b.writeUInt32LE(value.ack>>>0,24);
 const balance=nativeBalanceLines(value.players,value.sample);const lines=[balance[0],balance[1],...Array.from({length:8},(_,i)=>balance[i+2]??''),'Forge Rating totals; not a win probability.','',value.ladder?'Ladder · automatic start':'Custom Forge Rating'];
 // Fixed 128-byte UTF-8 slots are always terminated; game constructs its own strings.
 if(value.ladder){
  staging??=new RankedCountdown().update(value.ladder,value.sample,Date.now());
  lines[10]=staging.message;lines[1]=value.ladder.map.name??'Selected map';
  const teams=new Map<number,number>();for(const p of value.ladder.players)teams.set(p.team,(teams.get(p.team)??0)+1);
  const format=teams.size===value.ladder.players.length&&teams.size>2?value.ladder.players.length+'-PLAYER FFA':[...teams.values()].sort((a,b)=>a-b).join('v');lines[12]='LADDER / '+format;
  const comparison=calculateLobbyBalance(value.ladder.players.map(p=>{const row=value.players.find(r=>r.name.toLowerCase()===p.name.toLowerCase());return{name:p.name,team:p.team,games:row?.games??null,rating:row?.strength??row?.rating??null,uncertainty:row?.uncertainty??null};}));
  lines[0]=comparison.percentage===null?'Game balance: Unrated':`Game balance: ${Math.floor(comparison.percentage*10)/10}%`;
  const a=staging.command;b.writeUInt32LE(Math.max(0,Math.min(5000,Math.ceil(staging.remainingMs))),20);b.writeUInt32LE(0x41325253,0x700);b.writeUInt32LE(a.action,0x704);b.writeUInt32LE(a.team??0,0x708);b.writeUInt32LE(a.start??0,0x70c);if(a.row)b.write('p'+a.row+'_ready',0x720,'ascii');
 }
 lines.slice(0,13).forEach((s,i)=>{let text='';for(const c of s.replace(/[\x00-\x1f\x7f]/g,' ')){if(Buffer.byteLength(text+c)>126)break;text+=c;}b.write(text,32+i*128,'utf8');});
 if(value.ladder){
  // Ranked row records occupy former team-summary text slots. Custom service
  // snapshots retain their original format. All text fields terminate inside
  // their own fixed extent; binary fields never overlap games/ratings/commands.
  for(let slot=0;slot<8;slot++)b.fill(0,32+(slot+2)*128,32+(slot+3)*128);
  const teams=[...new Set(value.ladder.players.map(p=>p.team))].sort((a,b)=>a-b),ffa=teams.length>2,counts=new Map<number,number>();
  for(const p of value.ladder.players){
   const index=counts.get(p.team)??0;counts.set(p.team,index+1);
   const slot=ffa?Math.floor((p.team-1)/2)+(p.team%2===0?4:0):(p.team===1?0:4)+index;
   if(slot<0||slot>7)continue;const at=32+(slot+2)*128;
   const write=(offset:number,size:number,text:string)=>{let out='';for(const c of text.replace(/[\x00-\x1f\x7f]/g,' ')){if(Buffer.byteLength(out+c)>=size)break;out+=c;}b.write(out,at+offset,'utf8');};
   const rows=value.players.filter(r=>r.name.toLowerCase()===p.name.toLowerCase()),row=rows.length===1?rows[0]:undefined;
   write(0,25,p.name);write(28,8,typeof row?.rating==='number'&&Number.isFinite(row.rating)&&row.rating>=0?row.rating.toFixed(1):'--');
   write(36,8,typeof row?.games==='number'&&Number.isSafeInteger(row.games)&&row.games>=0?String(Math.min(9999999,row.games)):'--');write(44,20,p.faction);write(64,20,p.colour);write(84,16,'Team '+p.team);
   b.writeUInt32LE(index===0?1:0,at+108);b.writeUInt32LE(1,at+112);b.writeUInt32LE(p.team,at+116);b.writeUInt32LE(COLOUR_DEFINITIONS.find(c=>c.name===p.colour)?.nativeId??0,at+120);b.writeUInt32LE(Math.max(0,['UEF','Cybran','Illuminate'].indexOf(p.faction)),at+124);
  }
 }
 const roster=(value.sample as {roster?:{ReadOK?:boolean;Entries?:{Name:string;StartPosition:number;AI:boolean;Observer:boolean}[]}})?.roster;
 if(roster?.ReadOK&&Array.isArray(roster.Entries)){
  b.writeUInt32LE(0x52353253,0x6c0);b.writeUInt32LE(0x47363253,0x6c4);
  for(const p of roster.Entries){const index=p.StartPosition;if(p.AI||p.Observer||!Number.isInteger(index)||index<0||index>7)continue;const record=value.players.filter(r=>r.name.toLowerCase()===p.Name.toLowerCase());if(record.length!==1||record[0].rating===null||record[0].rating===undefined||!Number.isFinite(record[0].rating)||record[0].rating!<0||Buffer.byteLength(p.Name)>24)continue;
   b.write(p.Name,0x738+index*25,24,'utf8');b.writeFloatLE(record[0].rating!,0x6a0+index*4);b.write(record[0].rating!.toFixed(1).slice(0,7),index<6?0x6c8+index*8:0x710+(index-6)*8,7,'ascii');
   const games=record[0].games;b.write(typeof games==='number'&&Number.isSafeInteger(games)&&games>=0?String(Math.min(games,9999999)):'--',0x5a0+index*8,7,'utf8');
  }
 }
 return b;
}
export class LobbyServices {
 private busy=false;private stopped=false;private last=0;private sequence=0;private ack=0;private customRegistered='';
 private countdown=new RankedCountdown();
 constructor(private context:HostRoomRequest,private file:string,private now=Date.now,private synchronize:(state:Snapshot)=>Promise<void>=async()=>{}){}
 stop(){this.stopped=true;this.countdown.reset();}
 async tick(sample:unknown){
  if(this.stopped||this.busy||this.now()-this.last<1500)return;this.busy=true;this.last=this.now();
  try{
   const r=sample as {servicesReadOK?:boolean;rankedRequest?:number;rankedRequested?:number};
   if(r.servicesReadOK===true&&Number.isInteger(r.rankedRequest)&&r.rankedRequest!>this.ack&&r.rankedRequest!<=0x7fffffff&&(r.rankedRequested===0||r.rankedRequested===1)){
    await this.request('lobby-options',{roomId:this.context.roomId,rankedRequested:r.rankedRequested===1});this.ack=r.rankedRequest!;
   }
   const native=sample as {currentMapReadOK?:boolean;currentMap?:string;isHost?:boolean;nativeLaunchState?:number[];roster?:{ReadOK?:boolean;Entries?:{Name:string;Team:number;StartPosition:number;AI:boolean;Observer:boolean}[]}};
   if(native.currentMapReadOK===true&&typeof native.currentMap==='string'&&native.isHost===true&&native.nativeLaunchState?.some((v,i)=>i<2&&v===1)&&native.roster?.ReadOK===true){
    const state=await this.request('state'),room=state.room,players=native.roster.Entries;
    if(room&&!room.matchmakingId&&room.nativeHost&&players&&players.length===room.players.length&&players.every(p=>!p.AI&&!p.Observer)){
     const body={runId:room.nativeHost.id,mapId:native.currentMap,players:players.map(p=>({name:p.Name,team:p.Team===-1?9+p.StartPosition:p.Team}))},key=JSON.stringify(body);
     if(key!==this.customRegistered)try{await this.synchronize(state);if(this.stopped)return;await this.request('custom/register',body);this.customRegistered=key;}catch{/* Unrated/AI/incomplete custom games never invent a rating. */}
    }
   }
   const value=await this.request('lobby-balance');if(this.stopped||value.roomId!==this.context.roomId)return;
   const staging=this.countdown.update(value.ladder,sample,this.now());
   const bytes=encodeLobbyServices({...value,ack:this.ack,sample},++this.sequence,staging),temp=this.file+'.'+randomUUID()+'.tmp';
   try{await writeFile(temp,bytes,{flag:'wx',mode:0o600});if(!this.stopped)await rename(temp,this.file);}finally{await rm(temp,{force:true});}
  }catch{this.countdown.reset();/* Existing snapshot expires in the game; never invent ratings when offline. */}finally{this.busy=false;}
 }
 private async request(route:string,body?:object){const r=await fetch(this.context.server+'/api/'+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+this.context.token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(3500),redirect:'error'});if(!r.ok)throw Error('Lobby service unavailable');return r.json();}
}
