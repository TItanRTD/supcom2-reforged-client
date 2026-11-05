import {lstat,mkdir,open,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {mapContentHash,scanMapPackage,type MapScanner,type MapScan} from './map-security';
import {ApiError,text} from './lobby';
import {indexArchive,readEntry,parseScenario} from './map-assets';
import {MAP_PACKAGE_LIMIT,type MapPackage,type MapRepositoryPage,type RepositoryMap} from '../shared/model';
interface Record extends MapPackage {ownerId:string;contentHash?:string;scan?:MapScan}
interface Limits {maxBytes?:number;maxTotalBytes?:number;maxPackages?:number;scanner?:MapScanner}
function metadata(raw:{title:unknown;description?:unknown;filename:unknown}){
 const title=raw.title===null||raw.title===undefined||raw.title===''?'':text(raw.title,'Map title',100);
 if(typeof raw.filename!=='string'||raw.filename.length>160||/[\x00-\x1f\x7f\\/]/.test(raw.filename)||!/^.+\.(scd|zip)$/i.test(raw.filename))throw new ApiError(400,'Choose a map package ending in .scd or .zip.');
 const description=raw.description??'';if(typeof description!=='string'||description.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description))throw new ApiError(400,'Map description must be at most 1000 characters.');
 return {title,description:description.trim(),filename:raw.filename};
}
/** The original map archive is stored verbatim. No archive scripts are executed. */
export class MapRepository {
 private serial:Promise<unknown>=Promise.resolve();private active=new Set<string>();private scanner:MapScanner;
 readonly maxBytes:number;private maxTotalBytes:number;private maxPackages:number;
 constructor(private directory?:string,limits:Limits={}){this.scanner=limits.scanner??scanMapPackage;this.maxBytes=limits.maxBytes??MAP_PACKAGE_LIMIT;this.maxTotalBytes=limits.maxTotalBytes??2*1024*1024*1024;this.maxPackages=limits.maxPackages??1000;}
 get configured(){return !!this.directory;}
 private async records():Promise<Record[]>{
  if(!this.directory)return [];
  try{
   const file=path.join(this.directory,'index.json'),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>32*1024*1024)throw Error('Invalid map repository index.');
   const data=JSON.parse(await readFile(file,'utf8'));
   if(data.schema!==1||!Array.isArray(data.packages)||data.packages.length>1000)throw Error('Invalid map repository index.');
   const rows=data.packages as Record[];
   if(rows.some(r=>!r||! /^[a-f0-9]{64}$/.test(r.id)||typeof r.ownerId!=='string'||typeof r.uploader!=='string'||!Number.isSafeInteger(r.size)||r.size<1||r.size>MAP_PACKAGE_LIMIT||typeof r.uploadedAt!=='string'||!Number.isFinite(Date.parse(r.uploadedAt))||!Array.isArray(r.maps)||!r.maps.length||r.maps.length>64||r.maps.some(m=>!m||typeof m.id!=='string'||m.id.length>240||typeof m.name!=='string'||m.name.length>100||m.players!==null&&(!Number.isInteger(m.players)||m.players<1||m.players>16)))||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('Invalid map repository index.');
   for(const row of rows)metadata(row);return rows;
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 }
 private public(row:Record,viewer?:{id:string;admin:boolean}):MapPackage {const {ownerId,contentHash,...item}=row;item.scan??={status:'pending',engine:'Unscanned',at:'',message:'Waiting for the first malware scan.'};if(item.scan.status==='clean'&&(!Number.isFinite(Date.parse(item.scan.at))||Date.now()-Date.parse(item.scan.at)>7*86400_000))item.scan={...item.scan,status:'pending',message:'This package needs a fresh malware scan.'};return {...structuredClone(item),...(viewer?{canDelete:viewer.admin||viewer.id===ownerId}:{})};}
 async list(query='',page=0,viewer?:{id:string;admin:boolean}):Promise<MapRepositoryPage>{
  if(typeof query!=='string'||query.length>100||!Number.isSafeInteger(page)||page<0||page>1000)throw new ApiError(400,'Invalid map search or page.');
  const search=query.trim().toLowerCase(),rows=(await this.records()).filter(r=>r.scan?.status==='clean'&&Date.now()-Date.parse(r.scan.at)<=7*86400_000||viewer&&(viewer.admin||r.ownerId===viewer.id)).filter(r=>[r.title,r.uploader,...r.maps.map(m=>m.name)].join(' ').toLowerCase().includes(search)).sort((a,b)=>b.uploadedAt.localeCompare(a.uploadedAt)||a.title.localeCompare(b.title));
  const pages=Math.max(1,Math.ceil(rows.length/24));page=Math.min(page,pages-1);
  return {configured:this.configured,packages:rows.slice(page*24,page*24+24).map(r=>this.public(r,viewer)),total:rows.length,page,pages,maxBytes:this.maxBytes};
 }
 async remove(id:string,actorId:string,authorize:()=>Promise<boolean>){
  if(!this.directory||typeof id!=='string'||! /^[a-f0-9]{64}$/.test(id))throw new ApiError(404,'Map package not found.');
  const work=this.serial.then(async()=>{
   const admin=await authorize(),rows=await this.records(),row=rows.find(r=>r.id===id);
   if(!row)throw new ApiError(404,'Map package not found.');
   if(row.ownerId!==actorId&&!admin)throw new ApiError(403,'Only the uploader or an administrator can delete this map package.');
   const index=path.join(this.directory!,'index.json'),pending=index+'.'+randomUUID()+'.tmp';
   try{await writeFile(pending,JSON.stringify({schema:1,packages:rows.filter(r=>r.id!==id)}),{flag:'wx',mode:0o600});await rename(pending,index);}finally{await rm(pending,{force:true});}
   // The committed index revokes resolve/download access before removing bytes.
   await rm(path.join(this.directory!,id+'.package'),{force:true});
   return {id,title:row.title};
  });this.serial=work.catch(()=>{});return work;
 }
 async upload(input:AsyncIterable<Buffer|string>,raw:{title:unknown;description?:unknown;filename:unknown},ownerId:string,uploader:string,authorize:()=>Promise<void>=async()=>{}){
  if(!this.directory)throw new ApiError(503,'Map repository storage is not configured on this server.');
  const meta=metadata(raw);if(this.active.has(ownerId)||this.active.size>=2)throw new ApiError(429,'Another map upload is running. Try again when it finishes.');
  this.active.add(ownerId);let temp='';let file:Awaited<ReturnType<typeof open>>|undefined;
  try{
   await mkdir(this.directory,{recursive:true,mode:0o700});temp=path.join(this.directory,'.upload-'+randomUUID());file=await open(temp,'wx',0o600);const hash=createHash('sha256');let size=0;
   for await(const chunk of input){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>this.maxBytes)throw new ApiError(413,'Map package exceeds the upload size limit.');hash.update(bytes);await file.writeFile(bytes);}
   await file.close();file=undefined;if(!size)throw new ApiError(400,'Choose a nonempty map package.');
   let maps:RepositoryMap[];
   try{
    const archive=await indexArchive(temp,true);if(archive.entries.length>10000||archive.entries.reduce((n,e)=>n+e.size,0)>2*1024*1024*1024)throw Error('Archive exceeds the map package limits.');
    const scenarios=archive.entries.filter(e=>/^(uncompiled\/)?maps\/[^/]+\/[^/]+_scenario\.lua$/i.test(e.name)).sort((a,b)=>Number(a.name.toLowerCase().startsWith('uncompiled/'))-Number(b.name.toLowerCase().startsWith('uncompiled/')));
    if(scenarios.length>128)throw Error('Too many map scenarios in one package.');
    const found=new Map<string,RepositoryMap>();
    for(const entry of scenarios){const m=parseScenario(await readEntry(archive,entry,512*1024),entry.name);if(m)found.set(m.id.toLowerCase(),{id:m.id,name:m.name,players:m.players});}
    maps=[...found.values()].sort((a,b)=>a.name.localeCompare(b.name));if(!maps.length||maps.length>64)throw Error('No readable skirmish maps found.');
   }catch{throw new ApiError(400,'Choose an SCD or ZIP map package containing readable maps/<map>/<map>_scenario.lua files.');}
   let contentHash:string;try{contentHash=await mapContentHash(temp);}catch(e){throw new ApiError(400,(e as Error).message);}
   const scan=await this.scanner(temp);
   const id=hash.digest('hex'),work=this.serial.then(async()=>{
    await authorize();const rows=await this.records(),existing=rows.find(r=>r.id===id||r.contentHash===contentHash);if(existing)return{package:this.public(existing),duplicate:true};
    if(rows.length>=this.maxPackages||rows.reduce((n,r)=>n+r.size,0)+size>this.maxTotalBytes)throw new ApiError(507,'The map repository is full.');
    const detectedTitle=maps.length===1?maps[0].name:meta.filename.replace(/\.(scd|zip)$/i,'').replace(/^_?MapPack_/i,'').replace(/_/g,' ').slice(0,100).trim();
    const record:Record={...meta,contentHash,scan,title:meta.title||detectedTitle||'Community map pack',id,ownerId,uploader,size,uploadedAt:new Date().toISOString(),maps},data=JSON.stringify({schema:1,packages:[...rows,record]});
    if(Buffer.byteLength(data)>32*1024*1024)throw new ApiError(507,'The map repository index is full.');
    const destination=path.join(this.directory!,id+'.package'),index=path.join(this.directory!,'index.json'),pending=index+'.'+randomUUID()+'.tmp';
    await rename(temp,destination);
    try{await writeFile(pending,data,{flag:'wx',mode:0o600});await rename(pending,index);}catch(e){await rm(destination,{force:true});await rm(pending,{force:true});throw e;}
    return {package:this.public(record),duplicate:false};
   });this.serial=work.catch(()=>{});return await work;
  }finally{await file?.close().catch(()=>{});if(temp)await rm(temp,{force:true});this.active.delete(ownerId);}
 }
 /** Existing packages are quarantined until their first successful scan. */
 async scanStored(keepGoing:()=>boolean=()=>true){
  for(const row of await this.records()){if(!keepGoing())break;if(!row.scan||row.scan.status==='clean'&&Date.now()-Date.parse(row.scan.at)>7*86400_000){
   const scanned=await this.rescan(row.id);if(scanned.scan?.status==='pending')break;
  }}
 }
 /** One package per explicit administrator request; no long unbounded batch. */
 async rescan(id:unknown){
  if(!this.directory||typeof id!=='string'||! /^[a-f0-9]{64}$/.test(id))throw new ApiError(404,'Map package not found.');
  const work=this.serial.then(async()=>{
   const rows=await this.records(),row=rows.find(r=>r.id===id);if(!row)throw new ApiError(404,'Map package not found.');
   const file=path.join(this.directory!,id+'.package');let scan:MapScan;
   try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size!==row.size)throw Error('Package storage changed.');
    const b=await readFile(file);if(createHash('sha256').update(b).digest('hex')!==row.id)throw Error('Package checksum changed.');
    row.contentHash=await mapContentHash(file);scan=await this.scanner(file);
    if(scan.status==='clean'&&rows.some(r=>r.id!==id&&r.contentHash===row.contentHash&&r.scan?.status==='clean'))scan={...scan,status:'blocked',message:'Duplicate of an already published map package.'};
   }catch{scan={status:'blocked',engine:'Package validation',at:new Date().toISOString(),message:'Stored package failed validation. It remains quarantined.'};}
   row.scan=scan;const index=path.join(this.directory!,'index.json'),pending=index+'.'+randomUUID()+'.tmp';
   try{await writeFile(pending,JSON.stringify({schema:1,packages:rows}),{flag:'wx',mode:0o600});await rename(pending,index);}finally{await rm(pending,{force:true});}
   return this.public(row);
  });this.serial=work.catch(()=>{});return work;
 }
 async get(id:string){
  if(!this.directory||! /^[a-f0-9]{64}$/.test(id))throw new ApiError(404,'Map package not found.');
  const row=(await this.records()).find(r=>r.id===id);if(!row)throw new ApiError(404,'Map package not found.');
  if(row.scan?.status!=='clean'||Date.now()-Date.parse(row.scan.at)>7*86400_000)throw new ApiError(409,'This package is quarantined until validation and a malware scan pass.');
  const file=path.join(this.directory,id+'.package');let s;try{s=await lstat(file);}catch{throw new ApiError(404,'Map package file not found.');}
  if(!s.isFile()||s.isSymbolicLink()||s.size!==row.size)throw new ApiError(409,'Map package storage changed.');return {file,package:this.public(row)};
 }
 async resolve(map:string,metadataHash:string){
  if(!/^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/i.test(map)||! /^[a-f0-9]{64}$/.test(metadataHash))throw new ApiError(400,'Invalid map version request.');
  const candidates=(await this.records()).filter(r=>r.scan?.status==='clean'&&r.maps.some(m=>m.id.toLowerCase()===map.toLowerCase())).sort((a,b)=>b.uploadedAt.localeCompare(a.uploadedAt));
  for(const candidate of candidates){
   const item=await this.get(candidate.id),archive=await indexArchive(item.file,true);
   for(const entry of archive.entries){if(('/'+entry.name.replace(/^uncompiled\//i,'')).toLowerCase()!==map.toLowerCase())continue;
    if(createHash('sha256').update(await readEntry(archive,entry,512*1024)).digest('hex')===metadataHash)return item.package;
   }
  }
  throw new ApiError(404,'The host’s map version is not in the repository. Ask the host to upload that map package.');
 }
}
