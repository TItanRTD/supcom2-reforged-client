import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
export interface ServerSettings{schema:1;address:string;accessKey:string;autoStart:boolean;startOnClient?:boolean}
export class ServerSettingsStore{
 private queue:Promise<unknown>=Promise.resolve();constructor(private file:string){}
 private validate(v:unknown):ServerSettings{const s=v as ServerSettings;if(!s||s.schema!==1||typeof s.address!=='string'||!/^\d{1,3}(\.\d{1,3}){3}$/.test(s.address)||s.address.split('.').some(n=>+n>255)||typeof s.accessKey!=='string'||!/^[a-f0-9]{48}$/.test(s.accessKey)||typeof s.autoStart!=='boolean'||(s.startOnClient!==undefined&&typeof s.startOnClient!=='boolean'))throw new Error('Server settings are invalid. Restore the settings file before starting.');return {schema:1,address:s.address,accessKey:s.accessKey,autoStart:s.autoStart,startOnClient:s.startOnClient??true};}
 async exists(){try{await readFile(this.file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
 async load(){try{return this.validate(JSON.parse(await readFile(this.file,'utf8')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}return {schema:1 as const,address:'127.0.0.1',accessKey:randomBytes(24).toString('hex'),autoStart:false,startOnClient:true};}
 save(value:ServerSettings){const s=this.validate(value),work=this.queue.then(async()=>{await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const temp=this.file+'.tmp-'+randomBytes(8).toString('hex');try{await writeFile(temp,JSON.stringify(s,null,2),{mode:0o600,flag:'wx'});await rename(temp,this.file);}finally{await rm(temp,{force:true});}return s;});this.queue=work.catch(()=>{});return work;}
}
