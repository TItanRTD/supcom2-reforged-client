import {app,BrowserWindow,dialog,ipcMain,Tray,Menu,shell,clipboard,type IpcMainInvokeEvent} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DesktopRoomServer,localServerInterfaces} from './private-server';
import {serveOwnerControl} from './server-control';
import {ServerSettingsStore,type ServerSettings} from './server-settings';
export async function startServerManager(accountDirectory:string){
 let configured=false,starting=false,paused=false;let previous:ServerSettings|null=null;
 const store=new ServerSettingsStore(path.join(accountDirectory,'server-settings.json'));
 let settings:ServerSettings=await store.load(),problem='',quitting=false,win:BrowserWindow|null=null;
 const service=new DesktopRoomServer(undefined,undefined,()=>path.join(accountDirectory,'accounts.json'));
 const ui=path.resolve(__dirname,'../../web/client/server-manager.html'),url=pathToFileURL(ui).href;
 const icon=app.isPackaged?path.join(process.resourcesPath,'branding/icon.ico'):path.resolve(__dirname,'../../../build/icon.ico');
 const status=()=>({service:service.status(),address:settings.address,autoStart:settings.autoStart,startOnClient:settings.startOnClient!==false,interfaces:localServerInterfaces(),problem});
 function trusted(e:IpcMainInvokeEvent){if(!win||e.sender!==win.webContents||e.senderFrame!==win.webContents.mainFrame||e.senderFrame.url!==url)throw new Error('Untrusted server manager sender.');}
 function login(enabled:boolean){if(process.platform==='win32')app.setLoginItemSettings({name:'community.sc2.revival.server',openAtLogin:enabled,path:process.execPath,args:['--s2r-server','--background']});}
 async function start(address:unknown){
  if(starting)return;starting=true;try{
  if(typeof address!=='string'||!localServerInterfaces().includes(address))throw new Error('Choose an address assigned to this PC. Connect your VPN first if needed.');
  if(service.status().running)throw new Error('Stop the server before changing its address.');
  await service.start(address,settings.accessKey);
  try{settings=await store.save({...settings,address,startOnClient:true});configured=true;problem='';}catch(e){await service.stop();throw e;}
  }finally{starting=false;}
 }
 ipcMain.handle('manager:status',e=>{trusted(e);return status();});
 ipcMain.handle('manager:start',async(e,address)=>{trusted(e);await start(address);return status();});
 ipcMain.handle('manager:stop',async e=>{trusted(e);settings=await store.save({...settings,startOnClient:false,autoStart:false});login(false);await service.stop();return status();});
 ipcMain.handle('manager:auto',async(e,enabled)=>{trusted(e);if(typeof enabled!=='boolean')throw new Error('Invalid startup setting.');login(enabled);try{settings=await store.save({...settings,autoStart:enabled,...(enabled?{startOnClient:true}:{})});}catch(err){login(settings.autoStart);throw err;}return status();});
 ipcMain.handle('manager:import',async e=>{
  trusted(e);const result=await dialog.showOpenDialog(win!,{title:'Import your private administrator setup',properties:['openFile'],filters:[{name:'Private admin setup',extensions:['json']}]});
  if(!result.canceled){const bytes=await readFile(result.filePaths[0]);if(bytes.length>2048)throw new Error('Administrator setup file is too large.');await service.importAdmin(JSON.parse(bytes.toString('utf8')));}return status();
 });
 ipcMain.handle('manager:copy',e=>{trusted(e);const s=service.status();if(!s.running)throw new Error('Start the server first.');clipboard.writeText(s.address+'\nServer access key: '+s.accessKey);});
 ipcMain.handle('manager:export',async e=>{
  trusted(e);const s=service.status();if(!s.running)throw new Error('Start the server first.');const result=await dialog.showSaveDialog(win!,{title:'Export server connection for players',defaultPath:'S2R-Server-Connection.json',filters:[{name:'Reforged server connection',extensions:['json']}]});
  if(!result.canceled&&result.filePath)await writeFile(result.filePath,JSON.stringify({format:'s2r-server-connection-v1',server:s.address,accessKey:s.accessKey},null,2),{mode:0o600});
 });
 ipcMain.handle('manager:files',async e=>{trusted(e);const error=await shell.openPath(accountDirectory);if(error)throw new Error(error);});
 ipcMain.handle('manager:quit',async e=>{trusted(e);await quit();});
 async function show(){if(win){win.show();win.focus();return;}
  win=new BrowserWindow({width:880,height:850,minWidth:700,minHeight:650,backgroundColor:'#0a101b',title:'SupCom 2: Reforged — Server Manager',icon,webPreferences:{preload:path.join(__dirname,'server-preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.removeMenu();win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.session.setPermissionRequestHandler((_w,_p,c)=>c(false));
  win.on('close',e=>{if(!quitting){e.preventDefault();win?.hide();}});win.on('closed',()=>{win=null;});await win.loadFile(ui);
 }
 let closeControl:(()=>Promise<void>)|null=null;
 async function quit(){if(quitting)return;quitting=true;await closeControl?.();await service.stop();tray.destroy();app.quit();}
 const tray=new Tray(icon);tray.setToolTip('SupCom 2: Reforged — Account and room server');tray.on('click',()=>void show());tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Server Manager',click:()=>void show()},{label:'Stop server and quit',click:()=>void quit()}]));
 app.on('second-instance',(_e,argv)=>{if(!argv.includes('--background'))void show();});app.on('before-quit',e=>{if(!quitting){e.preventDefault();void quit();}});
 closeControl=await serveOwnerControl(accountDirectory,{
  pause:async()=>{paused=true;for(let i=0;starting&&i<100;i++)await new Promise(r=>setTimeout(r,100));if(starting)throw Error('Server is still starting. Retry shortly.');previous??={...settings};settings=await store.save({...settings,startOnClient:false,autoStart:false});login(false);await service.stop();},
  resume:async()=>{if(!previous)return;const restore=previous;settings=await store.save(restore);login(restore.autoStart);paused=false;previous=null;await start(restore.address);}
 });
 configured=await store.exists();
 if(configured&&(settings.autoStart||settings.startOnClient!==false)){try{await start(settings.address);}catch(e){problem=(e as Error).message;}}
 const retry=setInterval(()=>{if(!paused&&!quitting&&configured&&!service.status().running&&(settings.autoStart||settings.startOnClient!==false)&&localServerInterfaces().includes(settings.address))void start(settings.address).catch(e=>{problem=(e as Error).message;});},5000);retry.unref();
 if(!process.argv.includes('--background')||problem||!service.status().running)await show();
}
