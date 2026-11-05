import {lstat,mkdir,readFile,realpath,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

function folderPath(value:unknown):value is string{
 return typeof value==='string'&&value.length>0&&value.length<=32767&&path.isAbsolute(value)&&!/[\x00-\x1f]/.test(value);
}
/** Replay preferences are independent of the selected game and account. */
export class ReplayFolderStore{
 private serial:Promise<unknown>=Promise.resolve();
 constructor(private file:string){}
 async load():Promise<string|null>{
  try{
   const info=await lstat(this.file);
   if(!info.isFile()||info.isSymbolicLink()||info.size>65536)throw Error('Invalid replay-folder settings.');
   const data=JSON.parse(await readFile(this.file,'utf8'));
   if(data?.schema!==1||!folderPath(data.folder))throw Error('Invalid saved replay folder.');
   // Keep a disconnected/moved folder preference so it can return later.
   return data.folder;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
 }
 async save(value:unknown):Promise<string>{
  const work=this.serial.then(async()=>{
   if(!folderPath(value))throw Error('Choose a Supreme Commander 2 replay folder.');
   const info=await lstat(value);
   if(!info.isDirectory()||info.isSymbolicLink())throw Error('Choose a regular replay folder.');
   const folder=await realpath(value);
   const data=JSON.stringify({schema:1,folder},null,2)+'\n';
   if(Buffer.byteLength(data)>65536)throw Error('Replay folder path is too long to save.');
   await mkdir(path.dirname(this.file),{recursive:true});
   const temp=this.file+'.'+randomUUID()+'.tmp';
   try{await writeFile(temp,data,{flag:'wx',mode:0o600});await rename(temp,this.file);}
   finally{await rm(temp,{force:true});}
   return folder;
  });
  this.serial=work.catch(()=>{});return work;
 }
}
