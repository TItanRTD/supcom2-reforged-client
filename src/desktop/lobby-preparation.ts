import {Worker} from 'node:worker_threads';
import path from 'node:path';
import type {prepareLobbyAssets} from './native-lobby';
let worker:Worker|null=null,sequence=0;
const pending=new Map<number,{resolve:(value:Awaited<ReturnType<typeof prepareLobbyAssets>>)=>void;reject:(error:Error)=>void}>();
/** Keep CPU-heavy archive reconstruction away from networking and game-state polling. */
export function prepareLobbyOffThread(...args:Parameters<typeof prepareLobbyAssets>):ReturnType<typeof prepareLobbyAssets>{
 if(!worker){
  const instance=new Worker(path.join(__dirname,'lobby-worker.js'));worker=instance;
  instance.on('message',(m)=>{const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error)):p.resolve(m.result);if(!pending.size)instance.unref();});
  const fail=(error:Error)=>{if(worker!==instance)return;worker=null;for(const p of pending.values())p.reject(error);pending.clear();};
  instance.on('error',fail);instance.on('exit',()=>fail(Error('Game interface preparation worker closed.')));
 }
 const current=worker,id=++sequence;current.ref();
 return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});try{current.postMessage({id,args});}catch(e){pending.delete(id);reject(e);if(!pending.size)current.unref();}});
}
