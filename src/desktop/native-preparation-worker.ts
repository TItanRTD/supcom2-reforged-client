import {parentPort,workerData} from 'node:worker_threads';
import {prepareNativeHostCore} from './native-host';
const progress=(stage:string,detail?:string)=>parentPort!.postMessage({kind:'progress',stage,detail});
const args=workerData.args as Parameters<typeof prepareNativeHostCore>;
args[12]={...args[12],onProgress:progress};
void prepareNativeHostCore(...args).then(result=>{
 parentPort!.postMessage({kind:'complete',result});parentPort!.close();
},error=>{parentPort!.postMessage({kind:'failed',error:error instanceof Error?error.message:String(error)});parentPort!.close();});
