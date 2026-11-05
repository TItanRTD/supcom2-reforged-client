import type {ReplayRevision} from './replay-version';
import type {LobbyProfileCache} from './native-lobby';
import type {ResearchRuleset} from '../server/research-publication';
import {Worker} from 'node:worker_threads';
import path from 'node:path';
export interface PreparationOptions{replayPresentation?:boolean;replayFile?:string;rankedMatch?:boolean;replayRevision?:ReplayRevision;freshRuntime?:boolean;expectedLobby?:LobbyProfileCache;researchRuleset?:ResearchRuleset;hudScale?:number;onProgress?:(stage:string,detail?:string)=>unknown}
interface Limits{stallMs?:number;totalMs?:number;pollMs?:number;stopMs?:number}
/** One writer at a time. A timeout never leaves an unobserved preparation job
 * writing behind a subsequent launch. Atomic output journals remain recoverable.
 */
export class PreparationRunner{
 private active:Worker|null=null;
 constructor(private create:(file:string,args:unknown[])=>Worker=(file,args)=>new Worker(file,{workerData:{args}})){}
 async run<T>(args:unknown[],options:PreparationOptions={},limits:Limits={}):Promise<T>{
  if(this.active)throw Error('The previous game preparation is still stopping. Wait for it to stop, or restart the client before retrying.');
  const w=this.create(path.join(__dirname,'native-preparation-worker.js'),args);this.active=w;
  const started=Date.now();let activity=started,lastKey='',stage='starting-preparation-worker',finished=false;
  const notify=(s:string,d?:string)=>{try{void Promise.resolve(options.onProgress?.(s,d)).catch(()=>{});}catch{/* Diagnostic failure cannot change a prepared game. */}};
  notify(stage);
  return new Promise<T>((resolve,reject)=>{
   const stop=async(error?:Error,result?:T)=>{
    if(finished)return;finished=true;clearInterval(timer);
    let stopped=false;const termination=Promise.resolve().then(()=>w.terminate()).then(()=>{stopped=true;if(this.active===w)this.active=null;},()=>{/* Keep the writer lock until a real exit; never overlap a live worker. */});
    let deadline:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([termination,new Promise<void>(r=>{deadline=setTimeout(r,limits.stopMs??5000);})]);if(deadline)clearTimeout(deadline);
    if(error)reject(Error(error.message+(stopped?'':' The worker is still stopping; restart the client before retrying.')));else resolve(result!);
   };
   const timer=setInterval(()=>{
    const now=Date.now(),quiet=now-activity,elapsed=now-started;
    if(quiet>(limits.stallMs??90000)||elapsed>(limits.totalMs??240000))void stop(Error('Game preparation timed out at '+stage+' after '+Math.round(elapsed/1000)+' seconds. Export launch diagnostics from Settings before retrying.'));
   },limits.pollMs??1000);
   w.on('message',(m:unknown)=>{
    if(finished||!m||typeof m!=='object')return;const v=m as {kind?:unknown;stage?:unknown;detail?:unknown;result?:T;error?:unknown};
    if(v.kind==='progress'&&typeof v.stage==='string'&&/^preparing-[a-z0-9-]{1,48}$/.test(v.stage)){
     stage=v.stage;const detail=typeof v.detail==='string'?v.detail.slice(0,900):undefined,key=stage+'|'+(detail??'');
     if(key!==lastKey){lastKey=key;activity=Date.now();notify(stage,detail);}return;
    }
    if(v.kind==='complete')void stop(undefined,v.result);
    if(v.kind==='failed')void stop(Error('Game preparation failed at '+stage+': '+(typeof v.error==='string'?v.error:'worker error')));
   });
   w.once('error',e=>void stop(Error('Game preparation worker failed at '+stage+': '+e.message)));
   w.once('exit',code=>{if(this.active===w)this.active=null;if(!finished)void stop(Error('Game preparation worker closed at '+stage+' (exit '+code+').'));});
  });
 }
}
const runner=new PreparationRunner();
export const runNativePreparation=<T>(args:unknown[],options:PreparationOptions)=>runner.run<T>(args,options);
