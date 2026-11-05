/** OpenSkill 5.0.1, Plackett–Luce. Vendored official implementation and licenses. */
const skill=require('./vendor/openskill.cjs') as {rating:()=>Skill;rate:(teams:Skill[][],options:{rank:number[]})=>Skill[][]};
export interface Skill{mu:number;sigma:number}
export interface SkillResult{players:{id:string;team?:number;rank:number}[]}
export function ratings(results:SkillResult[]){
 const state=new Map<string,Skill&{games:number}>();
 for(const result of results){
  const teams=new Map<string,typeof result.players>();
  for(const p of result.players){const key=p.team===undefined?'p:'+p.id:'t:'+p.team;const t=teams.get(key)??[];t.push(p);teams.set(key,t);}
  const groups=[...teams.values()];if(groups.length<2)continue;
  const updated=skill.rate(groups.map(g=>g.map(p=>state.get(p.id)??skill.rating())),{rank:groups.map(g=>g[0].rank)});
  groups.forEach((g,i)=>g.forEach((p,j)=>state.set(p.id,{...updated[i][j],games:(state.get(p.id)?.games??0)+1})));
 }
 return state;
}
export function profile(state:ReturnType<typeof ratings>,id:string){const s=state.get(id)??{...skill.rating(),games:0};return {...s,rating:Math.max(0,Math.round((s.mu-3*s.sigma)*10)/10),uncertainty:s.sigma,strength:s.mu-s.sigma};}
