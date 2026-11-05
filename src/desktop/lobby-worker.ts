import {parentPort} from 'node:worker_threads';
import {prepareLobbyAssets} from './native-lobby';
let serial:Promise<unknown>=Promise.resolve();
parentPort?.on('message',(m:{id:number;args:Parameters<typeof prepareLobbyAssets>})=>{
 serial=serial.catch(()=>{}).then(async()=>{try{const result=await prepareLobbyAssets(...m.args);parentPort!.postMessage({id:m.id,result});}catch(e){parentPort!.postMessage({id:m.id,error:e instanceof Error?e.message:'Game interface preparation failed.'});}});
});
