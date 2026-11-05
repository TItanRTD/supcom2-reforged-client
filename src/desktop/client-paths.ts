import path from 'node:path';
import {existsSync,mkdirSync} from 'node:fs';
/** New installs use SupCom 2 names; upgrades retain existing data in place. */
export function clientPaths(appData:string,exists:(file:string)=>boolean=existsSync){
 const select=(current:string,previous:string)=>path.join(appData,exists(path.join(appData,previous))?previous:current);
 return {client:select('supcom2-reforged-client','sc2-revival-client'),
  manager:select('supcom2-reforged-server-manager','sc2-reforged-server-manager'),
  publicStartup:select('supcom2-reforged-public-startup','sc2-reforged-public-startup')};
}

export function clientUserData(defaultDirectory:string,clientDirectory:string,exists:(file:string)=>boolean=existsSync){
 // Electron may already have made an empty default directory. Prefer saved
 // application settings before treating that empty directory as the profile.
 const configured=(directory:string)=>['game.json','replay-library.json','connection.bin'].some(name=>exists(path.join(directory,name)));
 if(configured(defaultDirectory))return defaultDirectory;
 if(configured(clientDirectory))return clientDirectory;
 return exists(defaultDirectory)?defaultDirectory:clientDirectory;
}

/** Electron requires the directory to exist before setPath. Keep Chromium
 * storage beside the selected data so an upgrade retains saved preferences. */
export function setClientDataDirectory(directory:string,setPath:(name:'userData'|'sessionData',directory:string)=>void){
 mkdirSync(directory,{recursive:true});
 setPath('userData',directory);
 setPath('sessionData',directory);
}
