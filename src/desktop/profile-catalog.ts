import {readFile,readdir,lstat} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {CLIENT_VERSION} from '../shared/model';
export const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Hash the actual current generators/art, excluding immutable older snapshots. */
export async function profileSourceDigest(assets:string){
 const hash=createHash('sha256');
 async function walk(directory:string,relative:string){
  const entries=await readdir(directory,{withFileTypes:true});entries.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  for(const entry of entries){if(entry.name.startsWith('.')||entry.name.startsWith('legacy-')||entry.name==='sources'||entry.name.startsWith('historical-')||relative==='scouts'&&entry.name==='art'||/\.(?:s|c|inc)$/.test(entry.name))continue;
   const file=path.join(directory,entry.name),name=relative+'/'+entry.name;
   if(entry.isSymbolicLink())throw Error('Linked interface assets are not supported.');
   if(entry.isDirectory())await walk(file,name);else if(entry.isFile()){hash.update(name+'\0');hash.update(digest(await readFile(file)));}
  }
 }
 for(const name of ['hud','lobby','colors','scouts','ai'])await walk(path.join(assets,name),name);
 return hash.digest('hex');
}
export interface ProfileRecord{revision:string;custom:boolean;modernHud:boolean;scale:number;legacyReplay:boolean;tocSha256:string;archiveSha256:string;manifest:any}
export async function readProfileCatalog(assets:string,inputs:Buffer[],hudLua?:Buffer):Promise<{source:string;profiles:ProfileRecord[]}|null>{
 try{
  const file=path.join(assets,'profile-catalog.json.gz'),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>20_000_000)return null;
  const c=JSON.parse(gunzipSync(await readFile(file),{maxOutputLength:128_000_000}).toString('utf8'));
  if(c.format!=='s2r-profile-catalog-v1'||c.clientVersion!==CLIENT_VERSION||!Array.isArray(c.profiles)||c.profiles.length>1024||JSON.stringify(c.inputs)!==JSON.stringify(inputs.map(digest))||hudLua&&c.lua!==digest(hudLua)||c.source!==await profileSourceDigest(assets))return null;
  if(c.profiles.some((p:ProfileRecord)=>!p||!['current','0335','0334','0333','0332','0331','0329','0328','0327','0326','0325','0324','0323','0322','0321','0320','0313','0312','0311','0310','0306','0305','0304','0301','0300','0292','0291','0290','0282','0280','02733','02732','02731','02730','02729','02728','02727','02726','02725','02723','control'].includes(p.revision)||typeof p.custom!=='boolean'||typeof p.modernHud!=='boolean'||typeof p.legacyReplay!=='boolean'||!Number.isFinite(p.scale)||!/^([a-f0-9]{64})$/.test(p.tocSha256)||!/^([a-f0-9]{64})$/.test(p.archiveSha256)||!p.manifest))return null;
  return c;
 }catch{return null;}
}
