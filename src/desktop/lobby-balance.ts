import {calculateLobbyBalance,type BalancePlayer} from '../shared/balance';
interface AccountRating {name:string;games:number|null;rating?:number|null;uncertainty?:number|null;strength?:number|null}
interface NativeEntry {Name:string;Team:number;Observer:boolean;AI:boolean;Slot:number;StartPosition?:number}
/** Native lobby teams are authoritative for display. Never substitute launcher teams.
 * Names only match account records exactly (case-insensitive); unknown/AI players
 * remain unrated. This is advisory UI data and never authorizes ranked results. */
export function nativeBalanceLines(records:AccountRating[],sample:unknown):string[]{
 const roster=(sample as {roster?:{ReadOK?:boolean;Entries?:NativeEntry[]}})?.roster;
 if(!roster?.ReadOK||!Array.isArray(roster.Entries)||roster.Entries.length>32)return ['BALANCE: --','Waiting for native team data.'];
 if(roster.Entries.some(p=>typeof p.Observer!=='boolean'))return ['BALANCE: --','Waiting for valid native team data.'];
 const entries=roster.Entries.filter(p=>p.Observer===false);
 if(entries.length>8||entries.some(p=>typeof p.Name!=='string'||typeof p.AI!=='boolean'||!Number.isInteger(p.Slot)||p.Slot<0||p.Slot>31||!Number.isInteger(p.Team)||(p.Team!==-1&&(p.Team<1||p.Team>8)))||new Set(entries.map(p=>p.Slot)).size!==entries.length)return ['BALANCE: --','Waiting for valid native team data.'];
 const names=new Map<string,AccountRating[]>();
 for(const p of records){if(typeof p.name!=='string')continue;const key=p.name.toLowerCase(),list=names.get(key)??[];list.push(p);names.set(key,list);}
 const nativeNames=new Map<string,number>();for(const p of entries){const key=p.Name.toLowerCase();nativeNames.set(key,(nativeNames.get(key)??0)+1);}
 const players:BalancePlayer[]=entries.map(p=>{const key=p.Name.toLowerCase(),list=names.get(key),a=!p.AI&&nativeNames.get(key)===1&&list?.length===1?list[0]:undefined;return {name:p.Name,team:p.Team===-1?9+(p.StartPosition??p.Slot):p.Team,games:a?.games??null,rating:a?.strength??a?.rating??null,uncertainty:a?.uncertainty??null};});
 const balance=calculateLobbyBalance(players),teams=[...new Set(players.map(p=>p.team))].sort((a,b)=>a-b);
 // Floor to one decimal: unequal totals must never round up to an apparent 100%.
 const percentage=balance.percentage===null?null:Math.floor(balance.percentage*10)/10;
 const title=teams.length<2?'BALANCE: --':percentage===null?'BALANCE: UNRATED':`BALANCE: ${percentage}%`;
 const totals=teams.map(team=>{const members=players.filter(p=>p.team===team),rated=members.every(p=>p.rating!==null&&Number.isFinite(p.rating)&&p.rating!>=0);const sum=rated?members.reduce((s,p)=>s+p.rating!,0):null;return `${team>8?'FFA '+(team-8):'Team '+team}: ${sum!==null&&Number.isFinite(sum)?sum.toLocaleString('en-US',{maximumFractionDigits:0}):'Unrated'}`;});
 return [title,balance.reason,...(totals.length?totals:['No active players'])];
}
