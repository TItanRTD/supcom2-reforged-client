import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('serverManager',{
 status:()=>ipcRenderer.invoke('manager:status'),start:(a:string)=>ipcRenderer.invoke('manager:start',a),stop:()=>ipcRenderer.invoke('manager:stop'),auto:(v:boolean)=>ipcRenderer.invoke('manager:auto',v),importSetup:()=>ipcRenderer.invoke('manager:import'),copyConnection:()=>ipcRenderer.invoke('manager:copy'),exportConnection:()=>ipcRenderer.invoke('manager:export'),files:()=>ipcRenderer.invoke('manager:files'),quit:()=>ipcRenderer.invoke('manager:quit')
});
