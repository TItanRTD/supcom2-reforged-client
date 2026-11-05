import {readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {MapCatalog,GameMap} from '../shared/model';
import {indexArchive,readEntry,parseScenario,decodeMapPreview,type Archive} from '../server/map-assets';
export {indexArchive,readEntry,parseScenario,decodeMapPreview,crc32} from '../server/map-assets';
export class LocalMapCatalog {
 private archives:Archive[]=[];private maps=new Map<string,GameMap>();private previews=new Map<string,string|null>();
 metadata(id:string){const m=this.maps.get(id.toLowerCase());return m?structuredClone({id:m.id,name:m.name,players:m.players,metadataHash:m.metadataHash,...(m.starts?{starts:m.starts}:{})}):null;}
 async scan(executable:string):Promise<MapCatalog>{
  this.archives=[];this.maps.clear();this.previews.clear();const warnings:string[]=[];
  const dir=path.join(path.dirname(path.dirname(executable)),'gamedata');
  if((await lstat(dir)).isSymbolicLink())throw new Error('The gamedata folder must not be a link.');
  const names=(await readdir(dir)).filter(n=>/\.(scd|zip)$/i.test(n)).sort((a,b)=>a.localeCompare(b,'en'));
  if(names.length>512)warnings.push('Only the first 512 archives were scanned.');
  let indexEntries=0;
  for(const name of names.slice(0,512)){
   try{const a=await indexArchive(path.join(dir,name));if(indexEntries+a.entries.length>250000){warnings.push(`${name}: total index budget exceeded.`);continue;}indexEntries+=a.entries.length;this.archives.push(a);}catch{warnings.push(`${name}: unreadable or unsupported archive.`);}
  }
  let scenarioCount=0;
  for(const a of this.archives)for(const e of a.entries){
   if(!/^(uncompiled\/)?maps\/[^/]+\/[^/]+_scenario\.lua$/i.test(e.name)||++scenarioCount>4096)continue;
   try{const bytes=await readEntry(a,e,512*1024),m=parseScenario(bytes,e.name);if(m)this.maps.set(m.id.toLowerCase(),{...m,archive:path.basename(a.file),metadataHash:createHash('sha256').update(bytes).digest('hex')});}
   catch{warnings.push(`${path.basename(a.file)}: a scenario could not be read.`);}
  }
  const maps=[...this.maps.values()].sort((a,b)=>a.name.localeCompare(b.name)).slice(0,512);
  return {maps,warnings:warnings.slice(0,30),directory:dir};
 }
 async preview(id:string):Promise<string|null>{
  if(typeof id!=='string'||!this.maps.has(id.toLowerCase()))throw new Error('Rescan installed maps before requesting this preview.');
  const key=id.toLowerCase();if(this.previews.has(key))return this.previews.get(key)!;
  const m=this.maps.get(key)!,folder=path.posix.dirname(m.id),terrain=m.terrain.replace(/\.scmap$/i,'.minimap.win.dds');
  const candidates=[terrain,`${folder}/${path.posix.basename(folder)}.minimap.win.dds`,`${folder}/minimap.dds`].map(n=>n.replace(/^\//,'').toLowerCase());
  let result:string|null=null;
  for(const a of [...this.archives].reverse()){
   const entry=a.entries.find(e=>candidates.includes(e.name.toLowerCase()));
   if(entry){try{result=decodeMapPreview(await readEntry(a,entry));}catch{}if(result)break;}
  }
  if(this.previews.size>=40)this.previews.delete(this.previews.keys().next().value!);this.previews.set(key,result);return result;
 }
}
