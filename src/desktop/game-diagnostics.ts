import {readdir,lstat,readFile,open} from 'node:fs/promises';
import path from 'node:path';
import {deflateRawSync} from 'node:zlib';
import {crc32} from './map-catalog';
import {CLIENT_VERSION} from '../shared/model';
import {parseAiEvents,aiDiagnosticsText,AiEvent} from './ai-diagnostics';

// Export one run, never account/configuration directories or arbitrary files.
const allowed=new Set(['direct-host-manifest.json','firewall-status.json','firewall-after-exit.json','native-events.log','lobby-services.bin','native-udp-status.json','live-lobby-observations.jsonl','relay-status.jsonl','supcom2-host.sclog','supcom2-guest.sclog','process-exit.json','windows-crash.json','relay-session.json','ranked-result.json','match.SC2Replay']);
function zip(entries:{name:string;data:Buffer}[]){
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0;
 for(const e of entries){const name=Buffer.from(e.name),data=deflateRawSync(e.data),crc=crc32(e.data),a=Buffer.alloc(30),b=Buffer.alloc(46);
  a.writeUInt32LE(0x04034b50);a.writeUInt16LE(20,4);a.writeUInt16LE(0x800,6);a.writeUInt16LE(8,8);a.writeUInt16LE(33,12);a.writeUInt32LE(crc,14);a.writeUInt32LE(data.length,18);a.writeUInt32LE(e.data.length,22);a.writeUInt16LE(name.length,26);
  b.writeUInt32LE(0x02014b50);b.writeUInt16LE(20,4);b.writeUInt16LE(20,6);b.writeUInt16LE(0x800,8);b.writeUInt16LE(8,10);b.writeUInt16LE(33,14);b.writeUInt32LE(crc,16);b.writeUInt32LE(data.length,20);b.writeUInt32LE(e.data.length,24);b.writeUInt16LE(name.length,28);b.writeUInt32LE(offset,42);
  local.push(a,name,data);central.push(b,name);offset+=a.length+name.length+data.length;
 }
 const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);
}
const runPattern=/^(host|guest)-[0-9]+-[a-f0-9-]{36}$/;
const attemptPattern=/^launch-attempt-([0-9]{1,16})-[a-f0-9-]{36}\.json$/;
const clean=(s:string)=>s.replace(/\b[a-f0-9]{64}\b/gi,'[redacted]').replace(/[\x00-\x1f\x7f]/g,' ');
interface Attempt {format:'s2r-launch-attempt-v1';clientVersion:string;mode:string;stage:string;history:{at:string;stage:string;detail?:string}[]}
async function readAttempt(base:string,file:string):Promise<Attempt>{
 if(path.dirname(path.resolve(file))!==base||!attemptPattern.test(path.basename(file)))throw Error('Choose a launch attempt from the diagnostic log folder.');
 const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>65536)throw Error('The latest launch attempt is unavailable. Open the diagnostic log folder to inspect it.');
 const handle=await open(file,'r');let bytes:Buffer;try{const data=Buffer.alloc(65537),r=await handle.read(data,0,data.length,0);if(r.bytesRead>65536)throw Error('Launch attempt exceeds its size limit.');bytes=data.subarray(0,r.bytesRead);}finally{await handle.close();}
 let value:Attempt;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw Error('The latest launch attempt is unreadable. Open the diagnostic log folder to inspect it.');}
 const stage=(x:unknown)=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x);
 if(value?.format!=='s2r-launch-attempt-v1'||typeof value.clientVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(value.clientVersion)||!['stock','diagnostic','host','join','lan-test','native-host','native-guest','relay-host','relay-guest','replay'].includes(value.mode)||!stage(value.stage)||!Array.isArray(value.history)||!value.history.length||value.history.length>40||value.history.some((h:Attempt['history'][number])=>!h||typeof h.at!=='string'||!Number.isFinite(Date.parse(h.at))||!stage(h.stage)||h.detail!==undefined&&(typeof h.detail!=='string'||h.detail.length>1000))||value.history.at(-1)?.stage!==value.stage)throw Error('The latest launch attempt is unreadable. Open the diagnostic log folder to inspect it.');
 // Export only the known record fields, never foreign configuration properties.
 return {format:'s2r-launch-attempt-v1',clientVersion:value.clientVersion,mode:value.mode,stage:value.stage,history:value.history.map((h:Attempt['history'][number])=>({at:h.at,stage:h.stage,...(h.detail?{detail:clean(h.detail)}:{})}))};
}
export async function gameDiagnostics(root:string,latestLog:string|null,attemptFile:string|null){
 const base=path.resolve(root);let contents:string[];
 try{const info=await lstat(base);if(!info.isDirectory()||info.isSymbolicLink())throw Error('Linked log directories cannot be exported.');contents=await readdir(base);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw Error('No launch diagnostics yet. Try launching a game or replay first.');throw e;}
 const runs:{name:string;time:number}[]=[];
 for(const name of contents){if(!runPattern.test(name))continue;try{const s=await lstat(path.join(base,name));if(s.isDirectory()&&!s.isSymbolicLink())runs.push({name,time:s.mtimeMs});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 // Recover the newest attempt after a client restart. An unreadable newest
 // record must not silently turn the export into an older, unrelated game.
 const newest=contents.filter(n=>attemptPattern.test(n)).sort((a,b)=>{const x=BigInt(a.match(attemptPattern)![1]),y=BigInt(b.match(attemptPattern)![1]);return x===y?a.localeCompare(b):x>y?-1:1;})[0];
 const file=attemptFile??(newest?path.join(base,newest):null),attempt=file?await readAttempt(base,file):null;
 let correlated:string|undefined;
 for(const h of attempt?.history??[]){if(!h.detail?.startsWith('Game diagnostic folder: '))continue;const folder=path.resolve(h.detail.slice('Game diagnostic folder: '.length));if(path.dirname(folder)===base&&runPattern.test(path.basename(folder)))correlated=path.basename(folder);}
 const selected=latestLog&&path.dirname(path.dirname(path.resolve(latestLog)))===base?path.basename(path.dirname(latestLog)):null;
 const run=attempt?runs.find(r=>r.name===correlated):runs.find(r=>r.name===selected)??runs.sort((a,b)=>b.time-a.time)[0];
 if(!attempt&&!run)throw Error('No launch diagnostics yet. Try launching a game or replay first.');
 const entries:{name:string;data:Buffer}[]=[],omitted:string[]=[],aiLogs:{file:string;events:AiEvent[]}[]=[];let total=0;
 if(correlated&&!run)omitted.push(correlated+': correlated game folder is unavailable');
 if(run)for(const name of (await readdir(path.join(base,run.name))).sort()){
  if(!allowed.has(name)&&!/^([^<>:/\\|?*\x00-\x1f]{1,220})\.SC2Replay(?:DLC)?(?:\.reforged\.json)?$/i.test(name))continue;
  try{const file=path.join(base,run.name,name),s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()){omitted.push(name+': not an ordinary file');continue;}
   const gameLog=/^supcom2-(host|guest)\.sclog$/.test(name),max=/\.SC2Replay(?:DLC)?$/i.test(name)?32*1024*1024:16*1024*1024;
   if(!gameLog&&s.size>max||total+Math.min(s.size,max)>64*1024*1024){omitted.push(name+': exceeds export size limit');continue;}
   let data:Buffer;
   if(gameLog){
    const handle=await open(file,'r');try{const size=(await handle.stat()).size,start=Math.max(0,size-max+256),buffer=Buffer.alloc(Math.min(size,max-256));const r=await handle.read(buffer,0,buffer.length,start);data=buffer.subarray(0,r.bytesRead);
     if(start>0){const at=data.indexOf(10);data=Buffer.concat([Buffer.from('[Reforged diagnostics: earlier game-log content omitted; retained recent tail.]\n'),at>=0?data.subarray(at+1):Buffer.alloc(0)]);omitted.push(name+': exported recent log tail; earlier content omitted');}
    }finally{await handle.close();}
   }else data=await readFile(file);
   if(data.length>max||total+data.length>64*1024*1024){omitted.push(name+': grew beyond export size limit');continue;}entries.push({name:run.name+'/'+name,data});total+=data.length;
   if(/^supcom2-(host|guest)\.sclog$/.test(name))aiLogs.push({file:name,events:parseAiEvents(data.toString('utf8'))});
  }catch{omitted.push(name+': busy or unavailable');}
 }
 const observedAi=aiLogs.filter(x=>x.events.length>0);
 if(run&&observedAi.length){
  entries.push({name:run.name+'/ai-summary.txt',data:Buffer.from(observedAi.map(x=>'Game log: '+x.file+'\n'+aiDiagnosticsText(x.events)).join('\n\n'))});
  entries.push({name:run.name+'/ai-events.jsonl',data:Buffer.from(observedAi.flatMap(x=>x.events.map(event=>JSON.stringify({source:x.file,...event}))).join('\n')+'\n')});
 }
 if(attempt)entries.push({name:(run?run.name+'/':'')+'launch-attempt.json',data:Buffer.from(JSON.stringify(attempt,null,2))});
 const last=attempt?.history.at(-1),summary=[
  'Supreme Commander 2: Reforged diagnostics', 'Exporting client: '+CLIENT_VERSION,
  ...(attempt?['Recorded client: '+attempt.clientVersion,'Launch mode: '+attempt.mode,'Last stage: '+attempt.stage,'Recorded at: '+last!.at,...(last?.detail?['Last detail: '+last.detail]:[])]:[]),
  run?'Game folder: '+run.name:correlated?'The recorded game folder is no longer available.':'No prepared game folder was recorded for this attempt.',
  'A process launch record does not confirm successful game entry or replay playback.',
  ...(run?[observedAi.length?'AI execution: See ai-summary.txt for observed actions, failures and incomplete evidence.':'AI execution: No versioned Reforged AI events were found in the available game logs.']:[]),
  ...(attempt?['','Launch stages:',...attempt.history.map(h=>h.at+' | '+h.stage+(h.detail?' | '+h.detail:''))]:[]),
  ...(omitted.length?['','Omitted files:',...omitted]:[]),'',
 ];
 entries.push({name:'summary.txt',data:Buffer.from(summary.join('\n'))});
 entries.push({name:'export.json',data:Buffer.from(JSON.stringify({format:'s2r-game-diagnostics-v2',exportedAt:new Date().toISOString(),clientVersion:CLIENT_VERSION,run:run?.name??null,attempt:file?path.basename(file):null,files:entries.map(e=>e.name),omitted},null,2))});
 return {name:'S2R-'+(run?.name??path.basename(file!,'.json'))+'.zip',bytes:zip(entries),message:run?'Exported the game logs and launch summary. For multiplayer diagnosis, export the same attempt on both PCs.':'Exported the latest launch attempt and summary. No unrelated game logs were included.'};
}
