import {immutableJson} from './immutable-json';
import {readFile,writeFile,mkdir,rename,rm,copyFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {rulesetFor,verifyRuleset,type ResearchRuleset} from './research-publication';
import {inflateSync} from 'node:zlib';
import {ApiError} from './lobby';
import {RESEARCH_BASE,RESEARCH_DOCUMENT_LIMIT,researchPng,validateResearchDraft,type ResearchState,type ResearchDraft} from '../shared/research';
/** Admin drafts and immutable published rulesets. Existing rooms retain their pinned version. */
export class ResearchWorkshopStore{
 private publications=new Map<string,ResearchRuleset>();
 private state?:ResearchState;private loading?:Promise<void>;private serial:Promise<unknown>=Promise.resolve();
 constructor(private file?:string,private referenceFile=path.join(__dirname,'data/research-retail.json')){}
 private async load(){if(this.state)return;return this.loading??=this.read().catch(e=>{this.loading=undefined;throw e;});}
 private async reference():Promise<ResearchState>{const raw=JSON.parse(await readFile(this.referenceFile,'utf8'));if(raw.schema!==1||raw.baseId!==RESEARCH_BASE)throw Error('Research reference is incompatible.');return{schema:2 as const,baseId:RESEARCH_BASE,revision:0,updatedAt:null,gameplayApplied:false as const,source:raw.source,draft:validateResearchDraft(raw.draft),referenceIds:raw.draft.nodes.map((n:{id:string})=>n.id),...await this.referenceIcons()};}
 private async referenceIcons(){
  const stock=JSON.parse(await readFile(path.join(__dirname,'data/research-retail-icons.json'),'utf8')) as Record<string,string>;
  const reforged=JSON.parse(await readFile(path.join(__dirname,'data/research-reforged-icons.json'),'utf8')) as {format:string;unitIcons:Record<string,string>;referenceUnits:Record<string,string>};
  if(reforged.format!=='s2r-research-unit-icons-v1')throw Error('Reforged research icons are incompatible.');
  for(const [node,unit]of Object.entries(reforged.referenceUnits)){if(reforged.unitIcons[unit])stock[node]=reforged.unitIcons[unit];}
  return {referenceIcons:stock,unitIcons:reforged.unitIcons};
 }
 private async read(){
  const baseline=await this.reference();
  if(this.file)try{
   const stat=await lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>RESEARCH_DOCUMENT_LIMIT)throw Error('Invalid research draft store.');
   const bytes=await readFile(this.file,'utf8'),saved=JSON.parse(bytes);
   if(![1,2].includes(saved.schema)||!Number.isSafeInteger(saved.revision)||saved.revision<1||typeof saved.updatedAt!=='string'||!Number.isFinite(Date.parse(saved.updatedAt)))throw Error('Research draft store is incompatible.');
   baseline.revision=saved.revision;baseline.updatedAt=saved.updatedAt;
   if(saved.baseId==='storm-2.0-dlc-reference'){
    const backup=this.file+'.storm-'+createHash('sha256').update(bytes).digest('hex').slice(0,16)+'.backup.json';
    try{await copyFile(this.file,backup,1);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    baseline.migrationNote='Your previous STORM draft was archived beside the server draft. This editor now uses original Supreme Commander 2 research.';
   }else{
    if(saved.baseId!==RESEARCH_BASE)throw Error('Research draft store is incompatible.');
    baseline.draft=validateResearchDraft(saved.draft);validateIconPixels(baseline.draft);
    if(saved.publishedId!==undefined){if(!/^[a-f0-9]{64}$/.test(saved.publishedId))throw Error('Invalid published research ID.');baseline.publishedId=saved.publishedId;baseline.gameplayApplied=true;}
   }
  }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  this.state=baseline;
 }
 async activeId(){await this.load();return this.state!.publishedId;}
 async getRuleset(id:string){
  if(!/^[a-f0-9]{64}$/.test(id))throw new ApiError(404,'Research ruleset not found.');
  const cached=this.publications.get(id);if(cached)return structuredClone(cached);
  if(!this.file)throw new ApiError(404,'Research ruleset not found.');
  const file=path.join(this.file+'.rulesets',id+'.json');let raw;
  try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.size>RESEARCH_DOCUMENT_LIMIT)throw Error('Invalid research publication.');raw=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'Research ruleset not found.');throw e;}
  const r=verifyRuleset(raw);if(r.id!==id)throw Error('Research publication identity differs.');this.publications.set(id,r);if(this.publications.size>8)this.publications.delete(this.publications.keys().next().value!);return structuredClone(r);
 }
 async getReference(){return this.reference();}
 async get(){await this.load();return structuredClone(this.state!);}
 async save(raw:unknown,expected:unknown,apply=false){const input=raw;return this.change(expected,()=>{try{const draft=validateResearchDraft(input);validateIconPixels(draft);return draft;}catch(e){throw new ApiError(400,(e as Error).message);}},apply);}
 async reset(expected:unknown){return this.change(expected,async()=>(await this.reference()).draft);}
 private change(expected:unknown,next:()=>ResearchDraft|Promise<ResearchDraft>,apply=false){
  const work=this.serial.then(async()=>{await this.load();if(!Number.isSafeInteger(expected)||expected!==this.state!.revision)throw new ApiError(409,'Another administrator saved this draft. Export your edits, then load the server draft before saving again.');const draft=await next(),candidate:ResearchState={...this.state!,draft,revision:this.state!.revision+1,updatedAt:new Date().toISOString()};
   if(apply){let publication:ResearchRuleset;try{publication=rulesetFor(draft);}catch(e){throw new ApiError(400,(e as Error).message);}
    if(this.file){const folder=this.file+'.rulesets';await mkdir(folder,{recursive:true});const target=path.join(folder,publication.id+'.json');await immutableJson(target,JSON.stringify(publication));}
    this.publications.set(publication.id,publication);if(this.publications.size>8)this.publications.delete(this.publications.keys().next().value!);candidate.publishedId=publication.id;candidate.gameplayApplied=true;
   }
   if(this.file){await mkdir(path.dirname(this.file),{recursive:true});const temp=this.file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,JSON.stringify({schema:2,baseId:RESEARCH_BASE,revision:candidate.revision,updatedAt:candidate.updatedAt,draft,...(candidate.publishedId?{publishedId:candidate.publishedId}:{})}),{flag:'wx',mode:0o600});await rename(temp,this.file);}finally{await rm(temp,{force:true});}}
   this.state=candidate;return structuredClone(candidate);
  });this.serial=work.catch(()=>{});return work;
 }
}

function validateIconPixels(draft:ResearchDraft){for(const icon of draft.icons??[]){const bytes=Buffer.from(researchPng(icon.data));const channels=bytes[25]===6?4:3,expected=128*(128*channels+1),chunks:Buffer[]=[];for(let at=8;at+12<=bytes.length;){const size=bytes.readUInt32BE(at);if(bytes.toString('ascii',at+4,at+8)==='IDAT')chunks.push(bytes.subarray(at+8,at+8+size));at+=size+12;}const raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:expected});if(raw.length!==expected)throw Error('Invalid PNG icon pixel data.');for(let row=0;row<128;row++)if(raw[row*(128*channels+1)]>4)throw Error('Invalid PNG icon row filter.');}}
