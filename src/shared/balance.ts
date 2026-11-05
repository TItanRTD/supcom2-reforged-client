/** Advisory team comparison. Recorded game count is experience, never a skill score. */
export interface BalancePlayer {name:string;team:number;observer?:boolean;games:number|null;rating:number|null;uncertainty:number|null}
export function calculateLobbyBalance(players:BalancePlayer[]){
 const active=players.filter(p=>!p.observer),teams=new Map<number,BalancePlayer[]>();
 for(const p of active){const t=teams.get(p.team)??[];t.push(p);teams.set(p.team,t);}
 const missing=active.filter(p=>p.rating===null||p.uncertainty===null||!Number.isFinite(p.rating)||p.rating!<0||!Number.isFinite(p.uncertainty)||p.uncertainty!<0);
 if(teams.size<2||missing.length)return {status:'unavailable' as const,reason:teams.size<2?'At least two opposing teams are required.':'Established ratings are not available for every player.',teams:[],skillGap:null,percentage:null};
 const rows=[...teams].map(([team,members])=>({team,players:members.length,strength:members.reduce((s,p)=>s+p.rating!,0),uncertainty:Math.sqrt(members.reduce((s,p)=>s+p.uncertainty!**2,0)),games:members.reduce((s,p)=>s+(p.games??0),0)}));
 const high=Math.max(...rows.map(t=>t.strength)),low=Math.min(...rows.map(t=>t.strength));
 if(!Number.isFinite(high)||!Number.isFinite(low)||rows.some(t=>!Number.isFinite(t.uncertainty)))return {status:'unavailable' as const,reason:'Team totals exceed the supported range.',teams:[],skillGap:null,percentage:null};
 return {status:'advisory' as const,reason:'Lower team total / higher team total. Equal totals = 100%. This is not a win probability.',teams:rows,skillGap:high-low,percentage:high===0?100:Math.min(100,100*(low/high))};
}
