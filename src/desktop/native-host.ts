import { readFile, writeFile, mkdir, realpath, lstat, rename, rm, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { TESTED_EXE_SHA256 } from './adapter';
import {prepareLobbyAssets,type LobbyProfileCache} from './native-lobby';
const preparedResearch=new Map<string,LobbyProfileCache>();
const recoveredInterfaces=new Set<string>();
import {runNativePreparation,type PreparationOptions} from './preparation-monitor';
import { prepareSteamRuntime } from './steam-runtime';
import { MapHandoffTracker } from './map-handoff';
import { LiveLobbyTracker } from './live-lobby';
import { detectHudScale } from './hud-display';
import { CLIENT_VERSION } from '../shared/model';
const exec = promisify(execFile);
export const powershellPath = () => path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
export async function launchPreflight(): Promise<void> {
  try {
    await exec(powershellPath(), ['-NoProfile','-NonInteractive','-Command',
      "if (@(Get-Process -Name 'SupremeCommander2*' -ErrorAction SilentlyContinue).Count -gt 0) { exit 9 }; if (@(Get-Process -Name 'steam' -ErrorAction SilentlyContinue).Count -eq 0) { exit 10 }"], { windowsHide: true, timeout: 10_000 });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 9) throw new Error('Close SupCom 2 before launching from Revival.');
    if (code === 10) throw new Error('Keep Steam running before launching SupCom 2.');
    throw new Error('Could not check game/Steam processes using Windows PowerShell.');
  }
}
async function ordinary(file: string): Promise<void> {
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error('Hosting test paths must not be links.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
export async function prepareNativeHost(executable: string, assets: string, runRoot: string,mapId?:string,lanProbe=false,customLobby=false,guestAddress?:string,steamGuest=false,lobbyTitle?:string,relay=false,preferences?:{faction:string;colour:string;name?:string},legacyReplay=false,options:PreparationOptions={}) {
  options.onProgress?.('preparing-display-settings');
  const hudScale=options.hudScale??(customLobby?await detectHudScale():1);
  const key=JSON.stringify([path.resolve(executable),path.resolve(assets),customLobby,hudScale,legacyReplay,options.researchRuleset?.id,options.replayRevision,options.replayPresentation===true,options.replayFile]);
  const result=await runNativePreparation<Awaited<ReturnType<typeof prepareNativeHostCore>>>([executable,assets,runRoot,mapId,lanProbe,customLobby,guestAddress,steamGuest,lobbyTitle,relay,preferences,legacyReplay,{hudScale,replayPresentation:options.replayPresentation,replayFile:options.replayFile,replayRevision:options.replayRevision,rankedMatch:options.rankedMatch,researchRuleset:options.researchRuleset,expectedLobby:preparedResearch.get(key),freshRuntime:recoveredInterfaces.has(key)}],options);
  if(result.lobbyCache){preparedResearch.set(key,structuredClone(result.lobbyCache));if(preparedResearch.size>8)preparedResearch.delete(preparedResearch.keys().next().value!);}
  if(result.freshRuntime){recoveredInterfaces.add(key);if(recoveredInterfaces.size>16)recoveredInterfaces.delete(recoveredInterfaces.values().next().value!);}
  return result;
}
export interface PreparedNativeGame{candidatePath:string;gameLog:string;eventLog:string;run:string;runId:string;freshRuntime:boolean;lobbyCache?:LobbyProfileCache}
export async function prepareNativeHostCore(executable: string, assets: string, runRoot: string,mapId?:string,lanProbe=false,customLobby=false,guestAddress?:string,steamGuest=false,lobbyTitle?:string,relay=false,preferences?:{faction:string;colour:string;name?:string},legacyReplay=false,options:PreparationOptions={}):Promise<PreparedNativeGame> {
  const progress=(stage:string,detail?:string)=>options.onProgress?.(stage,detail);
  if(options.researchRuleset)progress('preparing-research','Research version '+options.researchRuleset.id.slice(0,12));
  progress('preparing-runtime');
  if(options.replayPresentation&&(!steamGuest||!customLobby||lanProbe||relay||mapId||guestAddress))throw Error('Replay presentation requires isolated playback.');
  if(legacyReplay&&(!steamGuest||!customLobby||lanProbe||relay||mapId||guestAddress))throw Error('Invalid legacy replay presentation mode.');
  const guestBuilder=guestAddress!==undefined?require(path.join(assets,'guest','guest.cjs')):null;
  if(guestBuilder){if(!customLobby||!lanProbe||mapId)throw Error('Invalid native guest probe mode.');if(!relay)guestBuilder.endpoint(guestAddress);}
  if(steamGuest&&(!customLobby||lanProbe||mapId||guestAddress))throw Error('Invalid Steam guest UI mode.');
  const source = await realpath(await prepareSteamRuntime(executable,assets,runRoot,legacyReplay,progress,options.researchRuleset?.id,options.freshRuntime));
  if (path.basename(source).toLowerCase() !== 'supremecommander2.exe' || path.basename(path.dirname(source)).toLowerCase() !== 'bin')
    throw new Error('Select SupremeCommander2.exe in the game’s bin folder.');
  const root = path.dirname(path.dirname(source));
  if (root.toLowerCase().split(path.sep).includes('steamapps')) throw new Error('For hosting, select SupremeCommander2.exe in your tested copy: D:\\SC2Revival\\SupCom2-Visual-Test\\bin.');
  const builder = require(path.join(assets,'host','direct-host.cjs')) as {
    BASELINE: string; CANDIDATE: string; hash(b: Buffer): string;
    build(source: Buffer,payload: Buffer,mode: string,log: string): { exe: Buffer; manifest: object };
  };
  const required = [
    [source, TESTED_EXE_SHA256],
    [path.join(root,'toc.original.win.bdf'),'cdf78bcf66a88368db4517edf0a1e42b9c55e017f2a3e22b563179f78c3dbe4c'],
    [path.join(root,'gamedata','ui.scd'),'fd628cef9a743a554c1c03554328c01fbf3a3d47a55b699fa86abfad0ed105ce'],
    [path.join(root,'gamedata','ui.scd.enc'),'175e6f24038ab6033c2ebf17e49a80ffbe3198c677e84cba1b41299365e4b4c5'],
  ];
  for (const [file,expected] of required) {
    progress('preparing-verify-originals',path.basename(file));
    await ordinary(file);
    let bytes: Buffer; try { bytes = await readFile(file); } catch { throw new Error('Hosting requires the existing tested game copy, including toc.original.win.bdf.'); }
    if (builder.hash(bytes) !== expected) throw new Error(`The hosting test copy has a different baseline: ${path.basename(file)}.`);
  }
  progress('preparing-interface-files');
  let lobbyAssets:Awaited<ReturnType<typeof prepareLobbyAssets>>;
  try{lobbyAssets=await prepareLobbyAssets(root,assets,customLobby,customLobby,options.hudScale??1,legacyReplay,progress,options.researchRuleset,options.expectedLobby,true,options.replayRevision,options.replayPresentation===true,options.replayFile);}
  catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(!options.freshRuntime&&['S2R_INTERFACE_UNKNOWN','EACCES','EPERM','EBUSY','ENOENT'].includes(code??'')){
      progress('preparing-fresh-runtime','Preserved the previous interface; preparing a separate game copy.');
      return prepareNativeHostCore(executable,assets,runRoot,mapId,lanProbe,customLobby,guestAddress,steamGuest,lobbyTitle,relay,preferences,legacyReplay,{...options,freshRuntime:true,expectedLobby:undefined});
    }
    throw error;
  }
  const probe = path.join(root,'gamedata','supcom2_revival_ui_probe.scd');
  if (!(await lstat(probe).catch(() => null))?.isFile()) throw new Error('Keep the successful v0.3 UI probe installed in the hosting copy.');
  const runId = randomUUID(); const run = path.join(runRoot,`${guestBuilder?'guest':'host'}-${Date.now()}-${runId}`);
  await mkdir(run,{recursive:true});
  const eventLog = path.join(run,'native-events.log'), gameLog = path.join(run,guestBuilder?'supcom2-guest.sclog':'supcom2-host.sclog');
  progress('preparing-native-executable','Game diagnostic folder: '+run);
  const sourceBytes=await readFile(source),hostBytes=await readFile(path.join(assets,'host','direct-host-x86.bin'));
  const lobbyBuilder=customLobby?require(path.join(assets,'lobby','lobby-host.cjs')):null;
  let result = steamGuest?lobbyBuilder.buildSteamGuest(sourceBytes,hostBytes,eventLog):guestBuilder?guestBuilder.build(sourceBytes,hostBytes,eventLog,guestAddress,relay):lobbyBuilder?lobbyBuilder.build(sourceBytes,hostBytes,eventLog,mapId,lanProbe):lanProbe?require(path.join(assets,'host','lan-host.cjs')).build(sourceBytes,hostBytes,'Lobby',eventLog,mapId):mapId?require(path.join(assets,'host','map-handoff.cjs')).build(sourceBytes,hostBytes,'Lobby',eventLog,mapId):builder.build(sourceBytes,hostBytes,'Lobby',eventLog);
  const candidatePe=builder as typeof builder & {pe:(b:Buffer)=>{nt:number}};
  if(!(result.exe.readUInt16LE(candidatePe.pe(result.exe).nt+22)&0x20))throw Error('Reforged candidate lost the verified Large Address Aware flag.');
  result.manifest={...result.manifest,memory:{largeAddressAware:true,baselineAlreadyEnabled:true,maxVirtualAddressSpaceOn64BitWindows:'4 GB',playerLimitChanged:false}};
  if(relay)result=lobbyBuilder.relayOnly(result);
  if(customLobby&&lobbyTitle)result=lobbyBuilder.withTitle(result,lobbyTitle);
  if(customLobby&&preferences)result=lobbyBuilder.withPreferences(result,preferences);
  if(customLobby&&relay&&preferences?.name)result=lobbyBuilder.withPlayerName(result,preferences.name);
  if(customLobby){result=lobbyBuilder.withServices(result,path.join(run,'lobby-services.bin'),options.rankedMatch===true);result=require(path.join(assets,'hud','presentation.cjs')).apply(result,{readOnly:legacyReplay});}
  if(customLobby)result=require(path.join(assets,'host','lua-panic.cjs')).apply(result,eventLog);
  if(customLobby)result=require(path.join(assets,'hud','display-dpi.cjs')).apply(result);
  require(path.join(assets,'validate-image.cjs')).validateImage(result.exe);
  // A fixed program path lets Windows retain the user's per-app firewall choice
  // when switching between hosting, joining and watching within this runtime.
  const candidatePath = path.join(path.dirname(source),'SupremeCommander2.ReforgedLobby.exe');
  await ordinary(candidatePath);
  progress('preparing-save-executable');
  const temporary = candidatePath+'.'+runId+'.tmp';
  try { await writeFile(temporary,result.exe,{flag:'wx'}); await rename(temporary,candidatePath); }
  finally { await rm(temporary,{force:true}); }
  progress('preparing-save-manifest');
  await writeFile(path.join(run,'direct-host-manifest.json'),JSON.stringify({...result.manifest,clientVersion:CLIENT_VERSION,firewallProgramPath:candidatePath,runtimeRoot:root,freshInterface:options.freshRuntime===true,replayPresentation:options.replayPresentation===true,lobbyAssets,researchId:options.researchRuleset?.id,replayRevision:options.replayRevision},null,2));
  if(process.platform==='win32'){
    try{
      const {stdout}=await exec(powershellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(assets,'firewall-status.ps1'),'-ProgramPath',candidatePath],{windowsHide:true,timeout:6000,maxBuffer:65536});
      const status=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
      const {firewallSummary}=await import('./game-firewall');status.assessment=firewallSummary(status);status.at=new Date().toISOString();
      await writeFile(path.join(run,'firewall-status.json'),JSON.stringify(status,null,2));
    }catch(error){await writeFile(path.join(run,'firewall-status.json'),JSON.stringify({schema:1,program:candidatePath,unavailable:true,message:String((error as Error).message).slice(0,1024)}));}
  }
  return { candidatePath, gameLog, eventLog, run, runId,freshRuntime:options.freshRuntime===true,...('cache' in lobbyAssets?{lobbyCache:lobbyAssets.cache}: {}) };
}
export function watchGameLobby(pid: number, assets: string, diagnosticPath: string, tracker: LiveLobbyTracker,mapTracker?:MapHandoffTracker,onSample?:(sample:unknown)=>void): { stop(): void } {
  const child: ChildProcess = spawn(powershellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(assets,'read-lobby.ps1'),'-GameProcessId',String(pid)],
    { windowsHide:true, shell:false, stdio:['ignore','pipe','pipe'] });
  let pending = '', stopped = false, previous = '';
  child.stdout!.on('data',(chunk: Buffer) => {
    pending += chunk.toString('utf8');
    if (pending.length > 16_384) { tracker.unavailable('Lobby reader exceeded its message limit.');mapTracker?.unavailable(); child.kill(); return; }
    let at: number;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0,at).trim(); pending = pending.slice(at+1);
      if (!line) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); tracker.ingest(raw);mapTracker?.ingest(raw);onSample?.(raw); } catch { tracker.unavailable('Could not decode lobby-reader output.');mapTracker?.unavailable(); }
      const observation = tracker.get();
      const key = JSON.stringify([raw,observation.status,observation.role,observation.lobbyId,observation.message]);
      if (key !== previous) { previous = key; void appendFile(diagnosticPath,JSON.stringify({time:new Date().toISOString(),reader:raw,lobby:observation})+'\n').catch(() => {}); }
    }
  });
  let diagnosticBytes = 0;
  child.stderr!.on('data',(chunk: Buffer) => {
    mapTracker?.unavailable();tracker.unavailable('Windows could not read this game’s lobby state. Open the log folder for diagnostics.');
    if (diagnosticBytes < 16384) {
      const text = chunk.toString('utf8').slice(0,16384-diagnosticBytes); diagnosticBytes += text.length;
      void appendFile(diagnosticPath,JSON.stringify({kind:'reader-error',message:text})+'\n').catch(()=>{});
    }
  });
  child.once('error',() => {tracker.unavailable('The Windows lobby reader could not start.');mapTracker?.unavailable();});
  child.once('exit',() => { if (!stopped){tracker.unavailable('Lobby reader stopped; automatic link sharing paused.');mapTracker?.unavailable();} });
  return { stop() { stopped = true; child.kill();mapTracker?.unavailable('Game monitoring stopped; map confirmation cleared.'); tracker.unavailable('Game lobby monitoring stopped.'); } };
}
