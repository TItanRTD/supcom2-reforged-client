import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import path from 'node:path';
import {ApiError} from './lobby';
import {Accounts} from './accounts';
export interface SocialMessage {id:string;from:string;name:string;to:string|null;text:string;at:string}
export class SocialChat {
 private rows:SocialMessage[]=[];private loaded=false;private loading:Promise<void>|null=null;private queue:Promise<unknown>=Promise.resolve();private rates=new Map<string,number[]>();
 constructor(private accounts:Accounts,private file?:string,private now=()=>Date.now()){}
 private async load(){if(this.loaded)return;if(!this.loading)this.loading=this.read();try{await this.loading;}finally{this.loading=null;}}
 private async read(){if(this.file)try{if((await stat(this.file)).size>16*1024*1024)throw Error('Chat store is too large.');const d=JSON.parse(await readFile(this.file,'utf8'));if(d.schema!==1||!Array.isArray(d.messages))throw Error('Invalid chat store.');this.rows=d.messages.slice(-3000);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}this.loaded=true;}
 private async friend(id:string,to:string){if(!(await this.accounts.friends(id)).some(f=>f.id===to&&f.status==='friend'))throw new ApiError(403,'Direct messages are available to accepted friends.');}
 async list(id:string,to:unknown){await this.load();if(to!==null&&typeof to!=='string')throw new ApiError(400,'Choose Global or a friend.');if(to!==null)await this.friend(id,to as string);return this.rows.filter(m=>to===null?m.to===null:(m.from===id&&m.to===to||m.from===to&&m.to===id)).slice(-100).map(m=>({...m}));}
 async send(id:string,body:Record<string,unknown>){
  const to=body.to??null,text=typeof body.text==='string'?body.text.trim():'';
  if(!text||text.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw new ApiError(400,'Messages must contain 1–1000 characters.');
  if(to!==null&&typeof to!=='string')throw new ApiError(400,'Choose Global or a friend.');if(to!==null)await this.friend(id,to as string);
  const times=(this.rates.get(id)??[]).filter(t=>this.now()-t<10000);if(times.length>=5)throw new ApiError(429,'Wait a moment before sending another message.');this.rates.set(id,[...times,this.now()]);if(this.rates.size>1000)for(const [key,t]of this.rates)if(!t.some(v=>this.now()-v<10000))this.rates.delete(key);
  const who=await this.accounts.profile(id);const message:SocialMessage={id:randomUUID(),from:id,name:who.username,to:to as string|null,text,at:new Date(this.now()).toISOString()};
  const result=this.queue.then(async()=>{await this.load();if(to!==null)await this.friend(id,to as string);const next=[...this.rows,message].slice(-3000);if(this.file){await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.tmp-'+randomUUID();await writeFile(tmp,JSON.stringify({schema:1,messages:next}),{flag:'wx',mode:0o600});await rename(tmp,this.file);}this.rows=next;return message;});this.queue=result.catch(()=>{});return result;
 }
}
