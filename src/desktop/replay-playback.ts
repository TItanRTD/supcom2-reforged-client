import {isReplayFilename} from '../shared/replay-files';
import path from 'node:path';
import type {DesktopProfile,ReplayPlayback} from '../shared/model';
import {steamLaunchArguments} from './adapter';
import type {PreparationOptions} from './preparation-monitor';
import {prepareNativeHost} from './native-host';

export function replayPlayback(value:unknown):ReplayPlayback{
 if(value===undefined)return 'reforged';
 if(value!=='reforged'&&value!=='original')throw Error('Choose Reforged or Legacy Supreme Commander 2 playback.');
 return value;
}
/** Select a playback environment without spawning anything. Legacy playback
 * uses Reforged presentation with the original simulation data in an isolated copy.
 * This preserves the existing /replay argument contract; it does not certify
 * replay simulation compatibility or missing DLC/map/mod dependencies.
 */
export async function prepareReplayPlayback(
 inspected:DesktopProfile,assets:string,logs:string,replay:string,value:unknown,
 prepare:typeof prepareNativeHost=prepareNativeHost,options:PreparationOptions={},
){
 const playback=replayPlayback(value);
 options={...options,replayPresentation:true,replayFile:replay};
 if(!path.isAbsolute(replay)||!isReplayFilename(replay)||replay.includes('\0'))throw Error('Choose a catalogued Supreme Commander 2 replay.');
 if(playback==='original'){
  const prepared=await prepare(inspected.path,assets,logs,undefined,false,true,undefined,true,undefined,false,undefined,true,options);
  return {executable:prepared.candidatePath,logPath:prepared.gameLog,args:[...steamLaunchArguments(inspected.profile,prepared.gameLog),'/replay',replay],playback};
 }
 const prepared=await prepare(inspected.path,assets,logs,undefined,false,true,undefined,true,undefined,false,undefined,false,options);
 return {executable:prepared.candidatePath,logPath:prepared.gameLog,args:[...steamLaunchArguments(inspected.profile,prepared.gameLog),'/replay',replay],playback};
}
