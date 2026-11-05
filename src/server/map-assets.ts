import {open,lstat,type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {inflateRawSync,deflateSync} from 'node:zlib';
import type {GameMap} from '../shared/model';
export interface Entry { name: string; size: number; packed: number; offset: number; method: number; flags: number; crc: number }
export interface Archive { file: string; entries: Entry[] }
const MAX_ENTRY = 8 * 1024 * 1024;
const crcTable = Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++) n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
export function crc32(b: Buffer) { let n=0xffffffff;for(const v of b)n=crcTable[(n^v)&255]^(n>>>8);return (n^0xffffffff)>>>0; }
async function readAt(h:FileHandle,at:number,size:number) {
  if(!Number.isSafeInteger(at)||at<0||size<0||size>16*1024*1024)throw new Error('Archive bounds exceeded.');
  const b=Buffer.alloc(size);let done=0;
  while(done<size){const r=await h.read(b,done,size-done,at+done);if(!r.bytesRead)throw new Error('Truncated archive.');done+=r.bytesRead;}return b;
}
export async function indexArchive(file:string,strict=false):Promise<Archive>{
  if((await lstat(file)).isSymbolicLink())throw new Error('Linked archives are not scanned.');
  const h=await open(file,'r');try{
    const size=(await h.stat()).size,tail=await readAt(h,Math.max(0,size-65557),Math.min(size,65557));
    let end=-1;for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
    if(end<0||tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6))throw new Error('Unsupported SCD/ZIP index.');
    const count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
    if(count===65535||count>(strict?10000:60000)||length>16*1024*1024||offset+length>size-tail.length+end)throw new Error('Oversized or ZIP64 archive index.');
    const central=await readAt(h,offset,length),entries:Entry[]=[],names=new Set<string>();let p=0;
    for(let i=0;i<count;i++){
      if(p+46>central.length||central.readUInt32LE(p)!==0x02014b50)throw new Error('Invalid archive index.');
      const n=central.readUInt16LE(p+28),extra=central.readUInt16LE(p+30),comment=central.readUInt16LE(p+32);
      if(p+46+n+extra+comment>central.length)throw new Error('Invalid archive name.');
      const name=central.subarray(p+46,p+46+n).toString('utf8').replace(/\\/g,'/');
      const safe=name.length>0&&name.length<512&&!name.startsWith('/')&&!name.split('/').some(x=>x==='..'||x==='.')&&!/[\x00-\x1f:]/.test(name);
      if(strict&&(!safe||names.has(name.toLowerCase())||((central.readUInt32LE(p+38)>>>16)&0xf000)===0xa000||central.readUInt16LE(p+8)&1||![0,8].includes(central.readUInt16LE(p+10))))throw new Error('Unsupported or unsafe map archive entry.');
      if(safe)names.add(name.toLowerCase());
      if(safe)entries.push({name,size:central.readUInt32LE(p+24),packed:central.readUInt32LE(p+20),offset:central.readUInt32LE(p+42),method:central.readUInt16LE(p+10),flags:central.readUInt16LE(p+8),crc:central.readUInt32LE(p+16)});
      p+=46+n+extra+comment;
    }
    if(strict)for(const e of entries){
      const head=await readAt(h,e.offset,30),nameSize=head.readUInt16LE(26),extraSize=head.readUInt16LE(28);
      if(head.readUInt32LE(0)!==0x04034b50||head.readUInt16LE(6)!==e.flags||head.readUInt16LE(8)!==e.method||nameSize>512||e.offset+30+nameSize+extraSize+e.packed>offset)throw new Error('Invalid map archive entry bounds.');
      if((await readAt(h,e.offset+30,nameSize)).toString('utf8').replace(/\\/g,'/')!==e.name)throw new Error('Map archive entry names differ.');
    }
    return {file,entries};
  }finally{await h.close();}
}
export async function readEntry(a:Archive,e:Entry,max=MAX_ENTRY):Promise<Buffer>{
  if(e.size>max||e.packed>MAX_ENTRY||e.flags&1||![0,8].includes(e.method))throw new Error('Unsupported or oversized map asset.');
  const h=await open(a.file,'r');try{
    const head=await readAt(h,e.offset,30);if(head.readUInt32LE(0)!==0x04034b50||head.readUInt16LE(8)!==e.method)throw new Error('Invalid archive entry.');
    const b=await readAt(h,e.offset+30+head.readUInt16LE(26)+head.readUInt16LE(28),e.packed);
    const result=e.method===8?inflateRawSync(b,{maxOutputLength:max}):b;
    if(result.length!==e.size||crc32(result)!==e.crc)throw new Error('Map asset checksum failed.');return result;
  }finally{await h.close();}
}
// Remove Lua comments without evaluating Lua or mistaking comment markers in strings.
export function parseScenario(bytes:Buffer,entryName:string):Omit<GameMap,'archive'|'metadataHash'>|null{
  if(bytes.includes(0)||bytes[0]===27||bytes.length>512*1024)return null;
  const s=bytes.toString('utf8').replace(/(['"])(?:\\[\s\S]|(?!\1)[^\\])*?\1|--\[(=*)\[[\s\S]*?\]\2\]|--[^\r\n]*/g,m=>m.startsWith('--')?' '.repeat(m.length):m);
  if(!/\bScenarioInfo\s*=\s*\{/.test(s))return null;
  const str=(key:string)=>{
    const m=new RegExp('(?:^|[\\s,{])'+key+'\\s*=\\s*([\'\"])((?:\\\\[\\s\\S]|(?!\\1)[^\\\\])*?)\\1','m').exec(s);
    return m?m[2].replace(/\\([\\'"nrt])/g,(_,c)=>({n:'\n',r:'\r',t:'\t'}[c as string]??c)):'';
  };
  const type=str('type').toLowerCase();if(type&&type!=='skirmish')return null;
  const id='/'+entryName.replace(/^uncompiled\//i,'');
  if(id.split('/').some(x=>x==='.'||x==='..')||!/^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/i.test(id))return null;
  const raw=str('name').replace(/<LOC\s+[^>]+>/gi,'').trim();
  const name=(raw||str('devname')||path.posix.basename(id,'_scenario.lua')).slice(0,100);
  const armies=new Set([...s.matchAll(/['"]ARMY_(\d+)['"]/g)].map(m=>Number(m[1])).filter(n=>n>0&&n<=16));
  const size=/\bsize\s*=\s*\{\s*([\d.]+)\s*,\s*([\d.]+)\s*\}/.exec(s),positions=/\bStartPositions\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(s);
  let starts:GameMap['starts'];
  if(size&&positions){
   const width=Number(size[1]),height=Number(size[2]),points=[...positions[1].matchAll(/\[\s*['"]ARMY_(\d+)['"]\s*\]\s*=\s*\{\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*,\s*([\d.eE+-]+)\s*\}/g)].map(m=>({slot:Number(m[1])-1,x:Number(m[2]),z:Number(m[4])})).sort((a,b)=>a.slot-b.slot);
   if(width>0&&height>0&&width<=65536&&height<=65536&&points.length===armies.size&&new Set(points.map(p=>p.slot)).size===points.length&&points.every(p=>armies.has(p.slot+1)&&Number.isFinite(p.x)&&Number.isFinite(p.z)&&p.x>=0&&p.x<=width&&p.z>=0&&p.z<=height))starts={width,height,points};
  }
  return {id,name,players:armies.size||null,terrain:str('map').slice(0,240),...(starts?{starts}:{})};
}
function png(rgba:Buffer,w:number,h:number){
 const chunk=(name:string,data:Buffer)=>{const type=Buffer.from(name),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([len,type,data,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(w);header.writeUInt32BE(h,4);header[8]=8;header[9]=6;
 const scan=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)rgba.copy(scan,y*(w*4+1)+1,y*w*4,(y+1)*w*4);
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
}
export function decodeMapPixels(b:Buffer):{rgba:Buffer;width:number;height:number}|null{
 if(b.length<128||b.toString('ascii',0,4)!=='DDS ')return null;
 const h=b.readUInt32LE(12),w=b.readUInt32LE(16),kind=b.toString('ascii',84,88);
 if(!w||!h||w>2048||h>2048)return null;
 if(!['DXT1','DXT3','DXT5'].includes(kind)){
  const bits=b.readUInt32LE(88),flags=b.readUInt32LE(80);if(!(flags&0x40)||![16,24,32].includes(bits))return null;
  const masks=[92,96,100,104].map(at=>b.readUInt32LE(at)),bytes=bits/8,pitch=b.readUInt32LE(8)&8?b.readUInt32LE(20):w*bytes;
  if(masks.slice(0,3).some(m=>!m)||masks.some(m=>m>2**bits-1)||masks.reduce((v,m)=>v+m,0)!==(masks.reduce((v,m)=>(v|m)>>>0,0))||pitch<w*bytes||128+pitch*h>b.length)return null;
  const outW=Math.min(w,256),outH=Math.min(h,256),rgba=Buffer.alloc(outW*outH*4);
  for(let y=0;y<outH;y++)for(let x=0;x<outW;x++){
   const at=128+Math.floor(y*h/outH)*pitch+Math.floor(x*w/outW)*bytes,value=b.readUIntLE(at,bytes);
   for(let c=0;c<4;c++)rgba[(y*outW+x)*4+c]=masks[c]?Math.round(((value&masks[c])>>>0)*255/masks[c]):255;
  }
  return {rgba,width:outW,height:outH};
 }
 const block=kind==='DXT1'?8:16,bx=Math.ceil(w/4),by=Math.ceil(h/4);
 if(128+bx*by*block>b.length)return null;
 const outW=Math.min(w,256),outH=Math.min(h,256),out=Buffer.alloc(outW*outH*4);
 const colour=(v:number)=>[Math.round(((v>>>11)&31)*255/31),Math.round(((v>>>5)&63)*255/63),Math.round((v&31)*255/31),255];
 for(let y=0;y<outH;y++)for(let x=0;x<outW;x++){
  const sx=Math.floor(x*w/outW),sy=Math.floor(y*h/outH),p=128+(Math.floor(sy/4)*bx+Math.floor(sx/4))*block,cp=p+(block===16?8:0),pixel=(sy%4)*4+sx%4;
  const c0=b.readUInt16LE(cp),c1=b.readUInt16LE(cp+2),a=colour(c0),c=colour(c1);
  const mix=(n:number,d:number)=>a.map((v,i)=>i===3?255:Math.round((v*n+c[i]*(d-n))/d));
  const palette=c0>c1||block===16?[a,c,mix(2,3),mix(1,3)]:[a,c,mix(1,2),[0,0,0,0]];
  const rgba=[...palette[(b.readUInt32LE(cp+4) >>> (pixel*2))&3]];
  if(kind==='DXT3')rgba[3]=((b[p+Math.floor(pixel/2)]>>>((pixel%2)*4))&15)*17;
  if(kind==='DXT5'){
   const aa=[b[p],b[p+1]];if(aa[0]>aa[1])for(let k=1;k<=6;k++)aa.push(Math.round(((7-k)*aa[0]+k*aa[1])/7));
   else{for(let k=1;k<=4;k++)aa.push(Math.round(((5-k)*aa[0]+k*aa[1])/5));aa.push(0,255);}
   const bits=b.readUIntLE(p+2,6);rgba[3]=aa[Math.floor(bits/2**(pixel*3))&7];
  }
  out.set(rgba,(y*outW+x)*4);
 }
 return {rgba:out,width:outW,height:outH};
}
export function decodeMapPreview(b:Buffer):string|null{const image=decodeMapPixels(b);return image?'data:image/png;base64,'+png(image.rgba,image.width,image.height).toString('base64'):null;}
