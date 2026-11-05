import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {powershellPath} from './native-host';
const exec=promisify(execFile);
const fields=['AppName','AppVersion','ModuleName','ModuleVersion','ExceptionCode','FaultingOffset','ModulePath','ReportId','at'] as const;
export function matchingCrashEvents(raw:unknown,pid:number,executable:string){
 const input=raw as {events?:unknown[]}|null;if(!input||!Array.isArray(input.events))return [];
 return input.events.slice(0,32).flatMap(value=>{
  if(!value||typeof value!=='object')return [];const e=value as Record<string,unknown>;
  if(e.processId!==pid||typeof e.appPath!=='string'||e.appPath.toLowerCase()!==executable.toLowerCase())return [];
  const result:Record<string,string|number>={processId:pid,appPath:executable};
  for(const field of fields)if(typeof e[field]==='string'&&e[field].length<=1024)result[field]=e[field];
  return [result];
 }).slice(0,4);
}
/** Read matching Windows Application Error records after a nonzero exit. Does
 * not attach a debugger, change error handling, or inspect another process. */
export async function captureWindowsCrash(pid:number,executable:string,startedAt:number,assets:string,run:string){
 if(process.platform!=='win32'||!Number.isSafeInteger(pid)||pid<=0||!Number.isFinite(startedAt))return;
 let status='unavailable',events:ReturnType<typeof matchingCrashEvents>=[];
 try{
  const {stdout}=await exec(powershellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(assets,'read-crash.ps1'),'-GameProcessId',String(pid),'-GamePath',executable,'-StartedAfter',new Date(startedAt).toISOString()],{windowsHide:true,timeout:7000,maxBuffer:65536});
  const raw=JSON.parse(stdout);events=matchingCrashEvents(raw,pid,executable);status=events.length?'collected':raw.status==='unavailable'?'unavailable':'no-matching-event';
 }catch{/* Diagnostic availability must not affect closing or starting a game. */}
 await writeFile(path.join(run,'windows-crash.json'),JSON.stringify({format:'s2r-windows-crash-v1',processId:pid,status,events},null,2));
}
