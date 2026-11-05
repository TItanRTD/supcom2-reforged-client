import {open,stat,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {HostRoomRequest} from '../shared/model';
import {roomApi,type RoomApi} from './room-share';
interface Outcome{name:string;outcome:string;tick:number;faction?:string}
interface ResultJob{matchId:string;winner?:string;events?:Outcome[];server:string;roomId:string}
/** Each participant reports their own retail outcome, plus observations of earlier
 * eliminations. A defeated player can close the game without losing their report. */
export class RankedResultReporter{
 private timer:NodeJS.Timeout|null=null;private inFlight:Promise<void>|null=null;private offset=0;private rest='';private complete=false;private terminal=false;private pending:ResultJob|null=null;private events=new Map<string,Outcome>();private factions=new Map<string,string>();
 constructor(private context:HostRoomRequest,private matchId:string,private gameLog:string,private receipt:string,private localName?:string,private route='matchmaking/report'){}
 start(){if(this.timer||this.complete||this.terminal)return;this.timer=setInterval(()=>void this.tick(),2000);this.timer.unref();void this.tick();}
 tick(final=false):Promise<void>{
  if(this.inFlight)return this.inFlight;
  if(this.complete||this.terminal)return Promise.resolve();
  this.inFlight=this.poll(final).finally(()=>{this.inFlight=null;});return this.inFlight;
 }
 private async poll(final:boolean){try{
  if(!this.pending){const s=await stat(this.gameLog);if(s.size<this.offset){this.offset=0;this.rest='';this.events.clear();this.factions.clear();}if(s.size>this.offset||final&&this.rest){const f=await open(this.gameLog,'r');try{
   do{const bytes=Buffer.alloc(Math.min(256*1024,s.size-this.offset));const {bytesRead}=await f.read(bytes,0,bytes.length,this.offset);this.offset+=bytesRead;const lines=(this.rest+bytes.subarray(0,bytesRead).toString('utf8')).split(/\r?\n/);this.rest=lines.pop()!.slice(-1024);
   if(final&&this.offset>=s.size){lines.push(this.rest);this.rest='';}
   for(const line of lines){
    const start=/S2R_NATIVE_START\|([^|\r\n]{1,24})\|(UEF|CYBRAN|ILLUMINATE)\|/.exec(line);if(start&&!this.factions.has(start[1]))this.factions.set(start[1],start[2]);
    if(this.localName){const m=/S2R_NATIVE_OUTCOME\|(victory|defeat|draw)\|([^|\r\n]{1,24})\|([0-9]{1,7})\|/.exec(line);if(m)this.events.set(m[2],{outcome:m[1],name:m[2],tick:Number(m[3]),...(this.factions.has(m[2])?{faction:this.factions.get(m[2])}:{})});}
    else{const m=/S2R_NATIVE_RESULT\|(victory|defeat|draw)\|([^|\r\n]{1,24})\|([^|\r\n]{1,24})/.exec(line);if(m)this.pending={matchId:this.matchId,winner:m[1]==='draw'?'draw':m[1]==='victory'?m[2]:m[3],server:this.context.server,roomId:this.context.roomId};}
   }
   if(!bytesRead)break;
   }while(final&&this.offset<s.size);
   if(this.localName&&this.events.has(this.localName))this.pending={matchId:this.matchId,events:[...this.events.values()].slice(0,8),server:this.context.server,roomId:this.context.roomId};
   if(this.pending){const temp=this.receipt+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(this.pending),{flag:'wx',mode:0o600});await rename(temp,this.receipt);}
  }finally{await f.close();}}}
  if(this.pending){const {matchId,winner,events}=this.pending;const r=await fetch(this.context.server+'/api/'+this.route,{method:'POST',headers:{Authorization:'Bearer '+this.context.token,'Content-Type':'application/json'},body:JSON.stringify({matchId,...(events?{events}:{winner})}),signal:AbortSignal.timeout(4000),redirect:'error'});if(r.ok){this.complete=true;this.stop();}else if([400,403,409].includes(r.status)){this.terminal=true;this.stop();}}
 }catch{/* Locked logs or a temporarily unavailable server are retried. */}}
 async finish(){this.stop();await this.inFlight;await this.tick(true);if(!this.complete&&!this.terminal){this.start();setTimeout(()=>this.stop(),120000).unref();}}
 stop(){if(this.timer)clearInterval(this.timer);this.timer=null;}
}
/** Preserve the participant's result before removing their room membership. */
export async function finishReportedGame(context:HostRoomRequest,reporter:Pick<RankedResultReporter,'finish'>|null,request:RoomApi=roomApi){
 try{await reporter?.finish();}finally{await request(context,'game-closed',{roomId:context.roomId});}
}
