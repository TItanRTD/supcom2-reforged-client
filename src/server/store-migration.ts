import {MAP_PACKAGE_LIMIT} from '../shared/model';
import {verifyRuleset} from './research-publication';
import {createReadStream,constants} from 'node:fs';
import {mkdir,readFile,writeFile,lstat,copyFile,link,rm,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
type Entry={name:string;size:number;sha256:string};
const core=['accounts.json','admin.json'];
const allowed=(n:string)=>core.includes(n)||n==='research-draft.json'||/^research-draft\.json\.storm-[a-f0-9]{16}\.backup\.json$/.test(n)||/^research-draft\.json\.rulesets\/[a-f0-9]{64}\.json$/.test(n)||n==='maps/index.json'||/^maps\/[a-f0-9]{64}\.package$/.test(n);
const limit=(n:string)=>n.endsWith('.package')?MAP_PACKAGE_LIMIT:core.includes(n)||n==='maps/index.json'?32*1024*1024:8*1024*1024;
async function mapDirectory(root:string){try{if(!(await lstat(path.join(root,'maps'))).isDirectory())throw Error('The map repository must be a regular directory.');return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function entry(root:string,name:string,max:number):Promise<Entry>{
 const file=path.join(root,name),s=await lstat(file);if(!s.isFile()||s.size>max)throw Error('Server migration requires bounded regular data files.');
 const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return {name,size:s.size,sha256:h.digest('hex')};
}
async function optional(root:string,name:string,max:number){try{return await entry(root,name,max);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
async function sourceEntries(root:string){
 const files=await Promise.all(core.map(n=>entry(root,n,32*1024*1024))),research=await optional(root,'research-draft.json',8*1024*1024);if(research)files.push(research);
 if(research){
  const directory=path.join(root,'research-draft.json.rulesets');
  try{const s=await lstat(directory);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Research rulesets require a regular directory.');const names=(await readdir(directory)).filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort();if(names.length>512)throw Error('Too many research publications for automatic migration.');
   for(const name of names){const item=await entry(root,'research-draft.json.rulesets/'+name,8*1024*1024),r=verifyRuleset(JSON.parse(await readFile(path.join(directory,name),'utf8')));if(name!==r.id+'.json')throw Error('A research publication changed.');files.push(item);}
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  // Preserve opaque older drafts byte-for-byte; inspect only readable publication metadata.
  let saved:any=null;try{saved=JSON.parse(await readFile(path.join(root,research.name),'utf8'));}catch{}if(saved?.publishedId&&!files.some(e=>e.name==='research-draft.json.rulesets/'+saved.publishedId+'.json'))throw Error('The active research publication is missing.');
  const archives=(await readdir(root)).filter(n=>/^research-draft\.json\.storm-[a-f0-9]{16}\.backup\.json$/.test(n)).sort();if(archives.length>32)throw Error('Too many archived research drafts for automatic migration.');for(const name of archives)files.push(await entry(root,name,8*1024*1024));
 }
 // Copy indexed immutable packages only, excluding pending uploads and orphaned blobs.
 if(!await mapDirectory(root))return files;
 const index=await optional(root,'maps/index.json',32*1024*1024);if(!index)return files;
 const data=JSON.parse(await readFile(path.join(root,index.name),'utf8'));
 if(data.schema!==1||!Array.isArray(data.packages)||data.packages.length>1000)throw Error('The map repository index is invalid.');
 files.push(index);let total=0;const ids=new Set<string>();
 for(const row of data.packages){
  if(!row||typeof row.id!=='string'||!/^[a-f0-9]{64}$/.test(row.id)||ids.has(row.id)||!Number.isSafeInteger(row.size)||row.size<1||row.size>MAP_PACKAGE_LIMIT)throw Error('The map repository index is invalid.');
  ids.add(row.id);total+=row.size;if(total>2*1024*1024*1024)throw Error('The map repository is too large for automatic migration.');
  const item=await entry(root,'maps/'+row.id+'.package',MAP_PACKAGE_LIMIT);if(item.size!==row.size||item.sha256!==row.id)throw Error('An uploaded map package changed. Existing data was preserved.');files.push(item);
 }
 return files;
}
async function manifest(root:string):Promise<Entry[]>{
 try{
  const raw=await readFile(path.join(root,'content-manifest.json'),'utf8');if(raw.length>512*1024)throw Error('Invalid migration manifest.');const data=JSON.parse(raw);
  if(data.schema!==1||!Array.isArray(data.files)||data.files.length<2||data.files.length>1600||data.files.some((e:Entry)=>!e||!allowed(e.name)||!Number.isSafeInteger(e.size)||e.size<0||e.size>limit(e.name)||!/^[a-f0-9]{64}$/.test(e.sha256))||new Set(data.files.map((e:Entry)=>e.name)).size!==data.files.length||core.some(n=>!data.files.some((e:Entry)=>e.name===n)))throw Error('Invalid migration manifest.');return data.files;
 }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
  // Resume account-only backups made by older clients.
  const files=await Promise.all(core.map(n=>entry(root,n,32*1024*1024)));let expected:unknown;
  try{expected=JSON.parse(await readFile(path.join(root,'source-hashes.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return sourceEntries(root);}
  if(!Array.isArray(expected)||expected.length!==2||files.some((e,i)=>e.sha256!==expected[i]))throw Error('The saved account backup changed.');return files;
 }
}
async function validateCore(root:string){
 const a=JSON.parse(await readFile(path.join(root,core[0]),'utf8')),b=JSON.parse(await readFile(path.join(root,core[1]),'utf8'));
 if(a.schema!==1||!Array.isArray(a.accounts)||!a.accounts.length||!Array.isArray(a.remembered)||!a.accounts.every((v:any)=>typeof v.id==='string'&&typeof v.username==='string'&&/^[a-f0-9]{64}$/.test(v.salt)&&/^[a-f0-9]{128}$/.test(v.hash)))throw Error('No valid existing accounts were found. No accounts were imported.');
 if(b.format!=='s2r-admin-pin-v1'||!/^[a-f0-9]{64}$/.test(b.salt)||!/^[a-f0-9]{128}$/.test(b.hash))throw Error('The administrator setup is invalid.');return a.accounts.length as number;
}
export async function stageServerMigration(source:string,destination:string){
 const files=await sourceEntries(source),count=await validateCore(source);await mkdir(destination,{recursive:true,mode:0o700});
 for(const e of files){const target=path.join(destination,e.name);await mkdir(path.dirname(target),{recursive:true,mode:0o700});await copyFile(path.join(source,e.name),target,constants.COPYFILE_EXCL);}
 await writeFile(path.join(destination,'source-hashes.json'),JSON.stringify(files.slice(0,2).map(e=>e.sha256)),{flag:'wx',mode:0o600});
 await writeFile(path.join(destination,'content-manifest.json'),JSON.stringify({schema:1,files}),{flag:'wx',mode:0o600});return count;
}
export async function verifyServerMigration(backup:string,source?:string){
 const files=await manifest(backup);
 if(files.some(e=>e.name.startsWith('maps/')))await mapDirectory(backup);
 for(const e of files){const saved=await entry(backup,e.name,limit(e.name));if(saved.size!==e.size||saved.sha256!==e.sha256)throw Error('The saved server backup changed. Both copies were preserved.');}
 if(source){const current=(await sourceEntries(source)).sort((a,b)=>a.name.localeCompare(b.name)),expected=[...files].sort((a,b)=>a.name.localeCompare(b.name)),legacy=!(await optional(backup,'content-manifest.json',512*1024));
  if(JSON.stringify(legacy?current.filter(e=>core.includes(e.name)):current)!==JSON.stringify(expected))throw Error('The source server data changed after migration was staged. Both copies were preserved; resolve this before retrying.');}
 return files;
}
export async function importAccounts(source='/migration',destination='/data'){
 const files=await verifyServerMigration(source),count=await validateCore(source);await mkdir(destination,{recursive:true,mode:0o700});if(files.some(e=>e.name.startsWith('maps/')))await mapDirectory(destination);
 const journal=path.join(destination,'.s2r-import.json'),expected=files.map(e=>e.sha256);let previous:any=null;
 try{previous=JSON.parse(await readFile(journal,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 if(previous&&(JSON.stringify(previous.hashes)!==JSON.stringify(expected)||previous.names&&JSON.stringify(previous.names)!==JSON.stringify(files.map(e=>e.name))))throw Error('A different server import is already recorded. Existing data was preserved.');
 const exists:boolean[]=[];for(const e of files){const current=await optional(destination,e.name,limit(e.name));if(current&&(current.size!==e.size||current.sha256!==e.sha256))throw Error('Destination already has different server data. It was not overwritten.');exists.push(!!current);}
 if(exists.some(Boolean)&&!exists.every(Boolean)&&!previous)throw Error('Destination has an incomplete, unrelated server store. It was not overwritten.');
 if(!previous)await writeFile(journal,JSON.stringify({schema:1,names:files.map(e=>e.name),hashes:expected}),{flag:'wx',mode:0o600});
 for(let i=0;i<files.length;i++)if(!exists[i]){
  const e=files[i],target=path.join(destination,e.name),temp=target+'.s2r-import';await mkdir(path.dirname(target),{recursive:true,mode:0o700});
  try{await copyFile(path.join(source,e.name),temp,constants.COPYFILE_EXCL);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const staged=await entry(destination,e.name+'.s2r-import',limit(e.name));if(staged.size!==e.size||staged.sha256!==e.sha256)throw Error('A previous import has different staged bytes.');
  // Exclusive publish never overwrites an unexpected competing writer.
  await link(temp,target);await rm(temp);
 }
 return {accounts:count};
}
