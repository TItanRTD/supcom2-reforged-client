import {writeFile,link,readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
/** Publish complete bytes without replacing an existing immutable record. */
export async function immutableJson(file:string,text:string){
 const temporary=file+'.'+randomUUID()+'.tmp';
 try{await writeFile(temporary,text,{flag:'wx',mode:0o600});try{await link(temporary,file);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(await readFile(file,'utf8')!==text)throw Error('An immutable record already exists with different bytes.');}}
 finally{await rm(temporary,{force:true});}
}
