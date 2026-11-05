import type {HostRoomRequest,RoomMap,Snapshot,BattleLobbyInfo} from '../shared/model';
import {ownsRoom,roomApi,type RoomApi} from './room-share';
function mapId(value:unknown):string|null{
 if(typeof value!=='string'||value.length>240)return null;
 const id=value.replace(/\\/g,'/').toLowerCase();
 return /^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/.test(id)&&!id.split('/').some(p=>p==='.'||p==='..')?id:null;
}
/** Read-only lobby observations. Publishing never selects a map in the game. */
export class LobbyMapPublisher {
 private candidate='';private count=0;private sampledAt=-Infinity;private stopped=false;
 private sequence=0;private pending:Promise<void>|null=null;private sent='';private lastPublished:string|null=null;
 constructor(private metadata:(id:string)=>RoomMap|null,private request:RoomApi=roomApi,private now=Date.now){}
 ingest(value:unknown){
  const s=value as Record<string,unknown>|null;
  const current=s&&mapId(s.currentMap);
  // Pending initial handoff is not a user selection. Guests and stale frontend
  // state cannot publish a map. Direct selected-map readback is double-read by
  // the existing native reader; require two separate samples here as well.
  if(this.stopped||!s||s.kind!=='sample'||s.readOK!==true||s.visible!==true||s.isHost!==true||(s.transportAdapter===1?s.nativeUdpReady!==true:s.state!==3)||s.currentMapReadOK!==true||!current||s.mapStatus===1||s.mapStatus===2){this.candidate='';this.count=0;return;}
  const at=this.now();if(current!==this.candidate||at-this.sampledAt>4500||at<this.sampledAt){this.candidate=current;this.count=1;}else if(at>this.sampledAt)this.count++;
  this.sampledAt=at;
 }
 current():string|null{return !this.stopped&&this.count>=2&&this.now()-this.sampledAt>=0&&this.now()-this.sampledAt<=4500?this.candidate:null;}
 published():string|null{return this.lastPublished;}
 listing(info:BattleLobbyInfo):BattleLobbyInfo{return {...info,...(info.mapId?{map:this.metadata(info.mapId)??null}:{})};}
 async publish(context:HostRoomRequest,leaseId:string,state:Snapshot){
  // A start request must wait for an in-flight older map, then flush the latest sample.
  while(this.pending)await this.pending;
  const work=this.send(context,leaseId,state);this.pending=work;
  try{await work;}finally{if(this.pending===work)this.pending=null;}
 }
 private async send(context:HostRoomRequest,leaseId:string,state:Snapshot){
  const id=this.current();if(!id||state.features?.lobbyMapSync!==true||!ownsRoom(state,context)||state.room?.nativeHost?.phase==='battle-observed')return;
  try{
   const map=this.metadata(id),key=JSON.stringify([context.server,context.token,context.roomId,leaseId,id,map]);if(key===this.sent)return;
   const sequence=++this.sequence;
   const next=await this.request(context,'lobby-map',{leaseId,sequence,mapId:id,map});
   if(!this.stopped&&ownsRoom(next,context)&&next.room?.observedMap?.id===id){this.sent=key;this.lastPublished=id;}
  }catch{/* A failed display update must not interrupt hosting or its lease. */}
 }
 stop(){this.stopped=true;this.candidate='';this.count=0;this.lastPublished=null;}
}
