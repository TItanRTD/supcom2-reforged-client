import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
/** A physical-pixel scale shared by native scene rectangles and Maui controls. */
export function hudScaleForResolution(width:number,height:number):number {
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<640||height<480||width>16384||height>16384)return 1;
 return Math.round(Math.max(0.75,Math.min(1.5,0.8*Math.sqrt(Math.min(width/1920,height/1080))))*8)/8;
}
export function gameResolution(prefs:string):[number,number]|null {
 // Read data only: do not execute Lua preferences or modify the user's profile.
 const match=/\bprimary_adapter\s*=\s*['"]\s*(\d{3,5})\s*[,x ]\s*(\d{3,5})(?:\s*,\s*\d+)?\s*['"]/i.exec(prefs);
 if(!match)return null;
 const w=Number(match[1]),h=Number(match[2]);return w>=640&&h>=480&&w<=16384&&h<=16384?[w,h]:null;
}
export async function detectHudScale():Promise<number>{
 if(process.platform!=='win32')return 1;
 let documents=path.join(os.homedir(),'Documents'),desktop:[number,number]|null=null;
 try {const electron=require('electron');documents=electron.app.getPath('documents');const d=electron.screen.getPrimaryDisplay();desktop=[Math.round(d.size.width*d.scaleFactor),Math.round(d.size.height*d.scaleFactor)];}catch{}
 const candidates=[path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'Gas Powered Games','Supreme Commander 2','Game.prefs'),path.join(documents,'My Games','Gas Powered Games','Supreme Commander 2','Game.prefs')];
 for(const file of candidates){try{let timer:ReturnType<typeof setTimeout>|undefined;const reading=(async()=>{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>2_000_000)return null;return readFile(file,'utf8');})();const text=await Promise.race([reading,new Promise<null>(r=>{timer=setTimeout(()=>r(null),1000);})]).finally(()=>{if(timer)clearTimeout(timer);});if(text){const resolution=gameResolution(text);if(resolution)return hudScaleForResolution(...resolution);}}catch{}}
 return desktop?hudScaleForResolution(...desktop):1;
}
