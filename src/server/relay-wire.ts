/** Length-delimited packets on the authenticated HTTP upgrade tunnel. */
export const RELAY_UPGRADE='s2r-native-v1';
export const RELAY_PATH='/api/native-relay/stream';
export const MAX_DATAGRAM=65507;
export function relayFrame(kind:1|2|3,body:Uint8Array=Buffer.alloc(0)):Buffer{
 if(body.byteLength>MAX_DATAGRAM||kind===2&&body.byteLength>2048||kind===3&&body.byteLength)throw Error('Invalid relay frame');
 const out=Buffer.alloc(body.byteLength+3);out[0]=kind;out.writeUInt16BE(body.byteLength,1);out.set(body,3);return out;
}
export class RelayDecoder{
 private pending=Buffer.alloc(0);
 constructor(private receive:(kind:1|2|3,body:Buffer)=>void){}
 push(chunk:Buffer){
  // Process bounded slices: a TCP read can contain several maximum-size packets.
  for(let at=0;at<chunk.length;at+=65536){
   this.pending=Buffer.concat([this.pending,chunk.subarray(at,at+65536)]);
   let used=0;
   while(this.pending.length-used>=3){const kind=this.pending[used],length=this.pending.readUInt16BE(used+1);
    if(![1,2,3].includes(kind)||length>MAX_DATAGRAM||kind===2&&length>2048||kind===3&&length)throw Error('Invalid relay frame');
    if(this.pending.length-used<length+3)break;
    this.receive(kind as 1|2|3,Buffer.from(this.pending.subarray(used+3,used+3+length)));used+=length+3;
   }
   this.pending=Buffer.from(this.pending.subarray(used));
   if(this.pending.length>MAX_DATAGRAM+3)throw Error('Relay frame overflow');
  }
 }
}
