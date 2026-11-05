import {verifyRuleset,type ResearchRuleset} from './research-publication';
import type {BrowserPlayer} from '../shared/model';
export interface ReplayMetadata{format:'s2r-replay-v1';sha256:string;playback:'reforged';clientVersion:string;players:BrowserPlayer[];gameType:string;research?:ResearchRuleset}
export function validateReplayMetadata(raw:unknown,sha:string):ReplayMetadata{
 const v=raw as Partial<ReplayMetadata>|null;
 if(!v||v.format!=='s2r-replay-v1'||v.sha256!==sha||v.playback!=='reforged'||typeof v.clientVersion!=='string'||!/^0\.\d+\.\d+$/.test(v.clientVersion)||!Array.isArray(v.players)||v.players.length>32||typeof v.gameType!=='string'||v.gameType.length>40)throw Error('Invalid replay provenance.');
 const players=v.players.map(p=>{if(!p||typeof p.name!=='string'||!p.name.trim()||p.name.length>64||/[\x00-\x1f\x7f]/.test(p.name)||!Number.isInteger(p.team)||p.team< -1||p.team>16||typeof p.ai!=='boolean'||typeof p.observer!=='boolean')throw Error('Invalid replay roster.');return {name:p.name,team:p.team,ai:p.ai,observer:p.observer};});
 return {format:'s2r-replay-v1',sha256:sha,playback:'reforged',clientVersion:v.clientVersion,players,gameType:v.gameType,...(v.research?{research:verifyRuleset(v.research)}:{})};
}
