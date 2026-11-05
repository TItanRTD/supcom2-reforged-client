import {generateKeyPairSync,createHash,sign} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm,open} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ApiError} from './lobby';
import {PROTOCOL} from '../shared/model';
import {type SignedRelease,type ClientRelease,versionParts,newer,releaseBytes} from '../shared/releases';
export class ReleaseStore {
 private busy=false;private loading:Promise<void>|null=null;private privateKey='';private publicKey='';
 constructor(private root:string){}
 private async init(){if(this.privateKey)return;if(this.loading)return this.loading;this.loading=(async()=>{await mkdir(this.root,{recursive:true,mode:0o700});try{const k=JSON.parse(await readFile(path.join(this.root,'signing-key.json'),'utf8'));this.privateKey=k.privateKey;this.publicKey=k.publicKey;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const k=generateKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});await writeFile(path.join(this.root,'signing-key.json'),JSON.stringify(k),{mode:0o600,flag:'wx'});this.privateKey=k.privateKey;this.publicKey=k.publicKey;}})();try{await this.loading;}finally{this.loading=null;}}
 async key(){await this.init();return this.publicKey;}
 async latest():Promise<SignedRelease|null>{await this.init();try{return JSON.parse(await readFile(path.join(this.root,'latest.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
 artifact(hash:string){if(!/^[a-f0-9]{64}$/.test(hash))throw new ApiError(404,'Release not found.');return path.join(this.root,hash+'.exe');}
 async publish(version:string,notes:string,input:AsyncIterable<Buffer|string>){
  try{versionParts(version);}catch{throw new ApiError(400,'Use a version such as 0.15.0.');}if(typeof notes!=='string'||notes.length>2000)throw new ApiError(400,'Release notes must be at most 2000 characters.');if(this.busy)throw new ApiError(409,'Another release is being uploaded.');this.busy=true;
  let tmp:string|undefined;
  try{await this.init();const old=await this.latest();if(old&&!newer(version,old.release.version))throw new ApiError(409,'Publish a newer version than the current release.');tmp=path.join(this.root,'.upload-'+randomUUID());const file=await open(tmp,'wx',0o600),hash=createHash('sha256');let size=0,prefix=Buffer.alloc(0);
   try{for await(const chunk of input){const b=Buffer.from(chunk);size+=b.length;if(size>512*1024*1024)throw new ApiError(413,'Installer exceeds 512 MiB.');if(prefix.length<1024)prefix=Buffer.concat([prefix,b.subarray(0,1024-prefix.length)]);hash.update(b);await file.writeFile(b);}await file.sync();}finally{await file.close();}
   const pe=prefix.length>=64?prefix.readUInt32LE(60):0;if(size<1024||prefix.toString('ascii',0,2)!=='MZ'||pe>1000||prefix.toString('ascii',pe,pe+4)!=='PE\0\0')throw new ApiError(400,'Choose a Windows Reforged setup executable.');
   const sha256=hash.digest('hex');await rename(tmp,this.artifact(sha256));tmp=undefined;
   const release:ClientRelease={schema:1,version,protocol:PROTOCOL,sha256,size,path:'/updates/'+sha256+'.exe',publishedAt:new Date().toISOString(),notes};
   const signed:SignedRelease={release,signature:sign(null,Buffer.from(releaseBytes(release)),this.privateKey).toString('base64'),publicKey:this.publicKey};const pointer=path.join(this.root,'.latest-'+randomUUID());await writeFile(pointer,JSON.stringify(signed),{mode:0o600,flag:'wx'});await rename(pointer,path.join(this.root,'latest.json'));return signed;
  }finally{if(tmp)await rm(tmp,{force:true});this.busy=false;}
 }
}
