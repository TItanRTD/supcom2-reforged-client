import {COLOUR_DEFINITIONS,LADDER_RULES} from '../shared/model';
interface NativePlayer{Name:string;Team:number;Colour:number;Faction:number;StartPosition:number;Slot:number;AI:boolean;Observer:boolean;Ready:boolean}
export interface RankedPlan{matchId:string;role:'host'|'guest';localName?:string;map:{id:string;name?:string;players?:number|null;spawnTeams?:number[]};players:{name:string;team:number;colour:string;faction:string;startPosition?:number}[]}
/** Only a fresh, exact human roster can authorize native Ready/Launch.
 * Custom games never provide a RankedPlan and can never enter this path. */
type Action={action:number;team?:number;row?:number;start?:number};
interface NativeSample{kind?:string;visible?:boolean;readOK?:boolean;currentMapReadOK?:boolean;victoryReadOK?:boolean;victoryCondition?:string;rulesReadOK?:boolean;rules?:Record<string,unknown>;currentMap?:string;isHost?:boolean;nativeLaunchState?:number[];roster?:{ReadOK?:boolean;Entries?:NativePlayer[]}}
export function ladderRulesReady(sample:unknown){const s=sample as NativeSample|undefined;return s?.rulesReadOK===true&&s.victoryReadOK===true&&s.victoryCondition==='demoralization'&&Object.entries(LADDER_RULES).every(([key,value])=>s.rules?.[key]===value);}
export function rankedLobbyAction(plan:RankedPlan|undefined,sample:unknown):Action{const {complete,...action}=rankedDecision(plan,sample);return action;}
function rankedDecision(plan:RankedPlan|undefined,sample:unknown):Action&{complete?:boolean}{
 const s=sample as NativeSample;
 if(!plan||!s||s.kind!=='sample'||s.visible!==true||s.readOK!==true||s.roster?.ReadOK!==true||!Array.isArray(s.roster.Entries)||s.roster.Entries.length>32||s.roster.Entries.some(p=>typeof p.Observer!=='boolean')||plan.players.length<2||plan.players.length>8)return {action:0};
 const players=s.roster.Entries.filter(p=>!p.Observer);if(players.length!==plan.players.length)return {action:0};
 if(s.isHost!==(plan.role==='host')||s.currentMapReadOK!==true||s.currentMap?.toLowerCase()!==plan.map.id.toLowerCase())return {action:0};
 // Native preparation is asynchronous; fresh balance snapshots must not restart it.
 if(Array.isArray(s.nativeLaunchState)&&(s.nativeLaunchState[0]===1||s.nativeLaunchState[1]===1))return {action:0};
 const startCount=Math.min(8,plan.map.players??plan.players.length);if(players.some(p=>p.AI||!Number.isInteger(p.StartPosition)||p.StartPosition<0||p.StartPosition>=startCount)||new Set(players.map(p=>p.StartPosition)).size!==plan.players.length)return {action:0};
 const assigned=plan.players.some(p=>p.startPosition!==undefined);
 if(plan.map.spawnTeams&&!assigned||assigned&&(plan.players.some(p=>!Number.isInteger(p.startPosition)||p.startPosition!<0||p.startPosition!>=startCount||plan.map.spawnTeams&&plan.map.spawnTeams[p.startPosition!]!==p.team)||new Set(plan.players.map(p=>p.startPosition)).size!==plan.players.length))return {action:0};
 for(const expected of plan.players){const p=players.find(p=>p.Name.toLowerCase()===expected.name.toLowerCase());if(!p||p.Faction!==['UEF','Cybran','Illuminate'].indexOf(expected.faction)||p.Colour!==COLOUR_DEFINITIONS.find(c=>c.name===expected.colour)?.nativeId)return {action:0};}
 const expected=plan.localName?plan.players.find(p=>p.name.toLowerCase()===plan.localName!.toLowerCase()):plan.players.length===2?plan.players.find(p=>p.team===(plan.role==='host'?1:2)):undefined;const local=players.find(p=>p.Name.toLowerCase()===expected?.name.toLowerCase());if(!local||!expected)return {action:0};const team=expected.team;
 if(expected.startPosition!==undefined){if(!Number.isInteger(expected.startPosition)||expected.startPosition<0||expected.startPosition>=startCount||plan.players.some(p=>!Number.isInteger(p.startPosition))||new Set(plan.players.map(p=>p.startPosition)).size!==plan.players.length)return {action:0};if(local.StartPosition!==expected.startPosition)return local.Ready?{action:1,row:local.StartPosition+1}:{action:4,start:expected.startPosition};if(players.some(p=>p.StartPosition!==plan.players.find(e=>e.name.toLowerCase()===p.Name.toLowerCase())?.startPosition))return {action:0};}
 if(local.Team!==team)return {action:3,team};
 if(players.some(p=>p.Team!==plan.players.find(e=>e.name.toLowerCase()===p.Name.toLowerCase())?.team))return {action:0};
 // Every requested ladder setting needs a fresh native readback.
 if(!ladderRulesReady(s))return {action:0};
 if(local.Ready!==true)return {action:1,row:local.StartPosition+1};
 const complete=players.every(p=>p.Ready===true);return {action:plan.role==='host'&&complete?2:0,complete};
}

