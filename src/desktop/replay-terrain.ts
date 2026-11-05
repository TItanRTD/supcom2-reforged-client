import {lstat,open,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {indexArchive,readEntry,decodeMapPixels} from '../server/map-assets';
import {replayHeader,REPLAY_LIMIT} from '../server/community';
export interface ReplayTerrain{map:string;name:string;data:Buffer;sha256:string;source:string;embedded:boolean}
export function terrainMap(value:unknown):string|undefined{
 if(typeof value!=='string')return;
 const map=value.replaceAll('\\','/').toLowerCase().replace(/_scenario\.lua$/,'.scmap');
 return /^\/maps\/[a-z0-9_ .()\[\]-]{1,120}\/[a-z0-9_ .()\[\]-]{1,120}\.scmap$/.test(map)&&!map.split('/').some(s=>s==='.'||s==='..')?map:undefined;
}
export function terrainTextureName(map:string){const key=terrainMap(map);if(!key)throw Error('Invalid replay terrain map.');return 'textures/ui/common/pc/ingame/hud/rft_'+key.slice(1).replace(/\.scmap$/,'.minimap.dds').replace(/[^a-z0-9_]/g,'_')+'.dds';}
export async function replayTerrainMap(file:string){
 const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>REPLAY_LIMIT)throw Error('Invalid replay terrain source.');
 const h=await open(file,'r');try{const b=Buffer.alloc(Math.min(s.size,1_048_576));const {bytesRead}=await h.read(b,0,b.length,0);const header=b.subarray(0,bytesRead);if(!replayHeader(header))throw Error('Invalid replay header.');
  for(const match of header.toString('latin1').matchAll(/\/maps\/[A-Za-z0-9_ .()\[\]-]{1,120}\/[A-Za-z0-9_ .()\[\]-]{1,120}(?:\.scmap|_scenario\.lua)/gi)){const map=terrainMap(match[0]);if(map)return map;}
 }finally{await h.close();}
}
/** Re-encode an actual installed preview as an opaque, ordinary Maui DDS.
 * Copying pixels into the probe provides both a physical archive member and a
 * real UI index entry; aliases to platform map resources are not relied on. */
export function terrainDdsLegacy(source:Buffer):Buffer|null{
 const image=decodeMapPixels(source);if(!image)return null;
 const {width,height,rgba}=image,h=Buffer.alloc(128);h.write('DDS ');
 for(const [at,value]of [[4,124],[8,0x100f],[12,height],[16,width],[20,width*4],[76,32],[80,0x41],[88,32],[92,0xff0000],[96,0xff00],[100,0xff],[104,0xff000000],[108,0x1000]])h.writeUInt32LE(value,at);
 const pixels=Buffer.alloc(width*height*4);for(let at=0;at<pixels.length;at+=4){pixels[at]=rgba[at+2];pixels[at+1]=rgba[at+1];pixels[at+2]=rgba[at];pixels[at+3]=255;}
 return Buffer.concat([h,pixels]);
}
/** Maui's image resource loader accepts the DXT5 UI format used by shipped art.
 * Alpha is opaque. RGB565 blocks retain local preview colour without a GPU or
 * native dependency; only this tiny presentation copy is recompressed. */
