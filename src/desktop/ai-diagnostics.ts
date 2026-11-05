/** Interpret only the versioned AI records in the correlated simulation log.
 * Issuing an order is not evidence of its completion or competitive strength. */
export interface AiEvent {army:number;seq:number;tick:number;event:string;fields:Record<string,string>}
export interface AiArmyReport {army:number;level:string|null;lastTick:number;events:number;completed:number;failed:number;stalled:number;released:number;issued:number;planned:number;observedProgress:number;health:'unverified'|'progress-observed'|'attention';warnings:string[]}
const integer=(s:string)=>/^\d{1,10}$/.test(s)?Number(s):NaN;
const decode=(s:string)=>s.replace(/%([0-9a-f]{2})/gi,(_,n:string)=>String.fromCharCode(parseInt(n,16)));
export function parseAiEvents(log:string):AiEvent[]{
 const events:AiEvent[]=[];let cursor=0,full=false;
 for(const line of log.split(/\r?\n/)){
  const at=line.indexOf('RF_AI|v=1|');if(at<0||line.length-at>4096)continue;
  const pairs=line.slice(at+6).trimEnd().split('|'),values:Record<string,string>=Object.create(null);let valid=true;
  for(const pair of pairs){const match=/^([a-zA-Z][a-zA-Z0-9]{0,31})=([^|]*)$/.exec(pair);if(!match||Object.hasOwn(values,match[1])){valid=false;break;}values[match[1]]=decode(match[2]);}
  const army=integer(values.army??''),seq=integer(values.seq??''),tick=integer(values.tick??'');
  if(!valid||values.v!=='1'||army<1||army>16||!Number.isInteger(army)||!Number.isInteger(seq)||seq<1||!Number.isInteger(tick)||!/^[a-z][a-z-]{0,39}$/.test(values.event??''))continue;
  const fields:Record<string,string>=Object.create(null);
  for(const [key,value]of Object.entries(values))if(!['v','army','seq','tick','event'].includes(key))fields[key]=value.slice(0,256);
  const event={army,seq,tick,event:values.event,fields};
  if(events.length<20000)events.push(event);else{events[cursor]=event;cursor=(cursor+1)%20000;full=true;}
 }
 return full?[...events.slice(cursor),...events.slice(0,cursor)]:events;
}
export function summarizeAiEvents(events:AiEvent[]):AiArmyReport[]{
 const armies=new Map<number,AiArmyReport>(),sequences=new Map<number,number>(),tasks=new Map<string,{issued:boolean;progress:boolean;done:boolean}>();
 for(const e of events){
  let a=armies.get(e.army);if(!a){a={army:e.army,level:null,lastTick:0,events:0,completed:0,failed:0,stalled:0,released:0,issued:0,planned:0,observedProgress:0,health:'unverified',warnings:[]};armies.set(e.army,a);}
  const warning=(s:string)=>{if(!a!.warnings.includes(s))a!.warnings.push(s);};
  const previous=sequences.get(e.army);
  if(previous===undefined&&e.seq>1)warning('Earlier AI records are unavailable; this report starts partway through the game.');
  if(previous!==undefined&&e.seq<=previous){warning('Duplicate or reset event sequence; later records need review.');continue;}
  if(previous!==undefined&&e.seq!==previous+1)warning('Missing AI records; diagnostics may be incomplete.');
  sequences.set(e.army,e.seq);a.events++;a.lastTick=Math.max(a.lastTick,e.tick);
  if(['controller-start','controller-state','fairness-passed','fairness-failed'].includes(e.event)&&/^(easy|normal|hard|reforger|custom)$/.test(e.fields.level??''))a.level=e.fields.level;
  if(Number(e.fields.dropped)>0)warning('Detail logging was rate limited.');
  if(e.fields.truncated==='true')warning('AI record fields were truncated.');
  const taskId=e.fields.task;
  const key=taskId?e.army+':'+taskId:null;
  if(e.event==='task-planned'){a.planned++;if(key)tasks.set(key,{issued:false,progress:false,done:false});}
  if(e.event==='order-issued'){a.issued++;if(key){const t=tasks.get(key);if(t)t.issued=true;else warning('An order has no correlated task record.');}}
  if(e.event==='task-progress'&&key){const t=tasks.get(key);if(t?.issued&&!t.done&&e.fields.evidence==='observed'){t.progress=true;a.observedProgress++;}else warning('A progress report lacks a matching issued task and observed evidence.');}
  if(e.event==='task-completed'&&key){
   const t=tasks.get(key);
   if(t?.issued&&!t.done&&e.fields.evidence==='observed'){t.done=true;a.completed++;}
   else warning('A completion lacks a matching issued task and observed evidence.');
  }
  if(e.event==='task-failed'){a.failed++;if(key){const t=tasks.get(key);if(t)t.done=true;}}
  if(e.event==='task-released'){a.released++;if(key){const t=tasks.get(key);if(t)t.done=true;}}
  if(e.event==='task-stalled'){a.stalled++;warning('A task stalled; inspect its reason and recovery.');}
  if(e.event==='controller-error'||e.event==='fairness-failed')warning('Controller or fairness validation failed.');
  if(e.event==='capability-unavailable')warning('A required native capability is unavailable.');
 }
 for(const a of armies.values()){
  const states=events.filter(e=>e.army===a.army&&e.event==='controller-state');
  if(states.length>=2&&states.at(-1)!.tick-states[0].tick>=100&&states.every(e=>e.fields.ownUnits==='0'))a.warnings.push('Owned unit registry unavailable throughout the observed run; construction and combat cannot progress.');
  if(!a.planned)a.warnings.push('No tasks were planned in the available records.');
  if(a.issued&&!a.completed&&!a.observedProgress)a.warnings.push('Orders were issued without observed progress or completion yet.');
  if(a.warnings.some(x=>/failed|stalled|unavailable|lacks/.test(x)))a.health='attention';
  else if(a.completed>0||a.observedProgress>0)a.health='progress-observed';
 }
 return [...armies.values()].sort((a,b)=>a.army-b.army);
}
export function aiDiagnosticsText(events:AiEvent[]):string{
 const rows=summarizeAiEvents(events);
 const lines=['Supreme Commander 2: Reforged AI diagnostics',
  'Observed progress is evidence of actions, not proof of complete correctness or competitive strength.',
  'Target health loss shows engagement activity; it does not attribute damage to a particular attacker. Released tasks are replans, not confirmed kills.',
  'Missing records, an early export or a closed log can limit this report.',''];
 if(!rows.length)lines.push('No Reforged AI diagnostic events were found in this game log.');
 const display=(value:string)=>value.replace(/[\x00-\x1f\x7f]/g,' ');
 for(const a of rows){lines.push('Army '+a.army+' | '+(a.level??'unknown difficulty')+' | '+a.health,
  'Planned '+a.planned+'; orders issued '+a.issued+'; observed progress '+a.observedProgress+'; completed '+a.completed+'; failed '+a.failed+'; stalled '+a.stalled+'; released for replanning '+a.released+'.',
  ...a.warnings.map(s=>'  '+s));
  const own=events.filter(e=>e.army===a.army),recent=[...own].reverse(),latest=recent.find(e=>e.event==='controller-state'),fairness=recent.find(e=>e.event==='fairness-passed'||e.event==='fairness-failed');
  if(latest)lines.push('Latest state: '+Object.entries(latest.fields).map(([k,v])=>k+'='+display(v)).join('; '));
  lines.push(fairness?'Rule readback: '+fairness.event+'; '+Object.entries(fairness.fields).map(([k,v])=>k+'='+display(v)).join('; '):'Rule readback: unavailable in the retained records.');
  lines.push('Recent task records:');
  for(const e of own.filter(e=>e.event.startsWith('task-')||e.event==='order-issued'||e.event==='controller-error'||e.event==='field-objective').slice(-12))lines.push('  tick '+e.tick+' | '+e.event+' | '+Object.entries(e.fields).map(([k,v])=>k+'='+display(v)).join('; '));
  lines.push('');}
 return lines.join('\n');
}