/** Local staging timer; only the host can emit native Start. A changed setup,
 * stale polling gap, missing peer or clock reversal restarts the full delay. */
export class RankedCountdown{
 private key='';private since:number|undefined;private last:number|undefined;
 reset(){this.key='';this.since=undefined;this.last=undefined;}
 update(plan:RankedPlan|undefined,sample:unknown,now:number):{command:Action;message:string;remainingMs:number}{
  const s=sample as NativeSample|undefined,decision=rankedDecision(plan,sample);
  const answer=(command:Action,message:string,remainingMs=0)=>({command,message,remainingMs});
  const waiting=(message:string)=>{this.reset();return answer(rankedLobbyAction(plan,sample),message);};
  if(!plan)return waiting('Waiting for matchmaking assignment...');
  if(s?.nativeLaunchState?.some((v,i)=>i<2&&v===1)){this.reset();return answer({action:0},'Launching...');}
  const entries=s?.roster?.ReadOK===true&&Array.isArray(s.roster.Entries)?s.roster.Entries:[];
  const missing=plan.players.filter(p=>!entries.some(n=>n.Observer===false&&n.AI===false&&n.Name?.toLowerCase()===p.name.toLowerCase())).length;
  if(missing){const humans=entries.filter(n=>n.Observer===false&&n.AI===false);return waiting(humans.length>=plan.players.length?'Synchronizing Reforged player names...':`Waiting for ${missing} player${missing===1?'':'s'}...`);}
  if(!ladderRulesReady(s))return waiting('Configuring ladder settings...');
  if(plan.players.some(p=>{const n=entries.find(n=>n.Name?.toLowerCase()===p.name.toLowerCase());return n?.Faction!==['UEF','Cybran','Illuminate'].indexOf(p.faction)||n?.Colour!==COLOUR_DEFINITIONS.find(c=>c.name===p.colour)?.nativeId;}))return waiting('Applying assigned factions and colors...');
  if(!decision.complete)return waiting('Preparing teams and starting positions...');
  const key=JSON.stringify([plan.matchId,plan.map,plan.players,entries.filter(p=>!p.Observer).map(p=>[p.Name,p.Team,p.Colour,p.Faction,p.StartPosition,p.Ready]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]);
  if(!Number.isFinite(now)){this.reset();return answer({action:0},'Waiting for a stable match setup...');}
  if(key!==this.key||this.since===undefined||this.last===undefined||now<this.last||now-this.last>4000){this.key=key;this.since=now;}
  this.last=now;const remainingMs=Math.max(0,5000-(now-this.since!));
  if(remainingMs)return answer({action:0},`Starting in ${Math.ceil(remainingMs/1000)}...`,remainingMs);
  const {complete,...command}=decision;return answer(command,plan.role==='host'?'Launching...':'Waiting for host to launch...');
 }
}
