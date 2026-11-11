'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {ResearchWorkshopStore}=require('./research');
const {verifyRuleset}=require('./research-publication');
const {immutableJson}=require('./immutable-json');
const {ApiError}=require('./lobby');
const DEFAULT_PROFILE='vanilla-plus';
const ROSTER_COMPILER='0382';
const REFORGED_BALANCE='reforged-balance';
const ACTIVE_AI='evidence-ai-6';
const AI_REVISIONS=new Set(['replay-ai-2','replay-ai-3','evidence-ai-4','evidence-ai-5',ACTIVE_AI]);
const PROFILES=Object.freeze([
 {id:'vanilla-1.260-iwbp',name:'Vanilla + Infinite War Battle Pack',editable:false},
 {id:'vanilla-plus',name:'Vanilla Plus',editable:true},
 {id:'reforged-balance',name:'Reforged Balance',editable:true}
]);
function profile(id=DEFAULT_PROFILE){const p=PROFILES.find(p=>p.id===id);if(!p)throw new ApiError(400,'Unknown gameplay ruleset.');return p;}
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function patchFor(profileId,version,research,compiler=profileId===REFORGED_BALANCE?ROSTER_COMPILER:'0370',aiRevision){
 if(compiler!=='0370'&&(!['0379','03711','03712','03714','03715','03716','03717','03718','03721',ROSTER_COMPILER].includes(compiler)||profileId!==REFORGED_BALANCE))throw Error('Unsupported gameplay patch. Update the client.');
 profile(profileId);
 if(typeof version!=='string'||!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version))throw new ApiError(400,'Use a balance version such as 1.0.1.');
 if(profileId==='vanilla-1.260-iwbp'&&research)throw new ApiError(400,'The original-game ruleset is read-only.');
 if(aiRevision!==undefined&&!AI_REVISIONS.has(aiRevision))throw Error('Unsupported AI revision. Update the client.');
 const body={format:'s2r-gameplay-v1',profileId,version,compiler,...(research?{research:verifyRuleset(research)}:{}),...(aiRevision?{aiRevision}:{})};
 return {...body,id:sha(JSON.stringify(body))};
}
const publishedPatch=(id,version,research)=>patchFor(id,version,research,undefined,ACTIVE_AI);
function verifyPatch(raw){
 if(!raw||raw.format!=='s2r-gameplay-v1'||typeof raw.compiler!=='string')throw Error('Unsupported gameplay patch. Update the client.');
 const result=patchFor(raw.profileId,raw.version,raw.research,raw.compiler,raw.aiRevision);
 if(result.id!==raw.id)throw Error('Gameplay patch checksum differs.');
 return result;
}
const summary=p=>({id:p.id,profileId:p.profileId,version:p.version,compiler:p.compiler,researchId:p.research?.id,...(p.aiRevision?{aiRevision:p.aiRevision}:{})});
class GameplayStore{
 constructor(directory,research){this.directory=directory;this.research=research;this.stores=new Map([[DEFAULT_PROFILE,research],['reforged-balance',new ResearchWorkshopStore(directory&&path.join(directory,'reforged-balance-research.json'))]]);this.patches=new Map();this.serial=Promise.resolve();}
 async load(){
  if(this.loading)return this.loading;
  if(this.state)return;
  this.loading=this.read().finally(()=>{this.loading=null;});
  return this.loading;
 }
 async read(){
  if(this.directory)try{
   const f=path.join(this.directory,'gameplay.json'),s=await fs.lstat(f);if(!s.isFile()||s.isSymbolicLink()||s.size>1000000)throw Error('Invalid gameplay settings file.');
   const d=JSON.parse(await fs.readFile(f,'utf8'));
   if(d.schema!==1||!Number.isSafeInteger(d.revision)||d.revision<1||!Array.isArray(d.patches)||d.patches.length>512)throw Error('Invalid gameplay settings.');
   for(const p of d.patches){profile(p.profileId);if(!/^[a-f0-9]{64}$/.test(p.id))throw Error('Invalid gameplay patch identity.');}
   this.state=d;
   for(const p of PROFILES){const active=await this.getPatch(d.active[p.id]);if(active.profileId!==p.id)throw Error('Gameplay active patch belongs to another ruleset.');}
   const ladder=await this.getPatch(d.ladder.patchId);if(ladder.profileId!==d.ladder.profileId)throw Error('Ladder gameplay settings differ.');
   const upgrades=[];
   for(const profile of PROFILES){
    const active=await this.getPatch(d.active[profile.id]);
    if(active.aiRevision!==ACTIVE_AI||profile.id===REFORGED_BALANCE&&active.compiler!==ROSTER_COMPILER){
     upgrades.push(publishedPatch(profile.id,this.nextVersion(profile.id),active.research));
    }
   }
   if(upgrades.length&&d.patches.length+upgrades.length<=512){
    const next=structuredClone(d);
    for(const patch of upgrades){
     await this.writePatch(patch);
     next.patches.push(summary(patch));
     next.active[patch.profileId]=patch.id;
    }
    next.revision++;
    await this.persist(next);
    this.state=next;
   }
   return;
  }catch(e){this.state=null;if(e.code!=='ENOENT')throw e;}
  await this.research.load();const activeId=await this.research.activeId();const inherited=activeId?await this.research.getRuleset(activeId):undefined;
  const state={schema:1,revision:1,patches:[],active:{},ladder:null};
  for(const p of PROFILES){const patch=publishedPatch(p.id,'1.0.0',p.editable?inherited:undefined);await this.writePatch(patch);state.patches.push(summary(patch));state.active[p.id]=patch.id;}
  const other=this.stores.get('reforged-balance');const current=await other.get();
  if(current.revision===0)await other.save((await this.research.get()).draft,0,false);
  state.ladder={profileId:DEFAULT_PROFILE,patchId:state.active[DEFAULT_PROFILE]};
  await this.persist(state);this.state=state;
 }
 async persist(state){if(!this.directory)return;await fs.mkdir(this.directory,{recursive:true});const file=path.join(this.directory,'gameplay.json'),tmp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(state),{flag:'wx',mode:0o600});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true});}}
 async writePatch(p){if(this.directory){const dir=path.join(this.directory,'patches');await fs.mkdir(dir,{recursive:true});await immutableJson(path.join(dir,p.id+'.json'),JSON.stringify(p));}this.patches.set(p.id,p);}
 async getPatch(id){
  if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new ApiError(404,'Gameplay patch not found.');
  if(this.patches.has(id))return structuredClone(this.patches.get(id));
  if(!this.directory)throw new ApiError(404,'Gameplay patch not found.');
  const file=path.join(this.directory,'patches',id+'.json');let raw;try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>8388608)throw Error('Invalid gameplay patch file.');raw=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')throw new ApiError(404,'Gameplay patch not found.');throw e;}
  const p=verifyPatch(raw);if(p.id!==id)throw Error('Gameplay patch identity differs.');this.patches.set(id,p);return structuredClone(p);
 }
 currentLadder(){if(!this.state)throw Error('Gameplay settings have not loaded.');return {...this.state.patches.find(p=>p.id===this.state.ladder.patchId)};}
 async catalog(){await this.load();return {revision:this.state.revision,profiles:PROFILES.map(p=>({...p,activeId:this.state.active[p.id],patches:this.state.patches.filter(x=>x.profileId===p.id)})),ladder:this.currentLadder()};}
 async active(id=DEFAULT_PROFILE){await this.load();profile(id);return this.getPatch(this.state.active[id]);}
 async view(id=DEFAULT_PROFILE,selected='draft',reference=false){
  await this.load();const p=profile(id),store=p.editable?this.stores.get(id):this.research;
  let value=reference?await store.getReference():await store.get();
  if(!p.editable)value=await store.getReference();
  else if(selected!=='draft'){const patch=await this.getPatch(selected);if(patch.profileId!==id)throw new ApiError(400,'This patch belongs to another ruleset.');value={...value,draft:patch.research?.draft??(await store.getReference()).draft,publishedId:patch.research?.id};}
  const catalog=await this.catalog();return {...value,gameplay:{profileId:id,selected,readOnly:!p.editable||selected!=='draft',profiles:catalog.profiles,revision:catalog.revision,activeId:this.state.active[id],nextVersion:this.nextVersion(id)}};
 }
 nextVersion(id){const values=this.state.patches.filter(p=>p.profileId===id).map(p=>p.version.split('.').map(Number)).sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);const v=values.at(-1)||[1,0,0];return v[0]+'.'+v[1]+'.'+(v[2]+1);}
 change(fn){const job=this.serial.then(fn);this.serial=job.catch(()=>{});return job;}
 async save(id,body){return this.change(async()=>{
  await this.load();const p=profile(id);if(!p.editable||body.selected&&body.selected!=='draft')throw new ApiError(409,'Create a draft from this patch before editing. Original-game research is read-only.');
  const store=this.stores.get(id);
  if(body.apply&&this.state.patches.some(p=>p.profileId===id&&p.version===body.balanceVersion))throw new ApiError(409,'That balance version is published. Choose a newer version.');
  if(body.apply){patchFor(id,body.balanceVersion,undefined);if(this.state.patches.length>=512)throw new ApiError(409,'Gameplay publication capacity reached.');const compare=(a,b)=>{for(let i=0;i<3;i++){const d=Number(a.split('.')[i])-Number(b.split('.')[i]);if(d)return d;}return 0;};if(this.state.patches.some(p=>p.profileId===id&&compare(body.balanceVersion,p.version)<=0))throw new ApiError(409,'Choose a newer balance version than the published patches.');}
  const result=await store.save(body.draft,body.expectedRevision,body.apply===true);
  if(body.apply){const patch=publishedPatch(id,body.balanceVersion,await store.getRuleset(result.publishedId));await this.writePatch(patch);const next=structuredClone(this.state);next.revision++;next.patches.push(summary(patch));if(next.patches.length>512)throw new ApiError(409,'Gameplay publication capacity reached.');next.active[id]=patch.id;await this.persist(next);this.state=next;}
  return this.view(id);
 });}
 async fork(id,patchId,expectedRevision){return this.change(async()=>{await this.load();if(!profile(id).editable)throw new ApiError(403,'Original-game research is read-only.');const p=await this.getPatch(patchId);if(p.profileId!==id)throw new ApiError(400,'This patch belongs to another ruleset.');const store=this.stores.get(id);await store.save(p.research?.draft??(await store.getReference()).draft,expectedRevision,false);return this.view(id);});}
 async reset(id,expectedRevision){return this.change(async()=>{await this.load();if(!profile(id).editable)throw new ApiError(403,'Original-game research is read-only.');await this.stores.get(id).reset(expectedRevision);return this.view(id);});}
 async setLadder(body){return this.change(async()=>{await this.load();if(body.expectedRevision!==this.state.revision)throw new ApiError(409,'Gameplay settings changed. Reload the ladder settings.');const p=await this.getPatch(body.patchId);if(p.profileId!==body.profileId)throw new ApiError(400,'Ladder patch belongs to another ruleset.');const next=structuredClone(this.state);next.revision++;next.ladder={profileId:p.profileId,patchId:p.id};await this.persist(next);this.state=next;return this.catalog();});}
 async researchRuleset(id){for(const store of this.stores.values())try{return await store.getRuleset(id);}catch(e){if(e.status!==404)throw e;}throw new ApiError(404,'Research ruleset not found.');}
}
module.exports={GameplayStore,PROFILES,DEFAULT_PROFILE,profile,patchFor,verifyPatch,summary};
