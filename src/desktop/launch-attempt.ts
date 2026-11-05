import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CLIENT_VERSION} from '../shared/model';

/** Write before preflight or any server request. Never receive account tokens. */
export class LaunchAttempt {
 private history:{at:string;stage:string;detail?:string}[]=[];
 private queue:Promise<void>=Promise.resolve();
 private constructor(readonly file:string,private mode:string){}
 static async begin(root:string,mode:string){
  await mkdir(root,{recursive:true});
  const log=new LaunchAttempt(path.join(root,`launch-attempt-${Date.now()}-${randomUUID()}.json`),mode);
  await log.record('requested');return log;
 }
 progress(){const latest=this.history.at(-1);return{stage:latest?.stage??'requested',elapsedMs:Math.max(0,Date.now()-Date.parse(latest?.at??new Date().toISOString()))};}
 record(stage:string,detail?:string){
  const clean=detail?.replace(/\b[a-f0-9]{64}\b/gi,'[redacted]').slice(0,1000);
  this.history.push({at:new Date().toISOString(),stage,...(clean?{detail:clean}:{})});
  const bytes=JSON.stringify({format:'s2r-launch-attempt-v1',clientVersion:CLIENT_VERSION,mode:this.mode,stage,history:this.history.slice(-40)},null,2);
  // A later diagnostic write failure must not tear down an already running game.
  this.queue=this.queue.catch(()=>{}).then(()=>writeFile(this.file,bytes,{mode:0o600})).catch(()=>{});return this.queue;
 }
}
