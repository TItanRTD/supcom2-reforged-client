import {createReadStream} from 'node:fs';
import {open} from 'node:fs/promises';
import {createInflateRaw} from 'node:zlib';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {indexArchive} from './map-assets';
export interface MapScan{status:'clean'|'pending'|'blocked';engine:string;at:string;message:string}
export type MapScanner=(file:string)=>Promise<MapScan>;
const exec=promisify(execFile);
const crcTable=Array.from({length:256},(_,v)=>{for(let i=0;i<8;i++)v=v&1?0xedb88320^(v>>>1):v>>>1;return v>>>0;});
/** Hash actual decompressed member bytes, not ZIP metadata, order or compression.
 * Every member is checksum-validated with a bounded streaming inflate. */
export async function mapContentHash(file:string){
 const archive=await indexArchive(file,true);let total=0;const hashes:{name:string;hash:string;size:number}[]=[];
 if(archive.entries.length>10000)throw Error('Too many map package members.');
 for(const entry of [...archive.entries].sort((a,b)=>a.name.toLowerCase().localeCompare(b.name.toLowerCase(),'en'))){
  if(entry.name.endsWith('/')){if(entry.size)throw Error('Invalid directory entry.');continue;}
  if(!/\.(?:scmap|lua|dds|png|bmp|bdf|raw|scm|sca|wav|ogg|jpe?g|tga|txt|md|json|xml)$/i.test(entry.name))throw Error('Unsupported map package file: '+entry.name);
  if(/\.lua$/i.test(entry.name)&&!/^(?:uncompiled\/)?maps\//i.test(entry.name))throw Error('Map Lua must stay inside its map folder.');
  if(entry.size>512*1024*1024||total+entry.size>2*1024*1024*1024)throw Error('Expanded map package exceeds limits.');
  const handle=await open(file,'r');let offset:number;try{const header=Buffer.alloc(30);await handle.read(header,0,30,entry.offset);offset=entry.offset+30+header.readUInt16LE(26)+header.readUInt16LE(28);}finally{await handle.close();}
  let count=0,crc=0xffffffff;const hash=createHash('sha256');
  if(entry.packed){const source=createReadStream(file,{start:offset,end:offset+entry.packed-1,highWaterMark:256*1024}),stream=entry.method===8?source.pipe(createInflateRaw()):source;
   source.once('error',e=>stream.destroy(e));
   try{for await(const value of stream){const b=Buffer.from(value);count+=b.length;if(count>entry.size||count>512*1024*1024)throw Error('Expanded member exceeds limits.');hash.update(b);for(const v of b)crc=crcTable[(crc^v)&255]^(crc>>>8);}}finally{stream.destroy();source.destroy();}
  }
  if(count!==entry.size||((crc^0xffffffff)>>>0)!==entry.crc)throw Error('Map member checksum mismatch.');total+=count;
  // Documentation changes do not turn a repacked copy into a new map package.
  if(!/\.(txt|md)$/i.test(entry.name))hashes.push({name:entry.name.toLowerCase(),hash:hash.digest('hex'),size:count});
 }
 if(!hashes.length)throw Error('No map assets.');
 return createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
}
/** Fail closed on missing definitions, timeout, scanner errors and scan limits.
 * No shell, archive execution, remediation or externally supplied command. */
export const scanMapPackage:MapScanner=async file=>{
 const at=new Date().toISOString(),program=process.env.S2R_CLAMSCAN??(process.platform==='win32'?'C:\\Program Files\\ClamAV\\clamscan.exe':'clamscan');
 const engine='ClamAV';
 try{
  const {stdout}=await exec(program,['--version'],{timeout:10_000,maxBuffer:16384,windowsHide:true});
  const date=stdout.trim().split('/').slice(2).join('/'),stamp=Date.parse(date);
  if(!Number.isFinite(stamp)||Date.now()-stamp>7*86400_000||stamp>Date.now()+86400_000)return{status:'pending',engine,at,message:'Virus definitions are missing or older than seven days. Update them with freshclam, then rescan.'};
  await exec(program,['--scan-archive=yes','--alert-encrypted=yes','--alert-exceeds-max=yes','--alert-broken=yes','--max-filesize=512M','--max-scansize=2047M','--max-files=10000','--max-recursion=10','--max-scantime=120000','--no-summary','--',file],{timeout:130_000,maxBuffer:512*1024,windowsHide:true});
  return{status:'clean',engine:stdout.trim().slice(0,120),at,message:'Package validation and malware scan passed.'};
 }catch(e){const code=(e as {code?:unknown}).code;return code===1?{status:'blocked',engine,at,message:'The scanner detected a threat, encrypted content, a damaged file or an exceeded scan limit. This package is quarantined.'}:{status:'pending',engine,at,message:'The malware scanner is unavailable or did not finish. This package stays quarantined until a successful rescan.'};}
};
