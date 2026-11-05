import {relayFrame,RelayDecoder,MAX_DATAGRAM} from './relay-wire';
export const MESH_UPGRADE='s2r-mesh-v1';
export const MESH_PATH='/api/native-mesh/stream';
export const MESH_LIMIT=8;
export interface MeshMember{slot:number;role:'host'|'guest'}
export function meshAddress(slot:number,subnet=16){if(!Number.isInteger(slot)||slot<1||slot>MESH_LIMIT||!Number.isInteger(subnet)||subnet<1||subnet>254)throw Error('Invalid mesh address');return `127.${subnet}.0.${slot}`;}
// A route byte is carried in its own bounded frame immediately before each
// unchanged UDP datagram. This retains the full 65507-byte native UDP limit.
export function meshDatagram(slot:number,data:Buffer){meshAddress(slot);if(!data.length||data.length>MAX_DATAGRAM)throw Error('Invalid mesh datagram');return Buffer.concat([relayFrame(2,Buffer.from([slot])),relayFrame(1,data)]);}
export class MeshDecoder{
 private route:number|null=null;private decoder:RelayDecoder;
 constructor(control:(data:Buffer)=>void,packet:(slot:number,data:Buffer)=>void,heartbeat:()=>void){this.decoder=new RelayDecoder((kind,data)=>{
  if(kind===3){if(this.route!==null)throw Error('Incomplete routed packet');heartbeat();return;}
  if(kind===2&&data.length===1){if(this.route!==null)throw Error('Duplicate route');meshAddress(data[0]);this.route=data[0];return;}
  if(kind===2){if(this.route!==null)throw Error('Incomplete routed packet');control(data);return;}
  if(this.route===null||!data.length)throw Error('Missing packet route');const slot=this.route;this.route=null;packet(slot,data);
 });}
 push(data:Buffer){this.decoder.push(data);}
}