export function terrainDds(source:Buffer):Buffer|null{
 const image=decodeMapPixels(source);if(!image)return null;
 const {width,height,rgba}=image,blocksX=Math.ceil(width/4),blocksY=Math.ceil(height/4);
 const data=Buffer.alloc(128+blocksX*blocksY*16);data.write('DDS ');
 for(const [at,n]of [[4,124],[8,0x81007],[12,height],[16,width],[20,blocksX*blocksY*16],[76,32],[80,4],[108,0x1000]])data.writeUInt32LE(n,at);
 data.write('DXT5',84);
 const pack=(v:number[])=>Math.round(v[0]*31/255)<<11|Math.round(v[1]*63/255)<<5|Math.round(v[2]*31/255);
 const unpack=(v:number)=>[Math.round((v>>11)*255/31),Math.round((v>>5&63)*255/63),Math.round((v&31)*255/31)];
 for(let by=0;by<blocksY;by++)for(let bx=0;bx<blocksX;bx++){
  const pixels:number[][]=[],lo=[255,255,255],hi=[0,0,0];
  for(let y=0;y<4;y++)for(let x=0;x<4;x++){
   const at=(Math.min(height-1,by*4+y)*width+Math.min(width-1,bx*4+x))*4,p=[rgba[at],rgba[at+1],rgba[at+2]];pixels.push(p);
   for(let c=0;c<3;c++){lo[c]=Math.min(lo[c],p[c]);hi[c]=Math.max(hi[c],p[c]);}
  }
  const at=128+(by*blocksX+bx)*16;data[at]=255;data[at+1]=255;
  const a=pack(hi),b=pack(lo),pa=unpack(a),pb=unpack(b);
  const palette=[pa,pb,pa.map((v,c)=>(2*v+pb[c])/3),pa.map((v,c)=>(v+2*pb[c])/3)];let indices=0;
  for(let i=0;i<16;i++){let best=0,error=Infinity;for(let k=0;k<4;k++){const d=pixels[i].reduce((n,v,c)=>n+(v-palette[k][c])**2,0);if(d<error){best=k;error=d;}}indices=(indices|best<<(i*2))>>>0;}
  data.writeUInt16LE(a,at+8);data.writeUInt16LE(b,at+10);data.writeUInt32LE(indices,at+12);
 }
 return data;
}
export async function collectReplayTerrain(root:string,requested:unknown,progress:(stage:string,detail?:string)=>unknown=()=>{},legacyEncoding=false):Promise<ReplayTerrain|undefined>{
 const map=terrainMap(requested);if(!map)return;
 const directory=path.join(root,'gamedata');if((await lstat(directory)).isSymbolicLink())throw Error('Linked map directory.');
 const stem=map.slice(1).replace(/\.scmap$/,''),folder=path.posix.dirname(stem);
 const previews=new Set([stem+'.minimap.win.dds',stem+'.minimap.dds',folder+'/terrain.minimap.win.dds',folder+'/terrain.minimap.dds',folder+'/minimap.win.dds',folder+'/minimap.dds',folder+'/preview.dds']);
 const names=(await readdir(directory,{withFileTypes:true})).filter(e=>e.isFile()&&!e.isSymbolicLink()&&/\.(scd|zip)$/i.test(e.name)&&!/^supcom2_revival_/i.test(e.name)).map(e=>e.name).sort((a,b)=>a.localeCompare(b,'en')).reverse();
 if(names.length>512)throw Error('Replay terrain archive limit exceeded.');
 const candidates:{archive:Awaited<ReturnType<typeof indexArchive>>;entry:Awaited<ReturnType<typeof indexArchive>>['entries'][number]}[]=[];
 const encode=(bytes:Buffer,source:string,embedded=false)=>{const data=(legacyEncoding?terrainDdsLegacy:terrainDds)(bytes);return data?{map,name:terrainTextureName(map),data,sha256:createHash('sha256').update(data).digest('hex'),source,embedded}:undefined;};
 let entries=0;
 for(const name of names){
  progress('preparing-replay-terrain',name);
  let archive;try{archive=await indexArchive(path.join(directory,name));}catch(e){if(/map/i.test(name))progress('preparing-replay-terrain','Cannot index '+name+': '+(e as Error).message);continue;}
  entries+=archive.entries.length;if(entries>250000)throw Error('Replay terrain index budget exceeded.');
  for(const entry of archive.entries){const member=entry.name.toLowerCase();
   if(previews.has(member))try{const bytes=await readEntry(archive,entry),result=encode(bytes,name+':'+entry.name);if(result)return result;progress('preparing-replay-terrain','Unsupported preview '+name+':'+entry.name+' ('+bytes.subarray(84,88).toString('hex')+')');}catch(e){progress('preparing-replay-terrain','Cannot read '+name+':'+entry.name+': '+(e as Error).message);}
   if(member===map.slice(1))candidates.push({archive,entry});
  }
 }
 // Some map packages keep their preview DDS inside the SCMAP header.
 for(const {archive,entry}of candidates)try{const bytes=await readEntry(archive,entry,32*1024*1024);let at=bytes.indexOf('DDS '),count=0;while(at>=0&&at<4*1024*1024&&count++<8){const result=encode(bytes.subarray(at),path.basename(archive.file)+':'+entry.name+'@'+at,true);if(result)return result;at=bytes.indexOf('DDS ',at+4);}}catch{}
 progress('preparing-replay-terrain','No readable installed preview for '+map);return;
}
