import {open,rename,rm,lstat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {MAP_PACKAGE_LIMIT} from '../shared/model';
import {validateHostRoom} from './room-share';
export interface MapDownload{server:string;token:string;id:string;filename:string;size:number}
export function mapDownload(value:unknown):MapDownload{
 const v=value as Partial<MapDownload>|null;if(!v||typeof v.id!=='string'||!/^[a-f0-9]{64}$/.test(v.id)||typeof v.filename!=='string'||v.filename.length>160||/[\x00-\x1f\x7f\\/]/.test(v.filename)||!/^.+\.(scd|zip)$/i.test(v.filename)||!Number.isSafeInteger(v.size)||v.size!<1||v.size!>MAP_PACKAGE_LIMIT)throw Error('Choose a current map package from the repository.');
 const c=validateHostRoom({server:v.server,token:v.token,roomId:'00000000-0000-0000-0000-000000000000'});return{server:c.server,token:c.token,id:v.id,filename:v.filename,size:v.size!};
}
/** Stream verified bytes to an adjacent temporary file; publish only on success. */
export async function downloadMapToFile(request:MapDownload,destination:string,signal:AbortSignal,progress:(received:number,total:number)=>void=()=>{}){
 const r=mapDownload(request);if(!path.isAbsolute(destination)||destination.includes('\0'))throw Error('Choose an absolute destination.');
 const existing=await lstat(destination).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw Error('The download destination must be a regular file.');
 const temporary=destination+'.reforged-'+randomUUID()+'.tmp';let handle:Awaited<ReturnType<typeof open>>|undefined;
 try{
  const response=await fetch(r.server+'/api/maps/download/'+r.id,{headers:{Authorization:'Bearer '+r.token},signal,redirect:'error'});if(!response.ok||!response.body)throw Error('Map package download failed.');
  const declared=response.headers.get('content-length');if(declared!==null&&Number(declared)!==r.size)throw Error('The map package size changed. Refresh the repository.');
  handle=await open(temporary,'wx',0o600);let received=0,reported=0;const hash=createHash('sha256');
  for await(const chunk of response.body){signal.throwIfAborted();received+=chunk.length;if(received>r.size||received>MAP_PACKAGE_LIMIT)throw Error('Map download exceeded its expected size.');const b=Buffer.from(chunk);hash.update(b);await handle.writeFile(b);if(received-reported>=1024*1024||received===r.size){reported=received;progress(received,r.size);}}
  if(received!==r.size||hash.digest('hex')!==r.id)throw Error('The map package failed download verification.');signal.throwIfAborted();await handle.sync();await handle.close();handle=undefined;await rename(temporary,destination);return{message:'Map package downloaded and verified. Install it using its map instructions.'};
 }finally{await handle?.close().catch(()=>{});await rm(temporary,{force:true});}
}
