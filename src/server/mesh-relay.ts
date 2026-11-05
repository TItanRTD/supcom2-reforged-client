import {randomBytes} from 'node:crypto';
import type {IncomingMessage,Server} from 'node:http';
import type {Duplex} from 'node:stream';
import {ApiError} from './lobby';
import type {RelayGrant} from './native-relay';
import {CLIENT_VERSION} from '../shared/model';
import {relayFrame,RELAY_PATH} from './relay-wire';
import {MESH_PATH,MESH_UPGRADE,MESH_LIMIT,MeshDecoder,meshDatagram} from './mesh-wire';
type Ticket=RelayGrant&{token:string;slot:number;expires:number};
type Peer=Ticket&{socket:Duplex;last:number;since:number;bytes:number;packets:number;closed:boolean};
/** Authenticated, addressed peer mesh. Slots remain stable until a run closes. */
export class NativeMeshRelay{
 private tickets=new Map<string,Ticket>();private peers=new Map<string,Peer>();
 private slots=new Map<string,Map<string,number>>();
 constructor(private authorize:(token:string,roomId:unknown,runId:unknown)=>Promise<RelayGrant>,private now=Date.now){}
 private key(run:string,player:string){return run+':'+player;}
 private members(run:string){return [...this.peers.values()].filter(p=>p.runId===run&&!p.closed).sort((a,b)=>a.slot-b.slot);}
 async issue(token:string,body:Record<string,unknown>){
  this.prune();const grant=await this.authorize(token,body.roomId,body.runId);
  if(body.clientVersion!==CLIENT_VERSION)throw new ApiError(409,'Update every Reforged client and this server to '+CLIENT_VERSION+'.');
  if(this.tickets.size>=400)throw new ApiError(503,'Relay is busy.');
  if(this.peers.has(this.key(grant.runId,grant.playerId)))throw new ApiError(409,'This account already has a connected game.');
  if(grant.role==='guest'&&(grant.ready===false||!this.members(grant.runId).some(p=>p.role==='host')))throw new ApiError(409,'Wait for the host’s native lobby.');
  let assignments=this.slots.get(grant.runId);if(!assignments){assignments=new Map();this.slots.set(grant.runId,assignments);}
  let slot=assignments.get(grant.playerId);
  if(slot===undefined){slot=grant.role==='host'?1:Array.from({length:MESH_LIMIT-1},(_,i)=>i+2).find(n=>![...assignments!.values()].includes(n));if(slot===undefined||[...assignments.values()].includes(slot))throw new ApiError(409,'This native run has no free connection slots. Rehost to reset departed slots.');assignments.set(grant.playerId,slot);}
  for(const [id,t]of this.tickets)if(t.runId===grant.runId&&t.playerId===grant.playerId)this.tickets.delete(id);
  const ticket=randomBytes(32).toString('hex');this.tickets.set(ticket,{...grant,token,slot,expires:this.now()+15000});
  return {ticket,role:grant.role,slot,runId:grant.runId,clientVersion:CLIENT_VERSION,transport:MESH_UPGRADE,expiresAt:new Date(this.now()+15000).toISOString()};
 }
 attach(server:Server,allowed:(req:IncomingMessage)=>void){server.on('upgrade',(req,socket,head)=>{if(req.url===MESH_PATH)void this.upgrade(req,socket,head,allowed);else if(req.url!==RELAY_PATH)socket.destroy();});}
 private async upgrade(req:IncomingMessage,socket:Duplex,head:Buffer,allowed:(req:IncomingMessage)=>void){
  socket.on('error',()=>{});
  try{
   allowed(req);if(req.method!=='GET'||req.headers.upgrade?.toLowerCase()!==MESH_UPGRADE||!String(req.headers.connection).toLowerCase().split(/\s*,\s*/).includes('upgrade'))throw new ApiError(400,'Invalid mesh upgrade.');
   const token=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1],id=req.headers['x-s2r-relay-ticket'];if(!token||typeof id!=='string')throw new ApiError(401,'Relay credentials required.');
   const ticket=this.tickets.get(id);this.tickets.delete(id);if(!ticket||ticket.token!==token||ticket.expires<=this.now())throw new ApiError(403,'Relay ticket expired or consumed.');
   const grant=await this.authorize(token,ticket.roomId,ticket.runId);
   if(grant.playerId!==ticket.playerId||grant.role!==ticket.role)throw new ApiError(403,'Relay ownership changed.');
   const key=this.key(grant.runId,grant.playerId);if(this.peers.has(key)||grant.role==='guest'&&!this.members(grant.runId).some(p=>p.role==='host'))throw new ApiError(409,'Relay peer unavailable.');
   if(socket.destroyed)return;
   const peer:Peer={...ticket,socket,last:this.now(),since:this.now(),bytes:0,packets:0,closed:false};this.peers.set(key,peer);
   socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: '+MESH_UPGRADE+'\r\n\r\n');
   const decoder=new MeshDecoder(()=>{throw Error('Client control packets are not accepted');},(slot,data)=>{
    peer.last=this.now();if(peer.last-peer.since>=1000){peer.since=peer.last;peer.bytes=peer.packets=0;}
    peer.bytes+=data.length;if(++peer.packets>8000||peer.bytes>8*1024*1024)throw Error('Relay rate exceeded');
    if(slot===peer.slot)throw Error('Cannot route to self');const target=this.members(peer.runId).find(p=>p.slot===slot);
    if(target)this.send(target,meshDatagram(peer.slot,data));
   },()=>{peer.last=this.now();this.send(peer,relayFrame(3));});
   socket.on('data',chunk=>{try{decoder.push(Buffer.from(chunk));}catch{this.closePeer(peer);}});
   socket.once('close',()=>this.closePeer(peer));socket.once('end',()=>this.closePeer(peer));
   this.notify(peer.runId);if(head.length)try{decoder.push(head);}catch{this.closePeer(peer);}
  }catch(e){if(!socket.destroyed)socket.end(`HTTP/1.1 ${e instanceof ApiError?e.status:403} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}
 }
 private send(p:Peer,data:Buffer){if(p.socket.writableLength>2*1024*1024){this.closePeer(p);return;}p.socket.write(data);}
 private notify(run:string){const members=this.members(run);for(const p of members)this.send(p,relayFrame(2,Buffer.from(JSON.stringify({slot:p.slot,role:p.role,peers:members.map(m=>({slot:m.slot,role:m.role})),transport:MESH_UPGRADE}))));}
 private closePeer(p:Peer){if(p.closed)return;p.closed=true;this.peers.delete(this.key(p.runId,p.playerId));p.socket.destroy();if(p.role==='host'){for(const other of this.members(p.runId))this.closePeer(other);for(const [id,t]of this.tickets)if(t.runId===p.runId)this.tickets.delete(id);this.slots.delete(p.runId);}else this.notify(p.runId);}
 private prune(){for(const [id,t]of this.tickets)if(t.expires<=this.now())this.tickets.delete(id);for(const run of this.slots.keys())if(!this.members(run).length&&![...this.tickets.values()].some(t=>t.runId===run))this.slots.delete(run);}
 async sweep(){this.prune();for(const p of [...this.peers.values()])try{if(this.now()-p.last>30000)throw Error('Relay heartbeat expired');const current=await this.authorize(p.token,p.roomId,p.runId);if(current.playerId!==p.playerId||current.role!==p.role)throw Error('Relay ownership changed');}catch{this.closePeer(p);}}
 close(){this.tickets.clear();for(const p of [...this.peers.values()])this.closePeer(p);this.slots.clear();}
}
