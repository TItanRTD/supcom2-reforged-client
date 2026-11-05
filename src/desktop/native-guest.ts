import { isIPv4 } from 'node:net';
import { PROTOCOL, type HostRoomRequest, type Snapshot } from '../shared/model';
import { validateHostRoom, roomApi, type RoomApi } from './room-share';
export function privateGuestAddress(value:unknown):string {
 if(typeof value!=='string'||!isIPv4(value))throw Error('Enter the host’s private LAN or VPN IPv4 address.');
 const [a,b]=value.split('.').map(Number);
 if(!(a===10||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127))throw Error('The native guest probe is limited to a trusted private LAN or VPN. Public native game transport is not enabled.');
 return value;
}
export async function authorizeNativeGuestProbe(input:unknown,request:RoomApi=roomApi,now=Date.now()):Promise<{context:HostRoomRequest;address:string;runId:string;roomName?:string}> {
 const r=input as {address?:unknown;runId?:unknown}|null,context=validateHostRoom(input),address=privateGuestAddress(r?.address);
 if(typeof r?.runId!=='string'||!/^[a-f0-9-]{36}$/i.test(r.runId))throw Error('Select a current native host test before requesting a guest probe.');
 const s:Snapshot=await request(context,'state'),room=s.room,run=room?.nativeHost;
 if(s.protocol!==PROTOCOL||room?.id!==context.roomId||!room.players.some(p=>p.id===s.playerId)||room.hostId===s.playerId)throw Error('Join the host’s Reforged room as a guest before running this probe.');
 if(room.steamLink||!run||run.id!==r.runId||run.transport!=='native-udp-test'||run.joinable!==false||run.phase!=='lobby-observed'||!Number.isFinite(Date.parse(run.expiresAt))||Date.parse(run.expiresAt)<=now)throw Error('The native host test is missing, stale or not yet observed in a lobby.');
 return {context,address,runId:run.id,roomName:room.name};
}
