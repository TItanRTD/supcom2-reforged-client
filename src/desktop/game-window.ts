import path from 'node:path';
import {mkdir,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {powershellPath} from './native-host';
const execute=promisify(execFile);
export type GameWindowMode='borderless'|'restore';
type Run=(file:string,args:string[],options:{windowsHide:boolean;timeout:number;maxBuffer:number})=>Promise<{stdout:string}>;
export class GameWindowController{
 private serial:Promise<unknown>=Promise.resolve();
 constructor(private assets:()=>string,private stateRoot:()=>string,private pid:()=>number|null,private run:Run=execute,private platform:string=process.platform){}
 setMode(value:unknown){
  const requestedPid=this.pid();
  const work=this.serial.then(async()=>{
   if(value!=='borderless'&&value!=='restore')throw Error('Choose Borderless or Restore window.');
   if(this.platform!=='win32')throw Error('Game window controls require Windows.');
   const pid=this.pid();if(!Number.isInteger(pid)||!pid||pid<1)throw Error('Launch Supreme Commander 2 from this client first.');
   if(pid!==requestedPid)throw Error('The game changed while this window action was waiting.');
   await mkdir(this.stateRoot(),{recursive:true});
   let result:{stdout:string};
   try{result=await this.run(powershellPath(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(this.assets(),'window-mode.ps1'),'-GameProcessId',String(pid),'-Action',value,'-StatePath',path.join(this.stateRoot(),'window-'+pid+'.json')],{windowsHide:true,timeout:15000,maxBuffer:16384});}
   catch(error){let detail='';try{const data=JSON.parse((error as {stdout?:string}).stdout??'');if(typeof data.error==='string')detail=data.error.slice(0,300);}catch{}throw Error(detail||'Windows could not change the game window. Use Windowed in the game video settings and retry.');}
   if(this.pid()!==pid)throw Error('The game closed while changing its window.');
   let data;try{data=JSON.parse(result.stdout.replace(/^\uFEFF/,''));}catch{throw Error('Windows did not confirm the game window size.');}
   if(data?.ok!==true||data.mode!==value||!Number.isInteger(data.width)||!Number.isInteger(data.height)||data.width<1||data.height<1)throw Error('Windows did not confirm the game window size.');
   return{message:value==='borderless'?'Borderless game window applied ('+data.width+' × '+data.height+').':'The original game window placement was restored.'};
  });this.serial=work.catch(()=>{});return work;
 }
 clear(pid:number){const work=this.serial.then(()=>rm(path.join(this.stateRoot(),'window-'+pid+'.json'),{force:true}));this.serial=work.catch(()=>{});return work.catch(()=>{});}
}
