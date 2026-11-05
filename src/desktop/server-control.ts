import {createServer} from 'node:http';
import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import path from 'node:path';
export async function serveOwnerControl(directory:string,handlers:{pause:()=>Promise<void>;resume:()=>Promise<void>}){
 const file=path.join(directory,'owner-control.json'),nonce=randomBytes(32).toString('hex');
 const server=createServer(async(req,res)=>{
  const reply=(code:number,value:unknown)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const key=req.headers.authorization?.replace(/^Bearer /,'');
  if(req.headers.origin||req.method!=='POST'||req.url!=='/owner'||!key||!/^[a-f0-9]{64}$/.test(key)||!timingSafeEqual(Buffer.from(key),Buffer.from(nonce))){reply(403,{error:'Owner control denied.'});return;}
  try{let bytes='';for await(const b of req){bytes+=b;if(bytes.length>256)throw Error('Invalid control request.');}const action:unknown=JSON.parse(bytes).action;if(action!=='pause'&&action!=='resume')throw Error('Unknown owner action.');await handlers[action]();reply(200,{ok:true});}catch(e){reply(409,{error:(e as Error).message});}
 });
 server.requestTimeout=20_000;server.headersTimeout=5000;
 await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
 const record={schema:1,port:(server.address() as {port:number}).port,nonce,pid:process.pid},temp=file+'.tmp-'+randomBytes(6).toString('hex');
 try{await mkdir(directory,{recursive:true,mode:0o700});await writeFile(temp,JSON.stringify(record),{flag:'wx',mode:0o600});await rename(temp,file);}catch(e){server.close();await rm(temp,{force:true});throw e;}
 return async()=>{await new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();});try{const saved=JSON.parse(await readFile(file,'utf8'));if(saved.nonce===nonce)await rm(file,{force:true});}catch{/* Already removed. */}};
}
export async function ownerControl(directory:string,action:'pause'|'resume'){
 let raw:string;try{raw=await readFile(path.join(directory,'owner-control.json'),'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
 const record=JSON.parse(raw);if(record.schema!==1||!Number.isInteger(record.pid)||record.pid<1||!Number.isInteger(record.port)||record.port<1||record.port>65535||typeof record.nonce!=='string'||!/^[a-f0-9]{64}$/.test(record.nonce))throw Error('Owner control record is invalid. Open the updated Server Manager and retry.');
 let response:Response;try{response=await fetch('http://127.0.0.1:'+record.port+'/owner',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+record.nonce},body:JSON.stringify({action}),signal:AbortSignal.timeout(20_000)});}catch(e){
  // A hard process exit can leave its control record. Only retire it when the
  // OS confirms that exact owner PID no longer exists; never stop a process.
  let gone=false;try{process.kill(record.pid,0);}catch(p){gone=(p as NodeJS.ErrnoException).code==='ESRCH';}
  if(gone){const current=JSON.parse(await readFile(path.join(directory,'owner-control.json'),'utf8'));if(current.nonce===record.nonce){await rm(path.join(directory,'owner-control.json'));return false;}}
  throw e;
 }const body=await response.json();if(!response.ok)throw Error(body.error??'Owner server could not pause.');return true;
}
