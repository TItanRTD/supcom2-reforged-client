import http from 'node:http';
import https from 'node:https';
import {createSocket,type Socket as UdpSocket} from 'node:dgram';
import type {Duplex} from 'node:stream';
import {validateHostRoom} from './room-share';
import {CLIENT_VERSION} from '../shared/model';
import type {RelayStatus} from './native-relay';
import {relayFrame} from '../server/relay-wire';
import {MESH_PATH,MESH_UPGRADE,MESH_LIMIT,MeshDecoder,meshAddress,meshDatagram,type MeshMember} from '../server/mesh-wire';
export class NativeMeshRelayClient{
 private stream:Duplex|null=null;private proxies=new Map<number,UdpSocket>();private timer:NodeJS.Timeout|null=null;private epoch=0;
 private value:RelayStatus&{slot?:number;peers?:number}={active:false,paired:false,sent:0,received:0,delivered:0,dropped:0,queued:0,message:'Independent mesh is idle.'};
 // A separate loopback subnet permits socket integration tests to model PCs
 // in one process. Production uses the same canonical subnet on every PC.
 constructor(private subnet=16,private hostGamePort=16010){}
 status(){return {...this.value};}
 async start(input:unknown,runId:string,role:'host'|'guest',progress?:(stage:string)=>Promise<void>){
  this.stop();const epoch=this.epoch,context=validateHostRoom(input),url=new URL(context.server);
  if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('Invalid native run.');
  if(url.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Independent relay requires HTTPS outside this PC.');
  await progress?.('requesting-relay-ticket');
  const response=await fetch(new URL('/api/native-mesh/ticket',url),{method:'POST',headers:{Authorization:'Bearer '+context.token,'Content-Type':'application/json'},body:JSON.stringify({roomId:context.roomId,runId,clientVersion:CLIENT_VERSION}),signal:AbortSignal.timeout(10000),redirect:'error'});
  const body=await response.json() as Record<string,unknown>;
  if(!response.ok)throw Error(typeof body.error==='string'?body.error:'Update the Reforged server to enable multiplayer routing.');
  if(body.clientVersion!==CLIENT_VERSION||body.transport!==MESH_UPGRADE||body.role!==role||body.runId!==runId||typeof body.ticket!=='string'||!/^[a-f0-9]{64}$/.test(body.ticket)||!Number.isInteger(body.slot))throw Error('Update all clients and the server to '+CLIENT_VERSION+'.');
  const slot=body.slot as number;meshAddress(slot);if((slot===1)!==(role==='host'))throw Error('Invalid relay role.');
  if(epoch!==this.epoch)throw Error('Relay start cancelled.');
  let gamePeer:{address:string;port:number}|null=role==='host'?{address:'127.0.0.1',port:this.hostGamePort}:null;
  const binding=new Map<number,Promise<void>>();
  const members=new Set<number>(),pending:{direction:'local'|'remote';slot:number;data:Buffer;at:number}[]=[];
  const queue=(direction:'local'|'remote',remote:number,data:Buffer)=>{if(pending.length>=64||pending.reduce((n,p)=>n+p.data.length,0)+data.length>524288){this.value.dropped++;return;}pending.push({direction,slot:remote,data:Buffer.from(data),at:Date.now()});this.value.queued=pending.length;};
  const send=(data:Buffer)=>{if(!this.stream)return;if(this.stream.writableLength>2*1024*1024){this.stop('Relay connection is congested.');return;}this.stream.write(data);};
  const deliver=(remote:number,data:Buffer)=>{const proxy=this.proxies.get(remote);if(!members.has(remote)||!proxy||!gamePeer){queue('remote',remote,data);return;}proxy.send(data,gamePeer.port,gamePeer.address,error=>{if(epoch!==this.epoch)return;if(error)this.value.dropped++;else{this.value.delivered++;this.value.firstDeliveryAt??=new Date().toISOString();}});};
  const flush=()=>{const queued=pending.splice(0);this.value.queued=0;for(const p of queued){if(Date.now()-p.at>5000){this.value.dropped++;continue;}if(p.direction==='local'){if(members.has(p.slot)){this.value.sent++;send(meshDatagram(p.slot,p.data));}else queue(p.direction,p.slot,p.data);}else deliver(p.slot,p.data);}};
  const bind=async(remote:number)=>{
   if(epoch!==this.epoch)throw Error('Relay start cancelled.');
   const existing=binding.get(remote);if(existing)return existing;
   const udp=createSocket('udp4');this.proxies.set(remote,udp);
   udp.on('error',()=>{if(epoch===this.epoch)this.stop('Local participant relay socket failed. Close the game and try again.');});
   const ready=new Promise<void>((resolve,reject)=>{const closed=()=>reject(Error('Relay start cancelled.'));const failed=(e:Error)=>{udp.off('close',closed);reject(e);};udp.once('close',closed);udp.once('error',failed);udp.bind(16011,meshAddress(remote,this.subnet),()=>{udp.off('error',failed);udp.off('close',closed);resolve();});});binding.set(remote,ready);await ready;
   if(epoch!==this.epoch)throw Error('Relay start cancelled.');
   udp.on('message',(data,peer)=>{
    if(epoch!==this.epoch||peer.address!=='127.0.0.1')return;
    if(!gamePeer){gamePeer={address:peer.address,port:peer.port};this.value.gamePort=peer.port;}
    if(peer.port!==gamePeer.port){this.value.dropped++;return;}
    this.value.firstGamePacketAt??=new Date().toISOString();flush();if(members.has(remote)){this.value.sent++;send(meshDatagram(remote,data));}else queue('local',remote,data);
   });
  };
  try{
   await progress?.('connecting-relay-stream');
   const tunnel=await new Promise<{socket:Duplex;head:Buffer}>((resolve,reject)=>{
    const request=(url.protocol==='https:'?https:http).request(new URL(MESH_PATH,url),{method:'GET',headers:{Authorization:'Bearer '+context.token,'X-S2R-Relay-Ticket':body.ticket as string,Connection:'Upgrade',Upgrade:MESH_UPGRADE},timeout:10000});
    request.once('error',reject);request.once('timeout',()=>request.destroy(Error('Relay connection timed out.')));
    request.once('response',r=>{r.resume();reject(Error('Server rejected the multiplayer relay.'));});
    request.once('upgrade',(r,socket,head)=>{if(r.statusCode!==101||r.headers.upgrade!==MESH_UPGRADE){socket.destroy();reject(Error('Invalid relay upgrade.'));return;}request.setTimeout(0);resolve({socket,head});});request.end();
   });
   if(epoch!==this.epoch){tunnel.socket.destroy();throw Error('Relay start cancelled.');}
   this.stream=tunnel.socket;this.value={active:true,paired:false,sent:0,received:0,delivered:0,dropped:0,queued:0,runId,role,slot,peers:1,localPort:16011,...(gamePeer?{gamePort:gamePeer.port}:{}),message:'Independent relay connected; waiting for participants.'};
   let last=Date.now(),serial:Promise<void>=Promise.resolve();
   const controls=async(data:Buffer)=>{
    if(epoch!==this.epoch)throw Error('Relay start cancelled.');
    const value=JSON.parse(data.toString()) as {slot:number;role:string;transport:string;peers:MeshMember[]};
    if(value.slot!==slot||value.role!==role||value.transport!==MESH_UPGRADE||!Array.isArray(value.peers)||value.peers.length<1||value.peers.length>MESH_LIMIT||new Set(value.peers.map(p=>p.slot)).size!==value.peers.length||!value.peers.some(p=>p.slot===slot&&p.role===role))throw Error('Invalid relay membership');
    for(const p of value.peers){meshAddress(p.slot);if((p.slot===1)!==(p.role==='host'))throw Error('Invalid participant role');}
    const next=new Set(value.peers.filter(p=>p.slot!==slot).map(p=>p.slot));
    for(const old of members)if(!next.has(old)){members.delete(old);this.proxies.get(old)?.close();this.proxies.delete(old);binding.delete(old);for(let i=pending.length-1;i>=0;i--)if(pending[i].slot===old){pending.splice(i,1);this.value.dropped++;}}
    for(const remote of next){await bind(remote);members.add(remote);}
    this.value.peers=value.peers.length;this.value.paired=members.size>0;this.value.message=this.value.paired?`${value.peers.length} Reforged participants connected.`:'Independent relay connected; waiting for participants.';flush();
   };
   const decoder=new MeshDecoder(data=>{serial=serial.then(()=>controls(data)).catch(()=>{if(epoch===this.epoch)this.stop('Invalid relay membership or unavailable local endpoint.');});},(remote,data)=>{last=Date.now();if(remote===slot)throw Error('Invalid source participant');this.value.received++;this.value.firstRemotePacketAt??=new Date().toISOString();deliver(remote,data);},()=>{last=Date.now();});
   tunnel.socket.on('data',data=>{if(epoch!==this.epoch)return;try{decoder.push(Buffer.from(data));}catch{this.stop('Relay received an invalid packet.');}});
   tunnel.socket.once('error',()=>{if(epoch===this.epoch)this.stop('Independent relay connection failed.');});tunnel.socket.once('close',()=>{if(epoch===this.epoch)this.stop('Independent relay disconnected. Close the game before trying again.');});
   if(tunnel.head.length)decoder.push(tunnel.head);
   // Establish the canonical host proxy before launching a joining game.
   if(role==='guest')await bind(1);
   this.timer=setInterval(()=>{if(Date.now()-last>30000){this.stop('Independent relay heartbeat expired.');return;}flush();send(relayFrame(3));},5000);this.timer.unref();
   await serial;if(epoch!==this.epoch)throw Error('Relay start cancelled.');await progress?.('relay-connected');
  }catch(e){if(epoch===this.epoch)this.stop('Independent multiplayer relay could not start.');throw e;}
 }
 stop(message='Independent relay stopped.'){
  this.epoch++;if(this.timer)clearInterval(this.timer);this.timer=null;const stream=this.stream;this.stream=null;stream?.destroy();for(const udp of this.proxies.values())try{udp.close();}catch{}this.proxies.clear();this.value={...this.value,active:false,paired:false,queued:0,message};
 }
}
