import {replayRevision} from './replay-version';
import {clientPaths,clientUserData,setClientDataDirectory} from './client-paths';
import {boundedStockResearchIcons} from './research-icons';
import {mapDownload,downloadMapToFile} from './map-download';
import {installMapPackage,ensureGameMap,type MapInstallProgress} from './map-install';
import {fetchRoomResearch} from './research-rules';
import {readReplayResearch,readReplayVersion} from './replay-provenance';
import {researchDocument} from '../shared/research';
import {RankedResultReporter,finishReportedGame} from './ranked-results';
import {captureWindowsCrash} from './windows-crash';
import {LobbyServices} from './lobby-services';
import {ClientUpdates,publishClient} from './updates';
import { app, BrowserWindow, dialog, ipcMain, shell, screen, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile, writeFile, rm, stat, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectExecutable, steamLaunchArguments, validateLobbyId } from './adapter';
import { LocalMapCatalog } from './map-catalog';
import { readGameLog } from './logs';
import { PROTOCOL, CLIENT_VERSION, type MatchManifest, type LaunchStatus, type SavedAccount } from '../shared/model';

import { prepareNativeHost, launchPreflight, watchGameLobby } from './native-host';
import {withRoomHeartbeat} from './host-preparation';
import {LocalReplays} from './replays';
import {detectReplayPlayback,finishSavedReplay,replayPlayers} from './replay-provenance';
import {LobbyMapPublisher} from './lobby-map';
import {ReplayFolderStore} from './replay-settings';
import {prepareReplayPlayback,replayPlayback} from './replay-playback';
import {NativeMeshRelayClient as NativeRelayClient} from './mesh-relay';
import {LaunchAttempt} from './launch-attempt';
import { authorizeNativeGuestProbe } from './native-guest';
import { NativeRoomHost, NativeLobbyObservation } from './native-room';
import { prepareLobbyAssets } from './native-lobby';
import { prepareSteamRuntime } from './steam-runtime';
import { MapHandoffTracker } from './map-handoff';
import { LiveLobbyTracker } from './live-lobby';
import { HostRoomShare, validateHostRoom, joinedRoomTitle, roomApi, ownsRoom } from './room-share';
import { DesktopRoomServer } from './private-server';
const serverMode=process.argv.includes('--s2r-server'),publicBoot=process.argv.includes('--s2r-public-boot');
const APP_ID='community.sc2.revival';let serverLock=true;
const dataPaths=clientPaths(app.getPath('appData'));
// Electron used the package name as its default data directory in older builds.
// Keep an existing client directory when adopting the new package name.
const useClientData=(directory:string)=>setClientDataDirectory(directory,(name,value)=>app.setPath(name,value));
if(!app.commandLine.hasSwitch('user-data-dir'))useClientData(clientUserData(app.getPath('userData'),dataPaths.client));
const accountDirectory=()=>path.join(dataPaths.client,'server');
if(serverMode){useClientData(dataPaths.manager);serverLock=app.requestSingleInstanceLock();if(!serverLock)app.quit();}
if(publicBoot){useClientData(dataPaths.publicStartup);serverLock=app.requestSingleInstanceLock();if(!serverLock)app.quit();}
if(process.platform==='win32')app.setAppUserModelId(serverMode?APP_ID+'.server':APP_ID);
let tracker: LiveLobbyTracker | null = null;
let mapTracker:MapHandoffTracker|null=null;
let monitor: { stop(): void } | null = null;
const privateServer = new DesktopRoomServer(undefined,undefined,()=>path.join(app.getPath('userData'),'server','accounts.json'));
const shares = new HostRoomShare(() => tracker?.get() ?? { lobbyId: null, role: null, status: 'waiting', observedAt: Date.now(), message: 'No host process.' },roomApi,Date.now,(c,id,s)=>{void lobbyMaps.publish(c,id,s);});
const nativeAssets = () => app.isPackaged ? path.join(process.resourcesPath,'native') : path.resolve(__dirname,'../../../native');
let mapCatalog = new LocalMapCatalog();
let lobbyMaps=new LobbyMapPublisher(id=>mapCatalog.metadata(id));
let win: BrowserWindow | null = null;
let gamePath: string | null = null;
let launching = false;
let firewallBusy=false;
let gameProcessId:number|null=null;
let udpProbePid:number|null=null,udpRun:string|null=null,lastUdpObservation='';
let nativeObservation=new NativeLobbyObservation(),udpListenerAt=0;
const nativeRelay=new NativeRelayClient();
const nativeRoom=new NativeRoomHost(()=>nativeObservation.phase(udpListenerAt,!mapTracker||mapTracker.get().state==='confirmed'||!!lobbyMaps.current()),roomApi,()=>lobbyMaps.listing(nativeObservation.listing()),(c,id,s)=>{void lobbyMaps.publish(c,id,s);});
let lastLogPath: string | null = null;
let nativeGuestMessage='',relayLog:string|null=null,lastRelayLog='';
let lastAttemptLog:string|null=null;let currentAttempt:LaunchAttempt|null=null;
const crashCaptures=new Map<string,Promise<void>>();
const ui = path.resolve(__dirname, '../../web/client/index.html');
const uiUrl = pathToFileURL(ui).href;
const configPath = () => path.join(app.getPath('userData'), 'game.json');
const logsPath = () => path.join(app.getPath('userData'), 'logs');
const replayDirectory=()=>path.join(app.getPath('userData'),'replays');
const replayCatalog=new LocalReplays(()=>[path.join(app.getPath('documents'),'My Games','SquareEnix','Supreme Commander 2','replays'),path.join(app.getPath('documents'),'My Games','Gas Powered Games','Supreme Commander 2'),replayDirectory(),logsPath()]);
let extraReplayFolder:string|undefined;
let replaySettings:ReplayFolderStore|undefined;
const replayFolderStore=()=>replaySettings??=new ReplayFolderStore(path.join(app.getPath('userData'),'replay-library.json'));
function trusted(event: IpcMainInvokeEvent) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== uiUrl) throw new Error('Untrusted IPC sender.');
}
let mapDownloadAbort:AbortController|null=null;
function mapProgress(value:MapInstallProgress){if(win&&!win.isDestroyed())win.webContents.send('map-package:progress',value);}
async function ensureInstalledMap(context:{server:string;token:string},map:import('../shared/model').RoomMap|null|undefined,executable:string){
 if(mapDownloadAbort)throw Error('Another map transfer is active. Wait for it to finish.');
 const controller=new AbortController();mapDownloadAbort=controller;const timeout=setTimeout(()=>controller.abort(),15*60_000);
 try{return await ensureGameMap(context,map,executable,path.join(app.getPath('userData'),'map-packages'),controller.signal,mapProgress);}finally{clearTimeout(timeout);if(mapDownloadAbort===controller)mapDownloadAbort=null;}
}
ipcMain.handle('game:ensure-map',async(event,raw:unknown)=>{
 trusted(event);if(!gamePath||launching)throw Error('Choose the game installation and close the game before installing a map.');
 const r=raw as {server:string;token:string;map:import('../shared/model').RoomMap};const context=validateHostRoom({...r,roomId:'00000000-0000-0000-0000-000000000000'});
 if(!r.map||typeof r.map.id!=='string'||!/^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/i.test(r.map.id)||! /^[a-f0-9]{64}$/.test(r.map.metadataHash))throw Error('Choose a current map-pool entry.');
 await ensureInstalledMap(context,r.map,gamePath);return mapCatalog.scan(gamePath);
});
ipcMain.handle('map-package:cancel',async event=>{trusted(event);mapDownloadAbort?.abort();});
ipcMain.handle('map-package:download',async(event,raw:unknown)=>{
 trusted(event);if(mapDownloadAbort)throw Error('Another map package is downloading.');const request=mapDownload(raw),controller=new AbortController();mapDownloadAbort=controller;
 const timeout=setTimeout(()=>controller.abort(),15*60_000);
 try{if(!gamePath)throw Error('Choose your Supreme Commander 2 installation in Settings first.');if(launching)throw Error('Close the game before installing maps.');const result=await installMapPackage(request,gamePath,path.join(app.getPath('userData'),'map-packages'),controller.signal,mapProgress);await mapCatalog.scan(gamePath);return result;}
 finally{clearTimeout(timeout);if(mapDownloadAbort===controller)mapDownloadAbort=null;}
});
ipcMain.handle('research:stock-icons',async event=>{trusted(event);return gamePath?boundedStockResearchIcons(gamePath):{};});
ipcMain.handle('research:export',async(event,raw:unknown)=>{trusted(event);const bytes=JSON.stringify(researchDocument(raw),null,2)+'\n';if(Buffer.byteLength(bytes)>8388608)throw Error('Research draft exceeds 8 MiB.');const selected=await dialog.showSaveDialog(win!,{title:'Export research draft',defaultPath:'Reforged-Research-Draft.json',filters:[{name:'Research draft JSON',extensions:['json']}]});if(selected.canceled||!selected.filePath)return{message:'Research export cancelled.'};await writeFile(selected.filePath,bytes,'utf8');return{message:'Research draft exported as JSON. Gameplay is unchanged.'};});
let updates:ClientUpdates|null=null;
function clientUpdates(){return updates??=new ClientUpdates(path.join(app.getPath('userData'),'updates'),fetch,app.getVersion());}
ipcMain.handle('update:check',async(e,server,token)=>{trusted(e);return clientUpdates().check(server,token);});
ipcMain.handle('update:download',async(e,server,token)=>{trusted(e);return clientUpdates().download(server,token);});
ipcMain.handle('update:install',async(e,server)=>{trusted(e);if(launching)throw Error('Close SupCom 2 before installing a client update.');if(process.platform!=='win32')throw Error('This release installs on Windows.');const installer=await clientUpdates().installer(server);const child=spawn(installer,[],{detached:true,stdio:'ignore',shell:false});await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();app.quit();});
ipcMain.handle('update:publish',async(e,value)=>{trusted(e);if(!value||typeof value.version!=='string'||typeof value.notes!=='string')throw Error('Enter release details.');const selected=await dialog.showOpenDialog(win!,{title:'Publish a Reforged client installer',properties:['openFile'],filters:[{name:'Reforged setup',extensions:['exe']}]});if(selected.canceled)return {message:'Publication cancelled.'};return publishClient(value.server,value.token,value.version,value.notes,selected.filePaths[0]);});
function connectionPath(){return path.join(app.getPath('userData'),'connection.bin');}
function validateConnection(value:unknown){const p=value as {server:string;accessKey:string};if(!p||typeof p.server!=='string'||p.server.length>300||typeof p.accessKey!=='string'||p.accessKey.length>200)throw new Error('Invalid saved server connection.');const u=new URL(p.server);if(!['http:','https:'].includes(u.protocol)||u.origin!==p.server)throw new Error('Invalid saved server address.');return {server:p.server,accessKey:p.accessKey};}
ipcMain.handle('connection:save',async(e,value)=>{trusted(e);const c=validateConnection(value);if(!safeStorage.isEncryptionAvailable()||(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text'))throw new Error('Secure connection storage is unavailable.');await writeFile(connectionPath(),safeStorage.encryptString(JSON.stringify(c)),{mode:0o600});});
ipcMain.handle('connection:load',async e=>{trusted(e);if(safeStorage.isEncryptionAvailable()){try{return validateConnection(JSON.parse(safeStorage.decryptString(await readFile(connectionPath()))));}catch(err){if((err as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('Saved connection could not be read. Import your connection file again.');}}
 const configured=await publicSetup().configured();if(configured&&(configured.phase==='ready'||configured.phase==='imported'))return {server:'http://127.0.0.1:47821',accessKey:''};
 const {ServerSettingsStore}=await import('./server-settings');const store=new ServerSettingsStore(path.join(accountDirectory(),'server-settings.json'));if(!await store.exists())return null;const s=await store.load();return {server:`http://${s.address}:47820`,accessKey:s.accessKey};
});
ipcMain.handle('server:export-public',async(e,domain)=>{trusted(e);const {exportPublicDeployment}=await import('./public-deployment');const selected=await dialog.showOpenDialog(win!,{title:'Save public Reforged server setup',properties:['openDirectory','createDirectory']});if(selected.canceled)return {message:'Export cancelled.'};return exportPublicDeployment(domain,selected.filePaths[0],path.resolve(__dirname,'../../'),app.isPackaged?path.join(process.resourcesPath,'deployment'):path.resolve(__dirname,'../../../deployment'));});
let publicSetupRunning=false;
let setupController:import('./public-setup').PublicServerSetup|null=null;
function userClientDirectory(){return dataPaths.client;}
function publicSetup(){
 if(setupController)return setupController;
 const {PublicServerSetup}=require('./public-setup') as typeof import('./public-setup');
 const root=path.join(userClientDirectory(),'public-server');
 setupController=new PublicServerSetup({root,accounts:accountDirectory(),dist:path.resolve(__dirname,'../../'),templates:app.isPackaged?path.join(process.resourcesPath,'deployment'):path.resolve(__dirname,'../../../deployment'),
  pause:async()=>{
   const {ownerControl}=await import('./server-control'),{ServerSettingsStore}=await import('./server-settings'),{acquireStoreLease}=await import('../server/store-lease');
   const store=new ServerSettingsStore(path.join(accountDirectory(),'server-settings.json')),original=await store.load();
   await privateServer.stop();let managed=false;
   try{managed=await ownerControl(accountDirectory(),'pause');}catch{throw Error('The old Server Manager could not pause. Close it, then reopen the updated Reforged client and retry.');}
   await store.save({...original,startOnClient:false,autoStart:false});
   const resume=async()=>{if(managed)await ownerControl(accountDirectory(),'resume');else{await store.save(original);if(original.startOnClient!==false||original.autoStart){const args=app.isPackaged?['--s2r-server','--background']:[app.getAppPath(),'--s2r-server','--background'];const child=spawn(process.execPath,args,{shell:false,detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();}}};
   try{const release=await acquireStoreLease(path.join(accountDirectory(),'accounts.json'));return {release,resume};}catch(e){await resume();throw e;}
  },
  firewall:process.platform==='win32'?async()=>{const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const script=app.isPackaged?path.join(process.resourcesPath,'deployment','Allow-Firewall.ps1'):path.resolve(__dirname,'../../../deployment/Allow-Firewall.ps1');try{await promisify(execFile)(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:120_000,maxBuffer:16384});}catch{throw Error('Windows Firewall permission was not completed. Retry setup and allow the Windows prompt, or add the TCP 80/443 rule yourself.');}}:undefined,
  enableStartup:async()=>{if(process.platform==='win32')app.setLoginItemSettings({name:'community.sc2.revival.public',openAtLogin:true,path:process.execPath,args:['--s2r-public-boot']});},
  onReady:async connection=>{
   if(publicBoot)return;const base=userClientDirectory();if(safeStorage.isEncryptionAvailable()&&!(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text')){
    await writeFile(path.join(base,'connection.bin'),safeStorage.encryptString(JSON.stringify(connection)),{mode:0o600});
    try{const old=validateAccount(JSON.parse(safeStorage.decryptString(await readFile(path.join(base,'account.bin')))));const {ServerSettingsStore}=await import('./server-settings'),settings=await new ServerSettingsStore(path.join(accountDirectory(),'server-settings.json')).load();if(old.server===`http://${settings.address}:47820`||old.server===connection.server)await writeFile(path.join(base,'account.bin'),safeStorage.encryptString(JSON.stringify({...old,server:connection.server})),{mode:0o600});}catch{/* Sign in once if no remembered token exists. */}
   }
  }
 });return setupController;
}
ipcMain.handle('public:status',async e=>{trusted(e);return publicSetup().status();});
ipcMain.handle('public:begin',async(e,request)=>{
 trusted(e);if(process.platform!=='win32')throw Error('Automatic setup is supported on the Windows server PC.');
 const {publicHostname}=await import('./public-deployment'),domain=publicHostname(request?.domain),saved=await publicSetup().configured();
 if(!saved){
  const {ServerSettingsStore}=await import('./server-settings'),settings=await new ServerSettingsStore(path.join(accountDirectory(),'server-settings.json')).load();
  if(request.server!==`http://${settings.address}:47820`||typeof request.token!=='string'||!/^[a-f0-9]{64}$/.test(request.token))throw Error('Sign in to this PC’s current account server and unlock Admin before the first setup.');
  const response=await fetch(request.server+'/api/admin/status',{headers:{Authorization:'Bearer '+request.token},signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw Error('Unlock Admin before setting up the public server.');const grant=await response.json();if(grant.protocol!==PROTOCOL||!grant.admin||!Number.isFinite(Date.parse(grant.admin.expiresAt))||Date.parse(grant.admin.expiresAt)<=Date.now())throw Error('The local server did not confirm administrator access.');
 }
 if(request?.changeDomain){
  if(!saved||request.server!=='http://127.0.0.1:47821'||typeof request.token!=='string'||!/^[a-f0-9]{64}$/.test(request.token))throw Error('Sign in to this PC’s owner connection and unlock Admin before changing its domain.');
  const response=await fetch('http://127.0.0.1:47821/api/admin/status',{headers:{Authorization:'Bearer '+request.token},signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)throw Error('Unlock Admin before changing the public domain.');const grant=await response.json();if(grant.protocol!==PROTOCOL||!grant.admin||Date.parse(grant.admin.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(grant.admin.expiresAt)))throw Error('Administrator access was not confirmed.');
 }
 publicSetupRunning=true;try{const result=await publicSetup().start(domain,request?.changeDomain===true);void publicSetup().whenIdle().finally(()=>{publicSetupRunning=false;});return result;}catch(e){publicSetupRunning=false;throw e;}
});
ipcMain.handle('public:recheck',async e=>{trusted(e);return publicSetup().recheck();});
ipcMain.handle('public:files',async e=>{trusted(e);const state=await publicSetup().status();if(!state.canResume)throw Error('Start setup first.');const error=await shell.openPath(state.directory);if(error)throw Error(error);});
function accountPath(){return path.join(app.getPath('userData'),'account.bin');}
function validateAccount(value:unknown):SavedAccount{
  const a=value as Partial<SavedAccount>;
  if(!a||typeof a.server!=='string'||a.server.length>300||typeof a.username!=='string'||!/^[A-Za-z0-9_]{3,24}$/.test(a.username)||typeof a.refreshToken!=='string'||!/^[a-f0-9]{64}$/.test(a.refreshToken))throw new Error('Invalid saved account.');
  const url=new URL(a.server);if(!['http:','https:'].includes(url.protocol)||url.origin!==a.server)throw new Error('Invalid account server.');
  return a as SavedAccount;
}
ipcMain.handle('account:load',async event=>{
  trusted(event);if(!safeStorage.isEncryptionAvailable())return null;
  try{return validateAccount(JSON.parse(safeStorage.decryptString(await readFile(accountPath()))));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;await rm(accountPath(),{force:true});return null;}
});
ipcMain.handle('account:save',async(event,value:unknown)=>{
  trusted(event);if(value===null){await rm(accountPath(),{force:true});return;}
  const account=validateAccount(value);
  if(!safeStorage.isEncryptionAvailable()||(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text'))throw new Error('Secure sign-in storage is unavailable. You are signed in for this session.');
  await mkdir(app.getPath('userData'),{recursive:true});await writeFile(accountPath(),safeStorage.encryptString(JSON.stringify(account)),{mode:0o600});
});
ipcMain.handle('game:choose', async event => {
  trusted(event);
  const result = await dialog.showOpenDialog(win!, { title: 'Select SupremeCommander2.exe', properties: ['openFile'], filters: [{ name: 'SupCom 2 executable', extensions: ['exe'] }] });
  if (result.canceled) return null;
  const inspected = await inspectExecutable(result.filePaths[0]);
  gamePath = inspected.path; mapCatalog = new LocalMapCatalog();
  await writeFile(configPath(), JSON.stringify({ gamePath }, null, 2), 'utf8');
  return inspected;
});
ipcMain.handle('game:maps', async event => { trusted(event); if (!gamePath) throw new Error('Choose your game executable first.'); return mapCatalog.scan(gamePath); });
ipcMain.handle('game:map-preview', async (event,id:unknown) => { trusted(event); if(typeof id !== 'string' || id.length>240) throw new Error('Invalid map identifier.'); return mapCatalog.preview(id); });
ipcMain.handle('game:inspect', async event => {
  trusted(event);
  if (!gamePath) return null;
  return inspectExecutable(gamePath);
});
async function launchGame(mode: 'stock' | 'diagnostic' | 'join' | 'host' | 'lan-test' | 'native-host' | 'native-guest' | 'relay-host' | 'relay-guest' | 'replay', lobbyId?: unknown, roomInput?: unknown) {
  if (process.platform !== 'win32') throw new Error('Game launch is supported on Windows only in this version.');
  if (!gamePath) throw new Error('Choose your SupCom 2 executable first.');
  if (launching||firewallBusy) throw new Error('Close the game or finish firewall setup before launching.');
  launching = true;
  let attempt:LaunchAttempt|null=null;
  try {
    lastLogPath=null;
    attempt=await LaunchAttempt.begin(logsPath(),mode);
    const preparation:import('./preparation-monitor').PreparationOptions={onProgress:(stage:string,detail?:string)=>attempt!.record(stage,detail)};
    lastAttemptLog=attempt.file;currentAttempt=attempt;
    await attempt.record('checking-game');
    const selectedPath = gamePath;
    const inspected = await inspectExecutable(selectedPath);
    await attempt.record('checking-processes');
    await launchPreflight();
    nativeGuestMessage='';relayLog=null;lastRelayLog='';lobbyMaps.stop();nativeRelay.stop();await shares.stop();await nativeRoom.stop();nativeObservation=new NativeLobbyObservation();lobbyMaps=new LobbyMapPublisher(id=>mapCatalog.metadata(id));udpListenerAt=0; monitor?.stop(); monitor = null; tracker = null;mapTracker=null;udpProbePid=null;
    let replayRoster:import('../shared/model').BrowserPlayer[]=[];let savedReplayFile:string|undefined;
    let args: string[] = [], executable = selectedPath;
    let logPath: string | undefined;
    let readerLog: string | undefined;let rankedMatchId:string|undefined;let resultName:string|undefined;
    let relaySession:{roomId:string;runId:string;role:'host'|'guest'}|undefined;
    if(mode==='relay-guest'){
      await attempt.record('checking-host-room');
      const context=validateHostRoom(roomInput),state=await roomApi(context,'state'),room=state.room;
      if(state.protocol!==PROTOCOL||!room||room.id!==context.roomId||room.hostId===state.playerId||!room.nativeHost||room.nativeHost.phase!=='lobby-observed'||room.steamLink)throw Error('Join the host’s independent Reforged lobby first.');
      preparation.rankedMatch=!!room.matchmakingId;
      const runId=room.nativeHost.id;rankedMatchId=room.matchmakingId;resultName=room.players.find(p=>p.id===state.playerId)?.name;
      await attempt.record('preparing-map-download');await ensureInstalledMap(context,room.map,selectedPath);const fresh=await roomApi(context,'state');if(fresh.room?.nativeHost?.id!==runId||fresh.room?.map?.id!==room.map?.id||fresh.room?.map?.metadataHash!==room.map?.metadataHash)throw Error('The host changed the map while preparing. Join again for the current map.');
      relaySession={roomId:room.id,runId,role:'guest'};
      await attempt.record('preparing-guest-game');
      preparation.researchRuleset=await fetchRoomResearch(context,room.researchId);
      const prepared=await prepareNativeHost(selectedPath,nativeAssets(),logsPath(),undefined,true,true,'127.16.0.1',false,room.name,true,room.players.find(p=>p.id===state.playerId),false,preparation);
      await attempt.record('connecting-guest-relay','Game diagnostic folder: '+prepared.run);
      await nativeRelay.start(context,runId,'guest',stage=>attempt!.record(stage));relayLog=path.join(prepared.run,'relay-status.jsonl');
      await attempt.record('guest-relay-connected');
      executable=prepared.candidatePath;logPath=prepared.gameLog;readerLog=path.join(prepared.run,'live-lobby-observations.jsonl');tracker=new LiveLobbyTracker();args=steamLaunchArguments(inspected.profile,logPath);
    }else if(mode==='native-guest'){
      const approved=await authorizeNativeGuestProbe(roomInput);
      const guestState=await roomApi(approved.context,'state');await ensureInstalledMap(approved.context,guestState.room?.map,selectedPath);
      preparation.researchRuleset=await fetchRoomResearch(approved.context,(await roomApi(approved.context,'state')).room?.researchId);
      const prepared=await prepareNativeHost(selectedPath,nativeAssets(),logsPath(),undefined,true,true,approved.address,false,approved.roomName,false,undefined,false,preparation);
      await attempt.record('guest-game-prepared','Game diagnostic folder: '+prepared.run);
      await authorizeNativeGuestProbe(roomInput);
      const latestMap=(await roomApi(approved.context,'state')).room?.map;if(latestMap?.id!==guestState.room?.map?.id||latestMap?.metadataHash!==guestState.room?.map?.metadataHash)throw Error('The host changed the map while preparing. Join again for the current map.');
      executable=prepared.candidatePath;logPath=prepared.gameLog;readerLog=path.join(prepared.run,'live-lobby-observations.jsonl');tracker=new LiveLobbyTracker();args=steamLaunchArguments(inspected.profile,logPath);
    }else if(mode==='host'||mode==='lan-test'||mode==='native-host'||mode==='relay-host'){
      let requestedMap:string|undefined,requestedTitle:string|undefined,requestedPreferences:{faction:string;colour:string;name?:string}|undefined;
      if(mode==='host'||mode==='native-host'||mode==='relay-host'){
      const context = validateHostRoom(roomInput);
      await attempt.record('checking-host-room');
      // Authorize room ownership before building or spawning a host candidate.
      const roomState=await roomApi(context,'state');
      if(!ownsRoom(roomState,context))throw Error('Only the current room host can launch this game.');
      preparation.researchRuleset=await fetchRoomResearch(context,roomState.room!.researchId);
      preparation.rankedMatch=!!roomState.room!.matchmakingId;
      resultName=roomState.room!.players.find(p=>p.id===roomState.playerId)?.name;rankedMatchId=roomState.room!.matchmakingId;requestedTitle=roomState.room!.name;requestedPreferences=roomState.room!.players.find(p=>p.id===roomState.playerId);
      const catalog=await mapCatalog.scan(selectedPath);
      const hostingMaps=new Map(catalog.maps.map(m=>[m.id.toLowerCase(),mapCatalog.metadata(m.id)!]));lobbyMaps.stop();lobbyMaps=new LobbyMapPublisher(id=>hostingMaps.get(id)??null);
      if(roomState.room!.map){
        const requested=roomState.room!.map;if(!requested)throw new Error('Select an installed map before enabling the map handoff test.');
        if(!catalog.maps.some(m=>m.id.toLowerCase()===requested.id.toLowerCase()&&m.metadataHash===requested.metadataHash))throw new Error('The requested map is missing or changed in this game copy. Rescan maps and create the listing again.');
        requestedMap=requested.id;mapTracker=new MapHandoffTracker(requestedMap);
      }
      }
      await attempt.record('preparing-host-game');
      const prepare=()=>prepareNativeHost(selectedPath,nativeAssets(),logsPath(),requestedMap,mode==='lan-test'||mode==='native-host'||mode==='relay-host',true,undefined,false,requestedTitle,mode==='relay-host',requestedPreferences,false,preparation);
      const prepared=mode==='lan-test'?await prepare():await withRoomHeartbeat(validateHostRoom(roomInput),prepare);
      await attempt.record('host-game-prepared','Game diagnostic folder: '+prepared.run);
      if(mode==='relay-host')relayLog=path.join(prepared.run,'relay-status.jsonl');
      // Start short-lived publication/relay leases after expensive preparation.
      // The reader will advertise readiness only after actual host observations.
      if(mode==='host'||mode==='native-host'||mode==='relay-host'){
       const context=validateHostRoom(roomInput);
       const state=mode==='host'?await shares.begin(context):await nativeRoom.begin(context);
       if(mode==='relay-host'){
        await attempt.record('connecting-host-relay');
        await nativeRelay.start(context,state.room!.nativeHost!.id,'host',stage=>attempt!.record(stage));
        relaySession={roomId:context.roomId,runId:state.room!.nativeHost!.id,role:'host'};
       }
      }
      executable = prepared.candidatePath; logPath = prepared.gameLog;if(mode==='lan-test'||mode==='native-host'||mode==='relay-host'){udpRun=prepared.run;lastUdpObservation='';}
      readerLog = path.join(prepared.run,'live-lobby-observations.jsonl');
      args = steamLaunchArguments(inspected.profile,logPath);
      tracker = new LiveLobbyTracker();
    } else if(mode==='join'){
      validateLobbyId(lobbyId);
      const title=roomInput===undefined?undefined:await joinedRoomTitle(roomInput,lobbyId as string);
      const joined=roomInput===undefined?null:await roomApi(validateHostRoom(roomInput),'state');
      if(joined)await ensureInstalledMap(validateHostRoom(roomInput),joined.room?.map,selectedPath);
      preparation.rankedMatch=!!joined?.room?.matchmakingId;
      if(joined)preparation.researchRuleset=await fetchRoomResearch(validateHostRoom(roomInput),joined.room?.researchId);
      const prepared=await prepareNativeHost(selectedPath,nativeAssets(),logsPath(),undefined,false,true,undefined,true,title,false,joined?.room?.players.find(p=>p.id===joined.playerId),false,preparation);
      await attempt.record('steam-guest-game-prepared','Game diagnostic folder: '+prepared.run);
      executable=prepared.candidatePath;logPath=prepared.gameLog;readerLog=path.join(prepared.run,'live-lobby-observations.jsonl');tracker=new LiveLobbyTracker();args=steamLaunchArguments(inspected.profile,logPath,lobbyId);
    } else if(mode==='replay'){
      const input=roomInput as {replayId?:unknown;playback?:unknown}|null;
      const replayFile=await replayCatalog.resolve(input?.replayId);
      const playback=input?.playback===undefined?await detectReplayPlayback(replayFile):replayPlayback(input.playback);
      if(playback==='reforged'){preparation.researchRuleset=await readReplayResearch(replayFile);preparation.replayRevision=replayRevision(await readReplayVersion(replayFile));}
      await attempt.record('preparing-replay-game','Playback: '+playback);
      const prepared=await prepareReplayPlayback(inspected,nativeAssets(),logsPath(),replayFile,playback,undefined,preparation);
      await attempt.record('replay-game-prepared','Game diagnostic folder: '+path.dirname(prepared.logPath));
      executable=prepared.executable;logPath=prepared.logPath;args=prepared.args;
    } else if (mode !== 'stock') {
      logPath = path.join(logsPath(), `supcom2-${mode}-${Date.now()}-${randomUUID()}.sclog`);
      args = steamLaunchArguments(inspected.profile,logPath,undefined);
      await mkdir(logsPath(),{recursive:true});
    }
    if(['host','join','native-host','native-guest','relay-host','relay-guest'].includes(mode)&&logPath){savedReplayFile=path.join(path.dirname(logPath),'match.SC2Replay');args.push('/savereplay',savedReplayFile);}
    // Keep normal movie handling: /nomovie stalled the otherwise unchanged baseline.
    const services=roomInput&&typeof roomInput==='object'&&'roomId' in roomInput&&logPath?new LobbyServices(validateHostRoom(roomInput),path.join(path.dirname(logPath),'lobby-services.bin'),Date.now,s=>s.room?.nativeHost?lobbyMaps.publish(validateHostRoom(roomInput),s.room.nativeHost.id,s):Promise.resolve()):null;
    if(relaySession&&logPath)await writeFile(path.join(path.dirname(logPath),'relay-session.json'),JSON.stringify({format:'s2r-relay-session-v1',clientVersion:CLIENT_VERSION,at:new Date().toISOString(),...relaySession},null,2));
    await attempt.record('launching-game',path.basename(executable));
    const gameStartedAt=Date.now();
    if(process.platform==='win32'&&path.basename(executable)==='SupremeCommander2.ReforgedLobby.exe'){
      await attempt.record('preparing-firewall','Checking saved game access for the active network.');
      try{const {ensureGameFirewall}=await import('./game-firewall');const result=await ensureGameFirewall(nativeAssets(),executable);
        await attempt.record('firewall-ready',result.message);
        if(logPath)await writeFile(path.join(path.dirname(logPath),'firewall-before-launch.json'),JSON.stringify({at:new Date().toISOString(),clientVersion:CLIENT_VERSION,automatic:true,...result},null,2));
      }catch(e){await attempt.record('firewall-attention',(e as Error).message);}
    }
    const child = spawn(executable,args,{cwd:path.dirname(executable),shell:false,detached:true,stdio:'ignore'});
    const resultId=rankedMatchId??relaySession?.runId;const resultReporter=resultId&&logPath&&resultName?new RankedResultReporter(validateHostRoom(roomInput),resultId,logPath,path.join(path.dirname(logPath),'ranked-result.json'),resultName,rankedMatchId?'matchmaking/report':'custom/report'):null;resultReporter?.start();
    child.once('exit',(code,signal) => {
      if(gameProcessId===child.pid)gameProcessId=null;
      void attempt?.record('game-closed','Windows exit status: '+(code===null?'unavailable':'0x'+(code>>>0).toString(16).padStart(8,'0'))).catch(()=>{});
      if(logPath)void writeFile(path.join(path.dirname(logPath),'process-exit.json'),JSON.stringify({at:new Date().toISOString(),exitCode:code,windowsExitStatus:code===null?null:'0x'+(code>>>0).toString(16).padStart(8,'0'),signal},null,2)).catch(()=>{});
      if(logPath&&child.pid&&code!==null&&code!==0){
        const run=path.dirname(logPath),capture=captureWindowsCrash(child.pid,executable,gameStartedAt,nativeAssets(),run).catch(()=>{});
        crashCaptures.set(run,capture);void capture.finally(()=>{if(crashCaptures.get(run)===capture)crashCaptures.delete(run);});
      }
      if(logPath&&path.basename(executable)==='SupremeCommander2.ReforgedLobby.exe')void import('./game-firewall').then(async({gameFirewall})=>{const result=await gameFirewall(nativeAssets(),executable,false,false);await writeFile(path.join(path.dirname(logPath!),'firewall-after-exit.json'),JSON.stringify({at:new Date().toISOString(),clientVersion:CLIENT_VERSION,...result},null,2));}).catch(()=>{});
      if(savedReplayFile)void finishSavedReplay(savedReplayFile,replayRoster,CLIENT_VERSION,new Date(),preparation.researchRuleset).catch(error=>{void attempt?.record('replay-naming-unavailable',error instanceof Error?error.message:String(error)).catch(()=>{});});
      services?.stop();
      lobbyMaps.stop();
      launching = false;udpProbePid=null;if(roomInput&&typeof roomInput==='object'&&'roomId' in roomInput){const c=roomInput as import('../shared/model').HostRoomRequest;void finishReportedGame(c,resultReporter).catch(()=>{});} monitor?.stop(); monitor = null;
      if(['host','native-host','native-guest','lan-test','join','relay-host','relay-guest','replay'].includes(mode)&&win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();}
      nativeRelay.stop('Game process closed; independent relay stopped.');void shares.stop('Game process closed; automatic link removed.');void nativeRoom.stop('Game process closed; native host run removed.');
    });
    await new Promise<void>((resolve,reject) => {
      child.once('spawn',()=>{gameProcessId=child.pid??null;resolve();});
      child.once('error',error => {services?.stop();launching=false;reject(error);});
    });
    await attempt.record('game-running','Process ID: '+child.pid);
    lastLogPath = logPath ?? null;if(mode==='lan-test'||mode==='native-host'||mode==='relay-host')udpProbePid=child.pid??null;
    if((['host','join','native-host','native-guest','lan-test','relay-host','relay-guest'].includes(mode)) && tracker && child.pid && readerLog) monitor=watchGameLobby(child.pid,nativeAssets(),readerLog,tracker,mapTracker??undefined,sample=>{const roster=replayPlayers(sample);if(roster.length)replayRoster=roster;lobbyMaps.ingest(sample);void services?.tick(sample);if(mode!=='host')nativeObservation.ingest(sample);const r=sample as Record<string,unknown>;if(r.guestProbeReadOK===true)nativeGuestMessage=`Native guest phase ${r.guestProbePhase}; request ${r.guestJoinRequest}; callback ${r.guestJoinCallback}; error ${r.guestJoinError}. ${r.visible===true&&r.isHost===false?'Guest lobby observed.':'Confirm game entry on screen.'}`;});
    child.unref();
    return {message:mode==='replay'?'Supreme Commander 2 replay launch requested. Confirm playback in the game.':mode==='relay-host'||mode==='relay-guest'?'Started independent multiplayer through Reforged.':mode==='native-guest'?'Started a private native UDP guest connection probe. Confirm entry in the host’s actual game lobby; handshake compatibility, completed matches and game admission are not verified yet.':mode==='native-host'?'Started the Reforged native host test with the redesigned lobby test. Its status is tracked by your Reforged room; the private guest probe is unverified and public native joining is not enabled.':mode==='lan-test'?'Started an isolated native UDP test with the redesigned Reforged lobby test. This is not authenticated multiplayer and is not shared in Reforged. Check the visible game lobby and UDP listener status in your profile.':mode==='host'
      ? mapTracker?'Started the redesigned lobby with map handoff using your installed game data. Wait for map readback and confirm the visible map inside SupCom 2.':'Started the redesigned lobby using your installed game data. Reforged will share the current lobby ID after live detection. Check the map inside SupCom 2.'
      : mode==='stock' ? 'Started SupCom 2 normally. Room settings are not applied.'
      : mode==='join' ? `Started SupCom 2 with a join request for Steam lobby ${lobbyId}. Check the game to confirm entry.`
      : 'Started SupCom 2 with logging. Create or join inside the game.'};
  } catch(error) {lobbyMaps.stop();await attempt?.record('failed',error instanceof Error?error.message:String(error)).catch(()=>{});if(roomInput&&typeof roomInput==='object'&&'roomId' in roomInput){const c=roomInput as import('../shared/model').HostRoomRequest;await roomApi(c,'game-closed',{roomId:c.roomId}).catch(()=>{});}nativeRelay.stop();launching=false;monitor?.stop();monitor=null;tracker=null;mapTracker=null;await shares.stop('Hosting did not start.');await nativeRoom.stop('Native hosting did not start.');throw error;}
}
ipcMain.handle('replay:scan',async e=>{trusted(e);return replayCatalog.scan(extraReplayFolder);});
ipcMain.handle('replay:scan-report',async e=>{trusted(e);return replayCatalog.report();});
ipcMain.handle('replay:folder',async e=>{trusted(e);return extraReplayFolder??null;});
ipcMain.handle('replay:choose-folder',async e=>{trusted(e);const chosen=await dialog.showOpenDialog(win!,{title:'Select your Supreme Commander 2 replay folder',properties:['openDirectory']});if(chosen.canceled)return null;extraReplayFolder=await replayFolderStore().save(chosen.filePaths[0]);return replayCatalog.scan(extraReplayFolder);});
ipcMain.handle('replay:play',async(e,id:unknown,playback:unknown)=>{trusted(e);return launchGame('replay',undefined,{replayId:id,...(playback===undefined?{}:{playback:replayPlayback(playback)})});});
ipcMain.handle('replay:publish',async(e,value)=>{trusted(e);if(!value||typeof value!=='object')throw Error('Choose a replay first.');return replayCatalog.publish(value.id,value.server,value.token);});
ipcMain.handle('replay:download',async(e,value)=>{trusted(e);if(!value||typeof value!=='object')throw Error('Choose a community replay first.');return replayCatalog.download(value.id,value.server,value.token,replayDirectory());});
ipcMain.handle('game:host-independent',async(event,input:unknown)=>{trusted(event);return launchGame('relay-host',undefined,input);});
ipcMain.handle('game:join-independent',async(event,input:unknown)=>{trusted(event);return launchGame('relay-guest',undefined,input);});
ipcMain.handle('game:host-room',async (event,input:unknown) => {trusted(event);return launchGame('host',undefined,input);});
ipcMain.handle('game:stop-sharing',async event => {trusted(event);lobbyMaps.stop();nativeRelay.stop();await shares.stop();await nativeRoom.stop();});
ipcMain.handle('game:join-native-probe',async(event,input:unknown)=>{trusted(event);return launchGame('native-guest',undefined,input);});
ipcMain.handle('game:host-native-test',async(event,input:unknown)=>{trusted(event);return launchGame('native-host',undefined,input);});
ipcMain.handle('game:restore-lobby',async e=>{trusted(e);if(launching)throw Error('Close SupCom 2 before restoring the lobby.');if(!gamePath)throw Error('Select your prepared test copy first.');await launchPreflight();const inspected=await inspectExecutable(gamePath);if(path.basename(inspected.path).toLowerCase()!=='supremecommander2.exe'||path.basename(path.dirname(inspected.path)).toLowerCase()!=='bin')throw Error('Select the original executable in your prepared copy.');const prepared=await prepareSteamRuntime(inspected.path,nativeAssets(),logsPath());await prepareLobbyAssets(path.dirname(path.dirname(prepared)),nativeAssets(),false);return {message:'Restored the previously working lobby scene in the prepared copy.'};});
ipcMain.handle('server:open-manager',async e=>{trusted(e);await privateServer.stop();const args=app.isPackaged?['--s2r-server']:[app.getAppPath(),'--s2r-server'];const child=spawn(process.execPath,args,{detached:true,stdio:'ignore',shell:false});await new Promise<void>((r,j)=>{child.once('spawn',r);child.once('error',j);});child.unref();});
ipcMain.handle('server:import-connection',async e=>{trusted(e);const chosen=await dialog.showOpenDialog(win!,{title:'Import Reforged server connection',properties:['openFile'],filters:[{name:'Reforged server connection',extensions:['json']}]});if(chosen.canceled)return null;const bytes=await readFile(chosen.filePaths[0]);if(bytes.length>2048)throw new Error('Server connection file is too large.');return require('./server-invite').validateServerInvite(JSON.parse(bytes.toString('utf8')));});
ipcMain.handle('server:manager-connection',async e=>{
 trusted(e);const {ServerSettingsStore}=await import('./server-settings'),{localServerInterfaces}=await import('./private-server');const settings=await new ServerSettingsStore(path.join(accountDirectory(),'server-settings.json')).load();
 if(!localServerInterfaces().includes(settings.address))throw new Error('The saved server interface is disconnected. Open Server Manager and choose a connected interface.');
 const address=`http://${settings.address}:47820`;try{const r=await fetch(address+'/health',{signal:AbortSignal.timeout(2000)});const h=await r.json();if(!r.ok||h.kind!=='private-test-lobby')throw new Error();}catch{throw new Error('Start the server in Server Manager first.');}return {running:true,address,accessKey:settings.accessKey};
});
ipcMain.handle('game:launch-udp-test',async e=>{trusted(e);return launchGame('lan-test');});
ipcMain.handle('game:udp-status',async e=>{
 trusted(e);if(!udpProbePid||!launching)return {running:false,message:'No native UDP test is running.'};
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{powershellPath}=await import('./native-host');
 let stdout:string;try{({stdout}=await promisify(execFile)(powershellPath(),['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; @(Get-NetUDPEndpoint -OwningProcess ${udpProbePid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress`],{windowsHide:true,timeout:6000,maxBuffer:16384}));}catch{return {running:true,message:'Windows could not inspect the native UDP listener. Open the diagnostic logs and confirm the visible lobby before continuing.'};}
 const raw=stdout.trim()?JSON.parse(stdout):[],rows=Array.isArray(raw)?raw:[raw],matches=rows.filter((r:{LocalPort:unknown})=>r.LocalPort===16010);if(matches.length)udpListenerAt=Date.now();
 const result={running:true,message:matches.length?'Native UDP port 16010 observed for the launched SupCom 2 process. Addresses: '+matches.map((r:{LocalAddress:string})=>r.LocalAddress).join(', ')+'. This confirms a listener, not a successful match or client-only access.':'No UDP 16010 listener observed yet. A visible lobby alone does not prove networking.'};
 if(udpRun&&result.message!==lastUdpObservation){lastUdpObservation=result.message;await writeFile(path.join(udpRun,'native-udp-status.json'),JSON.stringify({at:new Date().toISOString(),pid:udpProbePid,endpoints:rows,...result},null,2));}return result;
});
ipcMain.handle('server:interfaces',async event => {trusted(event);const {localServerInterfaces}=await import('./private-server');return localServerInterfaces();});
ipcMain.handle('server:start',async (event,address:unknown) => {trusted(event);return privateServer.start(address);});
ipcMain.handle('server:stop',async event => {trusted(event);await shares.stop();await privateServer.stop();});
ipcMain.handle('server:status',async event => {trusted(event);return privateServer.status();});
ipcMain.handle('server:import-admin',async event=>{
  trusted(event);if(!privateServer.status().running)throw new Error('Start this PC’s room server first.');
  const result=await dialog.showOpenDialog(win!,{title:'Import private administrator setup',properties:['openFile'],filters:[{name:'S2R administrator setup',extensions:['json']}]});
  if(result.canceled)return {message:'Administrator setup import cancelled.'};
  const file=result.filePaths[0];if((await stat(file)).size>2048)throw new Error('Invalid administrator setup file.');
  await privateServer.importAdmin(JSON.parse(await readFile(file,'utf8')));return {message:'Administrator PIN configured on this server. Sign in, open your profile and unlock Admin.'};
});
ipcMain.handle('game:firewall',async(event,value:unknown)=>{
 trusted(event);if(!value||typeof value!=='object'||Object.keys(value).some(k=>!['setup','includePublic'].includes(k))||typeof (value as any).setup!=='boolean'||typeof (value as any).includePublic!=='boolean')throw Error('Invalid firewall request.');
 if(launching||firewallBusy)throw Error('Close Supreme Commander 2 or finish the current firewall check first.');if(!gamePath)throw Error('Choose your game first.');
 firewallBusy=true;try{await launchPreflight();const {verifiedFirewallProgram,gameFirewall}=await import('./game-firewall');const runtime=await prepareSteamRuntime(gamePath,nativeAssets(),logsPath());const result=await gameFirewall(nativeAssets(),await verifiedFirewallProgram(runtime),(value as any).setup,(value as any).includePublic);await mkdir(logsPath(),{recursive:true});await writeFile(path.join(logsPath(),'firewall-check-latest.json'),JSON.stringify({at:new Date().toISOString(),clientVersion:CLIENT_VERSION,setup:(value as any).setup,...result},null,2));return {message:result.message};}finally{firewallBusy=false;}
});
ipcMain.handle('game:launch-stock', async event => { trusted(event); return launchGame('stock'); });
ipcMain.handle('game:launch-diagnostic', async event => { trusted(event); return launchGame('diagnostic'); });
ipcMain.handle('game:join-steam', async (event, lobbyId: unknown, context:unknown) => { trusted(event); validateLobbyId(lobbyId); return launchGame('join', lobbyId, context); });
ipcMain.handle('game:open-logs', async event => {
  trusted(event);
  await mkdir(logsPath(), { recursive: true });
  const error = await shell.openPath(logsPath());
  if (error) throw new Error(error);
});
ipcMain.handle('game:export-logs',async event=>{
 trusted(event);
 if(lastLogPath)await crashCaptures.get(path.dirname(lastLogPath));
 const {gameDiagnostics}=await import('./game-diagnostics');
 const bundle=await gameDiagnostics(logsPath(),lastLogPath,lastAttemptLog);
 const selected=await dialog.showSaveDialog(win!,{title:'Export latest launch diagnostics',defaultPath:bundle.name,filters:[{name:'Launch diagnostics',extensions:['zip']}]});
 if(selected.canceled||!selected.filePath)return {message:'Export cancelled.'};
 await writeFile(selected.filePath,bundle.bytes);return {message:bundle.message};
});
ipcMain.handle('game:inspect-log', async event => {
  trusted(event);
  const result = await dialog.showOpenDialog(win!, { title: 'Read a SupCom 2 game log', defaultPath: logsPath(), properties: ['openFile'], filters: [{ name: 'SupCom 2 game log', extensions: ['sclog'] }] });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  if (path.extname(filePath).toLowerCase() !== '.sclog') throw new Error('Select a .sclog game log.');
  return { fileName: path.basename(filePath), report: await readGameLog(filePath) };
});
ipcMain.handle('game:launch-status', async event => {
  trusted(event);
  const status: LaunchStatus = { running: launching,...(launching&&!gameProcessId&&currentAttempt?{preparing:currentAttempt.progress()}:{}), logName: lastLogPath ? path.basename(lastLogPath) : lastAttemptLog?path.basename(lastAttemptLog):null,
    report: { lobbyId: null, state: 'no-session', message: lastAttemptLog?'Launch attempt recorded. Open the diagnostic log folder for its preparation and connection stages.':'No diagnostic launch in this client session.' } };
  if (lastLogPath) {
    try { status.report = await readGameLog(lastLogPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      status.report.message = 'Waiting for the game to create its log. It may not have flushed yet.';
    }
  }
  if(tracker&&!udpProbePid) status.live=tracker.get();
  if(mapTracker){const handoff=mapTracker.get(),published=lobbyMaps.published();status.mapHandoff=published&&published===lobbyMaps.current()&&published!==handoff.requestedMap?{...handoff,state:'updated',currentMap:published,message:'Map changed in the game lobby. The client listing has been updated.'}:handoff;}
  status.relay=nativeRelay.status();if(nativeGuestMessage)status.nativeGuest={message:nativeGuestMessage};
  const relayEntry=JSON.stringify({relay:status.relay,guest:nativeGuestMessage});if(relayLog&&relayEntry!==lastRelayLog){lastRelayLog=relayEntry;await appendFile(relayLog,JSON.stringify({at:new Date().toISOString(),...JSON.parse(relayEntry)})+'\n').catch(()=>{});}
  status.sharing=shares.status();if(udpProbePid)status.nativeHost=nativeRoom.status();
  return status;
});
ipcMain.handle('match:save', async (event, input: unknown) => {
  trusted(event);
  if (!input || typeof input !== 'object') throw new Error('Invalid manifest.');
  const manifest = input as MatchManifest;
  const serialized = JSON.stringify(manifest, null, 2);
  if (serialized.length > 32_000 || manifest.protocol !== PROTOCOL || manifest.adapter !== 'not-implemented' || !Array.isArray(manifest.players)) throw new Error('Invalid manifest.');
  const result = await dialog.showSaveDialog(win!, { title: 'Save configuration rehearsal', defaultPath: 'sc2-match.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, serialized, 'utf8'); return true;
});
async function createWindow() {
  const icon=app.isPackaged?path.join(process.resourcesPath,'branding/icon.ico'):path.resolve(__dirname,'../../../build/icon.ico');
  const area=screen.getPrimaryDisplay().workArea,width=Math.min(1380,area.width),height=Math.min(960,area.height);
  win = new BrowserWindow({ width,height,minWidth:Math.min(960,area.width),minHeight:Math.min(720,area.height),x:area.x+Math.floor((area.width-width)/2),y:area.y+Math.floor((area.height-height)/2),backgroundColor: '#0a101b', title: 'Supreme Commander 2: Reforged',
    icon,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  if(process.platform==='win32')win.setAppDetails({appId:APP_ID,appIconPath:icon,appIconIndex:0,relaunchCommand:app.isPackaged?`"${process.execPath}"`:`"${process.execPath}" "${app.getAppPath()}"`,relaunchDisplayName:'Supreme Commander 2: Reforged'});
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  win.on('close',event=>{if(publicSetupRunning)event.preventDefault();});
  win.on('closed', () => { mapDownloadAbort?.abort();win = null; });
  await win.loadFile(ui);
}
app.whenReady().then(async () => {
  if(publicBoot){if(!serverLock)return;const setup=publicSetup(),saved=await setup.configured();if(saved){await setup.start(saved.domain);await setup.whenIdle();}app.quit();return;}

  if(serverMode){if(!serverLock)return;await require('./server-manager').startServerManager(accountDirectory());return;}
  try { const config = JSON.parse(await readFile(configPath(), 'utf8')); if (typeof config.gamePath === 'string') gamePath = config.gamePath; } catch { /* First run or invalid config: ask user to select again. */ }
  try{extraReplayFolder=(await replayFolderStore().load())??undefined;}catch{/* Keep local browsing available; choosing a folder replaces invalid preferences. */}
  try{const {ServerSettingsStore}=await import('./server-settings');const settings=await new ServerSettingsStore(path.join(accountDirectory(),'server-settings.json')).load();if(await new ServerSettingsStore(path.join(accountDirectory(),'server-settings.json')).exists()&&(settings.autoStart||settings.startOnClient!==false)){const args=app.isPackaged?['--s2r-server','--background']:[app.getAppPath(),'--s2r-server','--background'];const child=spawn(process.execPath,args,{detached:true,stdio:'ignore',shell:false});child.once('error',()=>{});child.unref();}}catch{/* Explicit manager startup reports configuration errors. */}
  await createWindow();
  app.on('activate', () => { if (!win) void createWindow(); });
}).catch(error=>{dialog.showErrorBox('SupCom 2: Reforged startup failed',error instanceof Error?error.message:'Could not start.');app.quit();});
app.on('window-all-closed', () => { if(!serverMode&&process.platform!=='darwin')app.quit(); });

app.on('before-quit',event => { if(publicSetupRunning){event.preventDefault();return;} monitor?.stop(); monitor=null;lobbyMaps.stop(); nativeRelay.stop();void shares.stop();void nativeRoom.stop(); void privateServer.stop(); });
