import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './lobby';
const derive=promisify(scrypt);
export interface AdminSetup {format:'s2r-admin-pin-v1';salt:string;hash:string;owner?:{username:string;salt:string;hash:string;accountId?:string}}
export function validateAdminSetup(value:unknown):AdminSetup {
 const p=value as Partial<AdminSetup>;
 if(!p||p.format!=='s2r-admin-pin-v1'||typeof p.salt!=='string'||!/^[a-f0-9]{64}$/.test(p.salt)||typeof p.hash!=='string'||!/^[a-f0-9]{128}$/.test(p.hash))throw new Error('Invalid S2R administrator setup file.');
 if(p.owner&&(!/^[A-Za-z0-9_]{3,24}$/.test(p.owner.username)||!/^[a-f0-9]{64}$/.test(p.owner.salt)||!/^[a-f0-9]{128}$/.test(p.owner.hash)||p.owner.accountId!==undefined&&typeof p.owner.accountId!=='string'))throw new Error('Invalid owner setup.');
 return {format:p.format,salt:p.salt,hash:p.hash,...(p.owner?{owner:{...p.owner}}:{})};
}
export class AdminGate {
 private config:AdminSetup|null=null;
 private loaded=false;
 private hashing=false;
 private grants=new Map<string,number>();
 private attempts=new Map<string,{since:number;count:number}>();
 private globalAttempts={since:0,count:0};
 constructor(private file?:string,private now=()=>Date.now(),private ttl=15*60_000){}
 private async load(){
  if(!this.loaded){
   if(this.file)try{this.config=validateAdminSetup(JSON.parse(await readFile(this.file,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   this.loaded=true;
  }return this.config;
 }
 async configured(){return !!await this.load();}
 async initialize(value:unknown){
  const p=validateAdminSetup(value);
  const existing=await this.load();if(existing){if(!p.owner)throw new Error('An administrator PIN is already configured on this server.');if(existing.owner?.accountId)throw new Error('Owner access is already assigned to an account.');const merged={...existing,owner:p.owner};await this.persist(merged);this.config=merged;return;}
  if(this.file){await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});await writeFile(this.file,JSON.stringify(p),{mode:0o600,flag:'wx'});}
  this.config=p;this.loaded=true;
 }
 private async persist(value:AdminSetup){if(this.file){await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify(value),{mode:0o600});await rename(tmp,this.file);}}
 private rate(key:string){
  const now=this.now(),window=15*60_000;
  let bucket=this.attempts.get(key);if(!bucket||now-bucket.since>=window){bucket={since:now,count:0};this.attempts.set(key,bucket);}
  if(bucket.count>=5)throw new ApiError(429,'Administrator access is temporarily locked. Try again in 15 minutes.');
  bucket.count++;
  if(this.attempts.size>1000)for(const [id,value]of this.attempts)if(now-value.since>=window)this.attempts.delete(id);
 }
 async unlock(token:string,pin:unknown,accountId:string,ip:string,username=''){
  const config=await this.load();if(!config)throw new ApiError(409,'The server owner must import administrator setup on the server PC first.');
  if(this.now()-this.globalAttempts.since>=15*60_000)this.globalAttempts={since:this.now(),count:0};
  if(this.globalAttempts.count>=20)throw new ApiError(429,'Administrator access is temporarily locked. Try again in 15 minutes.');
  this.globalAttempts.count++;this.rate('account:'+accountId);this.rate('ip:'+ip);
  if(typeof pin!=='string'||pin.length<6||pin.length>128)throw new ApiError(403,'Incorrect administrator credential.');
  if(this.hashing)throw new ApiError(429,'Administrator verification is busy. Try again shortly.');
  this.hashing=true;
  try{const owner=config.owner;const eligible=owner&&owner.username.toLowerCase()===username.toLowerCase()&&(!owner.accountId||owner.accountId===accountId);const verifier=eligible&&!/^\d{6}$/.test(pin)?owner:config;const actual=await derive(pin,verifier.salt,64) as Buffer;if(!timingSafeEqual(actual,Buffer.from(verifier.hash,'hex')))throw new ApiError(403,'Incorrect administrator credential.');if(verifier===owner&&!owner!.accountId){const bound={...config,owner:{...owner!,accountId}};await this.persist(bound);this.config=bound;}}finally{this.hashing=false;}
  this.attempts.delete('account:'+accountId);this.attempts.delete('ip:'+ip);
  for(const [id,expires]of this.grants)if(expires<=this.now())this.grants.delete(id);
  const expires=this.now()+this.ttl;this.grants.set(token,expires);return {expiresAt:new Date(expires).toISOString()};
 }
 status(token:string){const expires=this.grants.get(token);if(!expires||expires<=this.now()){this.grants.delete(token);return null;}return {expiresAt:new Date(expires).toISOString()};}
 require(token:string){if(!this.status(token))throw new ApiError(403,'Unlock administrator access first.');}
 lock(token:string){this.grants.delete(token);}
}
