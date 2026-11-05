import path from 'node:path';
import {lstat,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export type FirewallReport={schema:number;program:string;networkProfiles:string[];truncated:boolean;policies?:{name:string;enabled:string;allowInboundRules:string;allowLocalFirewallRules:string}[];rules:{enabled:string;direction:string;action:string;profile:string;protocol?:string;localPort?:string[];remotePort?:string[];localAddress?:string[];remoteAddress?:string[]}[]};
const profiles=(s:string)=>s.split(/[,\s]+/).map(x=>x.toLowerCase());
const applies=(rule:FirewallReport['rules'][number],profile:string)=>profiles(rule.profile).some(x=>x==='any'||x===profile.toLowerCase());
export function firewallSummary(report:FirewallReport,wanted?:string[]){
 if(report.schema!==2||!Array.isArray(report.rules)||!Array.isArray(report.networkProfiles)||report.truncated)return {covered:false,message:'Firewall results are incomplete. Export launch diagnostics for review.'};
 const active=wanted??[...new Set(report.networkProfiles.map(p=>p==='DomainAuthenticated'?'Domain':p))];
 if(!active.length)return {covered:false,message:'Windows did not report an active network profile. Connect to your network and check again.'};
 const inbound=report.rules.filter(r=>r.enabled.toLowerCase()==='true'&&r.direction.toLowerCase()==='inbound');
 for(const p of active){
  const policy=report.policies?.find(r=>r.name.toLowerCase()===p.toLowerCase());
  if(policy?.enabled.toLowerCase()==='false')return {covered:false,message:`The ${p} firewall is disabled. Reforged did not change it.`};
  if(policy?.allowInboundRules.toLowerCase()==='false'||policy?.allowLocalFirewallRules.toLowerCase()==='false')return {covered:false,message:`Windows policy restricts local inbound rules on ${p}. Ask the PC administrator to allow the Reforged game.`};
  if(inbound.some(r=>r.action.toLowerCase()==='block'&&applies(r,p)))return {covered:false,message:`An inbound block rule applies to this game on ${p}. Review it in Windows Defender Firewall with Advanced Security; Reforged leaves existing block rules unchanged.`};
 }
 const any=(v:string[]|undefined)=>!!v?.length&&v.every(x=>x==='Any'||x==='*');
 const missing=active.filter(p=>!['tcp','udp'].every(proto=>inbound.some(r=>r.action.toLowerCase()==='allow'&&applies(r,p)&&[proto,proto==='tcp'?'6':'17','any','256'].includes((r.protocol??'').toLowerCase())&&any(r.localPort)&&any(r.remotePort)&&any(r.localAddress)&&any(r.remoteAddress))));
 return missing.length?{covered:false,message:`No complete saved TCP/UDP permission for this game on ${missing.join(', ')}. Use Save firewall access${missing.includes('Public')?' with public networks selected':''}.`}:{covered:true,message:`Saved TCP/UDP access covers ${active.join(', ')} for the Reforged game.`};
}
export async function verifiedFirewallProgram(runtimeExecutable:string){
 const root=path.dirname(path.dirname(runtimeExecutable));
 const markerFile=path.join(root,'reforged-runtime.json'),m=await lstat(markerFile);if(!m.isFile()||m.isSymbolicLink()||m.nlink!==1||m.size>2_000_000)throw Error('Invalid runtime ownership.');
 const marker=JSON.parse(await readFile(markerFile,'utf8'));if(marker.owner!=='community.sc2.revival.steam-runtime'||marker.schema!==1)throw Error('Unowned game runtime.');
 const file=path.join(root,'bin','SupremeCommander2.ReforgedLobby.exe'),s=await lstat(file).catch(()=>null);
 if(!s)throw Error('Launch the Reforged game once, close it, then save firewall access here.');
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw Error('Invalid Reforged program.');return file;
}
const psQuote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
export async function gameFirewall(assets:string,program:string,setup:boolean,includePublic:boolean){
 if(process.platform!=='win32')throw Error('Windows Firewall settings are available in the Windows client.');
 const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 const read=async()=>{const r=await exec(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(assets,'firewall-status.ps1'),'-ProgramPath',program],{windowsHide:true,timeout:20_000,maxBuffer:128_000});return JSON.parse(r.stdout.replace(/^\uFEFF/,'')) as FirewallReport;};
 let report:FirewallReport;try{report=await read();}catch{if(!setup)throw Error('Windows could not read the firewall rules. Try Save firewall access with administrator permission, then check again.');report={schema:2,program,rules:[],networkProfiles:[],truncated:true};}const wanted=includePublic?['Private','Public']:['Private'];
 if(setup&&!firewallSummary(report,wanted).covered){
  // Arguments are quoted as PowerShell literals, then encoded as a complete
  // command. The renderer supplies only booleans, never a program or command.
  const args=['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',path.join(assets,'firewall-setup.ps1'),'-ProgramPath',program,'-Profiles',wanted.join(',')];
  const argString=args.map(a=>'"'+a+'"').join(' ');
  const command=`try { $p=Start-Process -FilePath ${psQuote(powershell)} -ArgumentList ${psQuote(argString)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`;
  try{await exec(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:120_000,maxBuffer:16384});}catch{throw Error('Windows firewall setup was cancelled or could not complete. Your existing rules were left in place. Check access for details.');}
  report=await read();
 }
 const summary=firewallSummary(report);return {message:summary.message,report,programId:createHash('sha256').update(program.toLowerCase()).digest('hex').slice(0,16)};
}

/** Automatic launch setup is limited to the owned, stable game executable.
 * Windows still owns administrator consent. A declined UAC is not retried for
 * every subsequent launch in the same client session. */
export function automaticFirewallPlan(report:FirewallReport){
 const summary=firewallSummary(report);
 const active=[...new Set(report.networkProfiles.map(p=>p==='DomainAuthenticated'?'Domain':p))];
 return {setup:!summary.covered&&/^No complete saved TCP\/UDP/.test(summary.message)&&active.every(p=>p==='Private'||p==='Public'),includePublic:active.includes('Public'),message:summary.message};
}
const autoAttempts=new Set<string>();
export async function ensureGameFirewall(assets:string,program:string){
 const verified=await verifiedFirewallProgram(path.join(path.dirname(program),'SupremeCommander2.exe'));
 if(path.resolve(verified).toLowerCase()!==path.resolve(program).toLowerCase())throw Error('Unexpected automatic firewall program.');
 const current=await gameFirewall(assets,verified,false,false),plan=automaticFirewallPlan(current.report),key=verified.toLowerCase();
 if(plan.setup&&!autoAttempts.has(key)){autoAttempts.add(key);return gameFirewall(assets,verified,true,plan.includePublic);}
 return current;
}
