import http from 'node:http';
import https from 'node:https';
import {createSocket,type Socket as UdpSocket} from 'node:dgram';
import type {Duplex} from 'node:stream';
import {RELAY_PATH,RELAY_UPGRADE,relayFrame,RelayDecoder} from '../server/relay-wire';
import {validateHostRoom} from './room-share';
import {CLIENT_VERSION} from '../shared/model';
export interface RelayStatus{active:boolean;paired:boolean;sent:number;received:number;message:string;runId?:string;role?:'host'|'guest';localPort?:number;gamePort?:number;delivered:number;dropped:number;queued:number;firstGamePacketAt?:string;firstRemotePacketAt?:string;firstDeliveryAt?:string}
export class NativeRelayClient{
 private socket:Duplex|null=null;private udp:UdpSocket|null=null;private timer:NodeJS.Timeout|null=null;private epoch=0;
 private value:RelayStatus={active:false,paired:false,sent:0,received:0,delivered:0,dropped:0,queued:0,message:'Independent relay is idle.'};
 status(){return {...this.value};}
 async start(input:unknown,runId:string,role:'host'|'guest',progress?:(stage:string)=>Promise<void>){
  this.stop();const epoch=this.epoch,context=validateHostRoom(input),url=new URL(context.server);
  if(!/^[a-f0-9-]{36}$/.test(runId))throw Error('Invalid native run.');
  if(url.protocol!=='https:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Independent relay requires HTTPS outside this PC.');
  await progress?.('requesting-relay-ticket');
  const response=await fetch(new URL('/api/native-relay/ticket',url),{method:'POST',headers:{Authorization:'Bearer '+context.token,'Content-Type':'application/json'},body:JSON.stringify({roomId:context.roomId,runId,clientVersion:CLIENT_VERSION}),signal:AbortSignal.timeout(10000),redirect:'error'});
  const body=await response.json() as Record<string,unknown>;
  if(response.status===404)throw Error('Upgrade the managed Reforged server to 0.17.0 before starting independent multiplayer.');
  if(!response.ok)throw Error(typeof body.error==='string'?body.error:'Upgrade the Reforged server to enable the independent relay.');
  if(body.clientVersion!==CLIENT_VERSION)throw Error('Update the Reforged server and both clients to '+CLIENT_VERSION+' before joining an independent game.');
  if(body.transport!==RELAY_UPGRADE||body.role!==role||body.runId!==runId||typeof body.ticket!=='string'||!/^([a-f0-9]{64})$/.test(body.ticket))throw Error('Server returned an invalid relay ticket.');
  if(epoch!==this.epoch)throw Error('Relay start cancelled.');
  const udp=createSocket('udp4');this.udp=udp;
  let gamePeer:{address:string;port:number}|null=null;
  udp.on('error',()=>{if(epoch===this.epoch)this.stop('Local game relay socket failed. Close the game and try again.');});
  try{
   await progress?.('binding-local-relay');
   await new Promise<void>((resolve,reject)=>{udp.once('error',reject);udp.bind(role==='guest'?16011:0,'127.0.0.1',()=>{udp.off('error',reject);resolve();});});
   if(role==='host')await new Promise<void>((resolve,reject)=>{udp.once('error',reject);udp.connect(16010,'127.0.0.1',()=>{udp.off('error',reject);resolve();});});
   if(epoch!==this.epoch)throw Error('Relay start cancelled.');
   await progress?.('connecting-relay-stream');
   const tunnel=await new Promise<{socket:Duplex;head:Buffer}>((resolve,reject)=>{
    const request=(url.protocol==='https:'?https:http).request(new URL(RELAY_PATH,url),{method:'GET',headers:{Authorization:'Bearer '+context.token,'X-S2R-Relay-Ticket':body.ticket as string,Connection:'Upgrade',Upgrade:RELAY_UPGRADE},timeout:10000});
    request.once('error',reject);request.once('timeout',()=>request.destroy(Error('Relay connection timed out.')));
    request.once('response',r=>{r.resume();reject(Error('The server rejected the relay connection. Upgrade the managed server and sign in again.'));});
    request.once('upgrade',(r,socket,head)=>{if(r.statusCode!==101||r.headers.upgrade!==RELAY_UPGRADE){socket.destroy();reject(Error('Invalid relay upgrade.'));return;}request.setTimeout(0);resolve({socket,head});});request.end();
   });
   if(epoch!==this.epoch){tunnel.socket.destroy();throw Error('Relay start cancelled.');}
   this.socket=tunnel.socket;this.value={active:true,paired:false,sent:0,received:0,delivered:0,dropped:0,queued:0,runId,role,localPort:(udp.address() as {port:number}).port,...(role==='host'?{gamePort:16010}:{}),message:'Independent relay connected; waiting for the other player.'};let last=Date.now();
   const send=(kind:1|3,data?:Buffer)=>{if(tunnel.socket.writableLength>1024*1024){this.stop('Relay connection is congested.');return;}tunnel.socket.write(relayFrame(kind,data));};
   // The tunnel may pair after a game's first packet, or the host may speak
   // before the guest's UDP endpoint is known. Previously both were silently
   // discarded. Keep bounded, short-lived startup datagrams in original order.
   const pending:{direction:'local'|'remote';data:Buffer;at:number}[]=[];let pairedOnce=false;
   const queue=(direction:'local'|'remote',data:Buffer)=>{
    const bytes=pending.reduce((n,p)=>n+p.data.length,0);
    if(pending.length>=32||bytes+data.length>262144){this.value.dropped++;return;}
    pending.push({direction,data:Buffer.from(data),at:Date.now()});this.value.queued=pending.length;
   };
   const deliver=(data:Buffer)=>{
    const done=(error:Error|null)=>{if(epoch!==this.epoch)return;if(error){this.value.dropped++;return;}this.value.delivered++;this.value.firstDeliveryAt??=new Date().toISOString();};
    if(role==='host')udp.send(data,done);else if(gamePeer)udp.send(data,gamePeer.port,gamePeer.address,done);
   };
   const flush=()=>{
    for(let i=0;i<pending.length;){const p=pending[i];
     if(Date.now()-p.at>5000){pending.splice(i,1);this.value.dropped++;continue;}
     if(p.direction==='local'&&this.value.paired){pending.splice(i,1);this.value.sent++;send(1,p.data);continue;}
     if(p.direction==='remote'&&(role==='host'||gamePeer)){pending.splice(i,1);deliver(p.data);continue;}i++;
    }this.value.queued=pending.length;
   };
   const decoder=new RelayDecoder((kind,data)=>{
    last=Date.now();if(kind===3)return;
    if(kind===2){const control=JSON.parse(data.toString());if(typeof control.paired!=='boolean'||control.role!==role)throw Error('Invalid relay status');this.value.paired=control.paired;this.value.message=control.paired?'Both Reforged relays connected. Confirm the actual game lobby and match.':'Independent relay connected; waiting for the other player.';if(control.paired){pairedOnce=true;flush();}else if(pairedOnce){this.value.dropped+=pending.length;pending.length=0;this.value.queued=0;}return;}
    this.value.received++;this.value.firstRemotePacketAt??=new Date().toISOString();if(role==='guest'&&!gamePeer)queue('remote',data);else deliver(data);
   });
   tunnel.socket.on('data',chunk=>{if(epoch!==this.epoch)return;try{decoder.push(Buffer.from(chunk));}catch{this.stop('Relay received an invalid packet.');}});
   tunnel.socket.once('error',()=>{if(epoch===this.epoch)this.stop('Independent relay connection failed.');});
   tunnel.socket.once('close',()=>{if(epoch===this.epoch)this.stop('Independent relay disconnected. Close the game before trying again.');});
   udp.on('message',(data,peer)=>{
    if(epoch!==this.epoch||peer.address!=='127.0.0.1')return;
    if(role==='guest'){if(!gamePeer){gamePeer={address:peer.address,port:peer.port};this.value.gamePort=peer.port;}if(peer.port!==gamePeer.port){this.value.dropped++;return;}}
    this.value.firstGamePacketAt??=new Date().toISOString();
    flush();if(this.value.paired){this.value.sent++;send(1,data);}else if(!pairedOnce)queue('local',data);else this.value.dropped++;
   });
   if(tunnel.head.length)decoder.push(tunnel.head);
   this.timer=setInterval(()=>{if(Date.now()-last>30000){this.stop('Independent relay heartbeat expired.');return;}flush();send(3);},5000);this.timer.unref();
   await progress?.('relay-connected');
  }catch(e){if(epoch===this.epoch)this.stop('Independent relay could not start.');throw e;}
 }
 stop(message='Independent relay stopped.'){
  this.epoch++;if(this.timer)clearInterval(this.timer);this.timer=null;const socket=this.socket,udp=this.udp;this.socket=null;this.udp=null;
  socket?.destroy();try{udp?.close();}catch{}this.value={...this.value,active:false,paired:false,queued:0,message};
 }
}
