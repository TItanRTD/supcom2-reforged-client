import type {HostRoomRequest,NativeHostPhase,Snapshot,BattleLobbyInfo} from '../shared/model';
import {ownsRoom,roomApi,validateHostRoom,transientRoomError,type RoomApi} from './room-share';
export class NativeLobbyObservation {
 private seenAt=0;private count=0;private observedHostLobby=false;private battle=false;private mapConfirmedOnce=false;
 private lobbyInfo:BattleLobbyInfo={};private infoAt=-Infinity;private frozenInfo:BattleLobbyInfo={};
 constructor(private now=Date.now){}
 ingest(value:unknown){const r=value as Record<string,unknown>|null;
  if(!this.battle&&r?.kind==='sample'&&this.observedHostLobby&&r.transportAdapter===1&&Array.isArray(r.nativeManagerState)&&r.nativeManagerState.length===7&&r.nativeManagerState[0]===4){this.frozenInfo=this.listing();this.battle=true;}
  if(!r||r.kind!=='sample'||r.readOK!==true||(r.transportAdapter===1?r.nativeUdpReady!==true:r.state!==3)||r.visible!==true||r.isHost!==true){this.count=0;return;}
  this.count=this.now()-this.seenAt<4500?this.count+1:1;this.seenAt=this.now();if(this.count>=2)this.observedHostLobby=true;
  if(!this.battle){
   const info:BattleLobbyInfo={};
   if((r.currentMapReadOK===true||r.mapReadOK===true)&&typeof r.currentMap==='string'&&r.currentMap.length<=240&&/^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/i.test(r.currentMap)&&!r.currentMap.split('/').some(x=>x==='.'||x==='..'))info.mapId=r.currentMap.toLowerCase();
   const roster=r.roster as {ReadOK?:boolean;Entries?:{Name:string;Team:number;AI:boolean;Observer:boolean}[]}|undefined;
   if(roster?.ReadOK===true&&Array.isArray(roster.Entries)&&roster.Entries.length>0&&roster.Entries.length<=32&&roster.Entries.every(p=>p&&typeof p.Name==='string'&&p.Name.trim().length>0&&p.Name.trim().length<=64&&!/[\x00-\x1f\x7f]/.test(p.Name)&&Number.isInteger(p.Team)&&(p.Team===-1||p.Team>=1&&p.Team<=8)&&typeof p.AI==='boolean'&&typeof p.Observer==='boolean')&&roster.Entries.filter(p=>!p.Observer).length<=8)info.players=roster.Entries.map(p=>({name:p.Name.trim(),team:p.Team,ai:p.AI,observer:p.Observer}));
   if(Buffer.byteLength(JSON.stringify(info))>6000)delete info.players;
   this.lobbyInfo=info;this.infoAt=this.now();
  }
 }
 listing():BattleLobbyInfo{return structuredClone(this.battle?this.frozenInfo:this.now()-this.infoAt<5000?this.lobbyInfo:{});}
 phase(listenerAt:number,mapConfirmed=true):NativeHostPhase{if(this.battle)return 'battle-observed';const fresh=this.count>=2&&this.now()-this.seenAt<4500;if(fresh&&mapConfirmed)this.mapConfirmedOnce=true;if(!mapConfirmed&&!this.mapConfirmedOnce)return 'starting';if(fresh)return 'lobby-observed';return listenerAt>0&&this.now()-listenerAt<8000?'listener-observed':'starting';}
}
/** Room lifecycle only. This class neither connects a guest nor authorizes UDP packets. */
export class NativeRoomHost {
 private context:HostRoomRequest|null=null;private runId='';private playerId='';private epoch=0;
 private timer:NodeJS.Timeout|null=null;private busy=false;private starting=false;
 private lastSuccess=0;
 private message='No Reforged native host test is active.';
 constructor(private phase:()=>NativeHostPhase,private request:RoomApi=roomApi,private listing:()=>BattleLobbyInfo=()=>({}),private observed:(c:HostRoomRequest,leaseId:string,state:Snapshot)=>void=()=>{},private now=Date.now){}
 async begin(input:unknown,startTimer=true):Promise<Snapshot>{
  if(this.context||this.starting)throw Error('A native host test is already active.');this.starting=true;
  const epoch=++this.epoch;let c:HostRoomRequest|null=null,runId='';
  try{
   c=validateHostRoom(input);const before=await this.request(c,'state');
   if(epoch!==this.epoch)throw Error('Native test start cancelled.');
   if(!ownsRoom(before,c))throw Error('Only the current Reforged room host can start the native test.');
   const next=await this.request(c,'native-start',{expectedRunId:null});runId=next.room?.nativeHost?.id??'';
   if(!ownsRoom(next,c)||!runId||next.room!.nativeHost!.joinable!==false||next.room!.nativeHost!.transport!=='native-udp-test')throw Error('The server did not confirm a native host test.');
   if(epoch!==this.epoch)throw Error('Native test start cancelled.');
   this.context=c;this.runId=runId;this.playerId=next.playerId;this.lastSuccess=this.now();this.message='Preparing the native lobby; waiting for game readback.';
   if(startTimer){this.timer=setInterval(()=>void this.tick(),3000);this.timer.unref();}return next;
  }catch(e){if(c&&runId)await this.clear(c,runId);throw e;}finally{this.starting=false;}
 }
 status(){return {active:!!this.context,message:this.message};}
 private async clear(c:HostRoomRequest,id:string){try{await this.request(c,'native-stop',{runId:id});}catch{/* Server expiry removes an unreachable or obsolete run. */}}
 async tick(){if(!this.context||this.busy)return;this.busy=true;const c=this.context,id=this.runId,epoch=this.epoch;
  try{const phase=this.phase(),next=await this.request(c,'native-pulse',{runId:id,phase,...(phase==='battle-observed'?{listing:this.listing()}:{})});if(epoch!==this.epoch){await this.clear(c,id);return;}
   if(!ownsRoom(next,c,this.playerId)||next.room?.nativeHost?.id!==id)throw Error('Native host ownership changed.');
   this.lastSuccess=this.now();
   try{this.observed(c,id,next);}catch{/* Display synchronization cannot revoke the host lease. */}
   this.message=phase==='lobby-observed'?'Your game lobby is published on this server.':phase==='battle-observed'?'Your match is listed as in progress.':'Waiting for the game lobby to become ready before publishing it.';
  }catch(error){if(epoch===this.epoch){if(transientRoomError(error)&&this.now()-this.lastSuccess>=0&&this.now()-this.lastSuccess<12000)this.message='Retrying lobby publication after a temporary server connection failure.';else await this.stop('Lobby publication stopped. Reconnect and create a fresh game lobby.');}}
  finally{this.busy=false;}
 }
 async stop(message='Native host test stopped.'){
  if(this.timer)clearInterval(this.timer);this.timer=null;const c=this.context,id=this.runId;
  this.context=null;this.runId='';this.playerId='';this.epoch++;this.message=message;if(c&&id)await this.clear(c,id);
 }
}
