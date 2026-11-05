import {randomBytes} from 'node:crypto';
import type {IncomingMessage,Server} from 'node:http';
import type {Duplex} from 'node:stream';
import {ApiError} from './lobby';
import {RELAY_PATH,RELAY_UPGRADE,relayFrame,RelayDecoder} from './relay-wire';
import {CLIENT_VERSION} from '../shared/model';
export interface RelayGrant{roomId:string;runId:string;playerId:string;role:'host'|'guest';ready?:boolean}
type Ticket=RelayGrant&{token:string;expires:number};
type Peer=Ticket&{socket:Duplex;last:number;since:number;bytes:number;packets:number;closed:boolean};
/** First independent transport: exactly one host and one guest per native run. */
export class NativeRelay{
 private tickets=new Map<string,Ticket>();private peers=new Map<string,Peer>();
 constructor(private authorize:(token:string,roomId:unknown,runId:unknown)=>Promise<RelayGrant>,private now=Date.now){}
 async issue(token:string,body:Record<string,unknown>){
  this.prune();const grant=await this.authorize(token,body.roomId,body.runId);
  if(body.clientVersion!==CLIENT_VERSION)throw new ApiError(409,'Update both Reforged clients and this server to '+CLIENT_VERSION+' before joining an independent game.');
  if(this.tickets.size>=400)throw new ApiError(503,'Relay is busy. Try again shortly.');
  const key=grant.runId+':'+grant.role,other=this.peers.get(key);
  if(other)throw new ApiError(409,'This native relay role is already connected. Close that game first.');
  if(grant.role==='guest'&&grant.ready===false)throw new ApiError(409,'Wait for the host’s native lobby.');
  if(grant.role==='guest'&&!this.peers.has(grant.runId+':host'))throw new ApiError(409,'Wait for the host relay to connect.');
  // At most one outstanding ticket per account/run; do not expose credentials in URLs.
  for(const [k,t]of this.tickets)if(t.playerId===grant.playerId&&t.runId===grant.runId)this.tickets.delete(k);
  const ticket=randomBytes(32).toString('hex');this.tickets.set(ticket,{...grant,token,expires:this.now()+15000});
  return {ticket,role:grant.role,runId:grant.runId,clientVersion:CLIENT_VERSION,expiresAt:new Date(this.now()+15000).toISOString(),transport:RELAY_UPGRADE};
 }
 attach(server:Server,allowed:(req:IncomingMessage)=>void){
  server.on('upgrade',(req,socket,head)=>{if(req.url!==RELAY_PATH)return;void this.upgrade(req,socket,head,allowed);});
 }
 private async upgrade(req:IncomingMessage,socket:Duplex,head:Buffer,allowed:(req:IncomingMessage)=>void){
  socket.on('error',()=>{});
  try{
   allowed(req);
   if(req.method!=='GET'||req.url!==RELAY_PATH||req.headers.upgrade?.toLowerCase()!==RELAY_UPGRADE||!String(req.headers.connection).toLowerCase().split(/\s*,\s*/).includes('upgrade'))throw new ApiError(400,'Invalid relay upgrade.');
   const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1],ticket=req.headers['x-s2r-relay-ticket'];
   if(!token||typeof ticket!=='string'||!/^([a-f0-9]{64})$/.test(ticket))throw new ApiError(401,'Relay credentials required.');
   const pending=this.tickets.get(ticket);this.tickets.delete(ticket);
   if(!pending||pending.token!==token||pending.expires<=this.now())throw new ApiError(403,'Relay ticket expired or consumed.');
   const grant=await this.authorize(token,pending.roomId,pending.runId);
   if(grant.playerId!==pending.playerId||grant.role!==pending.role)throw new ApiError(403,'Relay ownership changed.');
   const key=grant.runId+':'+grant.role;
   if(this.peers.has(key)||grant.role==='guest'&&!this.peers.has(grant.runId+':host'))throw new ApiError(409,'Relay peer is unavailable or already connected.');
   if(socket.destroyed)return;
   const peer:Peer={...pending,socket,last:this.now(),since:this.now(),bytes:0,packets:0,closed:false};this.peers.set(key,peer);
   socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: '+RELAY_UPGRADE+'\r\n\r\n');
   const decoder=new RelayDecoder((kind,data)=>{
    peer.last=this.now();if(peer.last-peer.since>=1000){peer.since=peer.last;peer.bytes=peer.packets=0;}
    peer.bytes+=data.length;if(++peer.packets>2000||peer.bytes>2*1024*1024)throw Error('Relay rate exceeded');
    if(kind===3){this.send(peer,relayFrame(3));return;}
    if(kind!==1)throw Error('Client control packets are not accepted');
    const other=this.other(peer);if(other)this.send(other,relayFrame(1,data));
   });
   socket.on('data',chunk=>{try{decoder.push(Buffer.from(chunk));}catch{this.closePeer(peer);}});
   socket.once('close',()=>this.closePeer(peer));socket.once('end',()=>this.closePeer(peer));
   this.notify(peer);const other=this.other(peer);if(other)this.notify(other);
   if(head.length)try{decoder.push(head);}catch{this.closePeer(peer);}
  }catch(e){const status=e instanceof ApiError?e.status:403;if(!socket.destroyed)socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}
 }
 private other(p:Peer){return this.peers.get(p.runId+':'+(p.role==='host'?'guest':'host'));}
 private send(p:Peer,frame:Buffer){if(p.socket.writableLength>1024*1024){this.closePeer(p);return;}p.socket.write(frame);}
 private notify(p:Peer){this.send(p,relayFrame(2,Buffer.from(JSON.stringify({paired:!!this.other(p),role:p.role,transport:RELAY_UPGRADE}))));}
 private closePeer(p:Peer){if(p.closed)return;p.closed=true;this.peers.delete(p.runId+':'+p.role);p.socket.destroy();const other=this.other(p);if(other){if(p.role==='host')this.closePeer(other);else this.notify(other);}}
 private prune(){for(const [k,t]of this.tickets)if(t.expires<=this.now())this.tickets.delete(k);}
 async sweep(){this.prune();for(const p of [...this.peers.values()])try{
   if(this.now()-p.last>30000)throw Error('Relay heartbeat expired');
   const current=await this.authorize(p.token,p.roomId,p.runId);if(current.playerId!==p.playerId||current.role!==p.role)throw Error('Relay ownership changed');
  }catch{this.closePeer(p);}}
 close(){this.tickets.clear();for(const p of [...this.peers.values()])this.closePeer(p);}
}
