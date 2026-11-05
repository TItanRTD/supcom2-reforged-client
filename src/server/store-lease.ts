import {createServer,type Server} from 'node:net';
import {createHash} from 'node:crypto';
import {mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
// OS-owned loopback lease prevents concurrent production account-store writers.
// A hash collision refuses startup; it never admits simultaneous writers.
export async function acquireStoreLease(file:string):Promise<()=>Promise<void>>{
 await mkdir(path.dirname(file),{recursive:true,mode:0o700});
 let identity=path.join(await realpath(path.dirname(file)),path.basename(file));if(process.platform==='win32')identity=identity.toLowerCase();
 const port=20000+createHash('sha256').update(identity).digest().readUInt32LE(0)%20000;
 const guard:Server=createServer(socket=>socket.destroy());
 try{await new Promise<void>((resolve,reject)=>{guard.once('error',reject);guard.listen({host:'127.0.0.1',port,exclusive:true},resolve);});}
 catch{throw new Error('Another server is using this account store, or its local ownership port is occupied. Stop the embedded server or the other Server Manager, then retry.');}
 let closed=false;return async()=>{if(closed)return;closed=true;await new Promise<void>(r=>guard.close(()=>r()));};
}
