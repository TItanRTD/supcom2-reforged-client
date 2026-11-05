import type {HostRoomRequest} from '../shared/model';
import {roomApi,ownsRoom,type RoomApi} from './room-share';
/** Preserve room presence during off-thread work. Publishing still requires a
 * fresh authorized begin after preparation, and never starts from this heartbeat. */
export async function withRoomHeartbeat<T>(context:HostRoomRequest,prepare:()=>Promise<T>,request:RoomApi=roomApi,intervalMs=10000):Promise<T>{
 let busy=false,lost=false;
 const timer=setInterval(()=>{if(busy)return;busy=true;void request(context,'state').then(s=>{if(!ownsRoom(s,context))lost=true;}).catch(()=>{/* Begin validates connectivity and ownership again before publication. */}).finally(()=>{busy=false;});},intervalMs);timer.unref();
 try{const result=await prepare();if(lost)throw Error('Lobby ownership changed while preparing the game. Create a fresh lobby.');return result;}finally{clearInterval(timer);}
}
