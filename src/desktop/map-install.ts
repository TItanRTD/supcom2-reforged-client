import {mkdir,lstat,readFile,copyFile,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {downloadMapToFile,mapDownload,type MapDownload} from './map-download';
import {indexArchive,readEntry,parseScenario} from '../server/map-assets';
import type {RoomMap} from '../shared/model';
import {LocalMapCatalog} from './map-catalog';
export interface MapInstallProgress{id:string;received:number;total:number;stage:'downloading'|'installing'|'ready';message?:string}
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** SCD and map ZIP packages share the native ZIP container. Keep their contents
 * intact in one owned SCD rather than extracting paths into the game folder. */
export async function installMapPackage(raw:MapDownload,executable:string,cache:string,signal:AbortSignal,progress:(p:MapInstallProgress)=>void=()=>{},expected?:RoomMap){
 const r=mapDownload(raw),gamedata=path.join(path.dirname(path.dirname(executable)),'gamedata');
 const dir=await lstat(gamedata);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('The configured gamedata folder must be an ordinary directory.');
 await mkdir(cache,{recursive:true});const downloaded=path.join(cache,r.id+'.map-package');
 await downloadMapToFile(r,downloaded,signal,(received,total)=>progress({id:r.id,received,total,stage:'downloading'}));
 signal.throwIfAborted();progress({id:r.id,received:r.size,total:r.size,stage:'installing',message:'Checking map contents…'});
 const archive=await indexArchive(downloaded,true);
 if(!archive.entries.length||archive.entries.length>10000||archive.entries.reduce((n,e)=>n+e.size,0)>2*1024*1024*1024)throw Error('Map package contents exceed the installation limits.');
 const allowed=/^(?:maps\/|uncompiled\/maps\/|textures\/|meshes\/|props\/|effects\/|sounds\/|[^/]+\.(?:txt|md|png|jpg|jpeg))$/i;
 if(archive.entries.some(e=>!e.name.endsWith('/')&&!allowed.test(e.name)&&! /^(?:maps|uncompiled\/maps|textures|meshes|props|effects|sounds)\//i.test(e.name)))throw Error('This package includes global game overrides. It requires manual installation.');
 let found=false,scenarios=0;
 for(const e of archive.entries){if(!/^(uncompiled\/)?maps\/[^/]+\/[^/]+_scenario\.lua$/i.test(e.name))continue;
  const bytes=await readEntry(archive,e,512*1024),m=parseScenario(bytes,e.name);if(!m)continue;scenarios++;
  if(expected&&m.id.toLowerCase()===expected.id.toLowerCase()&&hash(bytes)===expected.metadataHash)found=true;
 }
 if(!scenarios||expected&&!found)throw Error('The downloaded package does not contain the requested map version.');
 const target=path.join(gamedata,'_reforged_map_'+r.id+'.scd'),temporary=target+'.'+randomUUID()+'.tmp';
 const existing=await lstat(target).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
 if(existing){if(!existing.isFile()||existing.isSymbolicLink()||hash(await readFile(target))!==r.id)throw Error('An existing installed map package differs; it was preserved.');}
 else try{await copyFile(downloaded,temporary,constants.COPYFILE_EXCL);signal.throwIfAborted();await rename(temporary,target);}finally{await rm(temporary,{force:true});}
 const catalog=await new LocalMapCatalog().scan(executable);
 if(expected&&!catalog.maps.some(m=>m.id.toLowerCase()===expected.id.toLowerCase()&&m.metadataHash===expected.metadataHash))throw Error('Another installed package overrides the requested map. Remove that conflicting map version before joining.');
 progress({id:r.id,received:r.size,total:r.size,stage:'ready',message:'Map installed and ready.'});
 return {message:'Map installed into gamedata. Installed maps refreshed.',catalog};
}
export async function ensureGameMap(context:{server:string;token:string},map:RoomMap|null|undefined,executable:string,cache:string,signal:AbortSignal,progress:(p:MapInstallProgress)=>void=()=>{}){
 if(!map)return;
 const catalog=await new LocalMapCatalog().scan(executable);
 if(catalog.maps.some(m=>m.id.toLowerCase()===map.id.toLowerCase()&&m.metadataHash===map.metadataHash))return;
 const url=new URL('/api/maps/resolve',context.server);url.searchParams.set('map',map.id);url.searchParams.set('hash',map.metadataHash);
 const response=await fetch(url,{headers:{Authorization:'Bearer '+context.token},redirect:'error',signal});
 const data=await response.json() as {package?:MapDownload;error?:string};
 if(!response.ok||!data.package)throw Error(data.error??'The host’s map version is missing from the community repository. Ask the host to upload its package.');
 await installMapPackage({...data.package,server:context.server,token:context.token},executable,cache,signal,progress,map);
}
