/** Preliminary research documents contain data only. Nothing here patches a game. */
export const RESEARCH_BASE='supreme-commander-2-1.260-iwbp';
export const RESEARCH_TREES=['UEF_LAND','UEF_AIR','UEF_NAVAL','UEF_STRUCTURES','UEF_COMMANDER','CYBRAN_LAND','CYBRAN_AIR','CYBRAN_NAVAL','CYBRAN_STRUCTURES','CYBRAN_COMMANDER','ILLUMINATE_LAND','ILLUMINATE_AIR','ILLUMINATE_STRUCTURES','ILLUMINATE_COMMANDER','UNPLACED'] as const;
export interface ResearchNode{id:string;tree:string;name:string;cost:number;time:number;mass:number;energy:number;categories:string;prerequisites:string[];buffIds:string[];unlocks:string[];abilities:string[];col:number;row:number;availableFromStart?:boolean;iconId?:string;templateId?:string}
export interface ResearchBuff{id:string;weaponCategory:string;effects:Record<string,Record<string,number|string|boolean>>}
export interface ResearchDraft{title:string;nodes:ResearchNode[];buffs:ResearchBuff[];icons?:ResearchIcon[];routes?:ResearchRoute[]}
export interface ResearchState{schema:2;baseId:typeof RESEARCH_BASE;revision:number;updatedAt:string|null;gameplayApplied:boolean;publishedId?:string;migrationNote?:string;referenceIcons?:Record<string,string>;unitIcons?:Record<string,string>;referenceIds?:string[];source:{label:string;url:string;author:string;archiveMd5:string;files:Record<string,string>};draft:ResearchDraft}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{1,63}$/.test(v);
const field=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v);
function text(v:unknown,max:number){return typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v);}
function number(v:unknown,max:number,integer=false){return typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max&&(!integer||Number.isInteger(v));}
function list(v:unknown,max:number,pattern:RegExp){return Array.isArray(v)&&v.length<=max&&new Set(v).size===v.length&&v.every(s=>typeof s==='string'&&pattern.test(s));}
export function researchIssues(raw:unknown):string[]{
 const errors:string[]=[];if(!object(raw)||!text(raw.title,100)||!String(raw.title).trim()||!Array.isArray(raw.nodes)||raw.nodes.length<1||raw.nodes.length>600||!Array.isArray(raw.buffs)||raw.buffs.length>400)return ['Choose a title, 1–600 research nodes and at most 400 bonus definitions.'];
 const icons=new Set<string>();if(raw.icons!==undefined&&(!Array.isArray(raw.icons)||raw.icons.length>48))return ['Use at most 48 custom icons.'];
 for(const icon of (raw.icons??[]) as unknown[]){if(!object(icon)||!id(icon.id)||icons.has(icon.id)||!text(icon.name,64))return ['An icon has an invalid or duplicate ID/name.'];try{researchPng(icon.data);}catch(e){return[(e as Error).message];}icons.add(icon.id);}
 const names=new Set<string>(),cells=new Set<string>(),buffs=new Set<string>();
 for(const b of raw.buffs){if(!object(b)||!id(b.id)||buffs.has(b.id)||!text(b.weaponCategory,128)||!object(b.effects)||Object.keys(b.effects).length>24)return ['A bonus definition has an invalid ID, duplicate ID, filter or effects table.'];buffs.add(b.id);
  for(const [target,values]of Object.entries(b.effects)){if(!field(target)||!object(values)||Object.keys(values).length>24)return ['Bonus '+b.id+' has an invalid effect.'];for(const [key,value]of Object.entries(values))if(!field(key)||!(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e9||text(value,128)))return ['Bonus '+b.id+' has an invalid effect value.'];}
 }
 for(const n of raw.nodes){if(!object(n)||!id(n.id)||!RESEARCH_TREES.includes(n.tree as typeof RESEARCH_TREES[number])||!text(n.name,120)||!String(n.name).trim()||!text(n.categories,512)||!number(n.cost,10000,true)||!number(n.time,36000)||!number(n.mass,1e9)||!number(n.energy,1e9)||!number(n.col,32,true)||!number(n.row,32,true)||n.col===0||n.row===0||!list(n.prerequisites,32,/^[A-Z][A-Z0-9_]{1,63}$/)||!list(n.buffIds,64,/^[A-Z][A-Z0-9_]{1,63}$/)||!list(n.unlocks,64,/^[A-Za-z0-9_ -]{1,128}$/)||!list(n.abilities,64,/^[A-Za-z0-9_]{1,128}$/))return ['A research node has invalid fields. Use a unique ID, nonnegative costs, grid positions 1–32 and valid reference IDs.'];
  if(n.templateId!==undefined&&!id(n.templateId))return ['A research template ID is invalid.'];
  if(n.availableFromStart!==undefined&&typeof n.availableFromStart!=='boolean'||n.availableFromStart===true&&(n.unlocks as string[]).length===0||n.iconId!==undefined&&(!id(n.iconId)||!icons.has(n.iconId)))return ['Starting-unit availability requires linked unit unlocks, and custom icons must exist in this draft.'];
  if(names.has(n.id))errors.push('Duplicate research ID: '+n.id);names.add(n.id);const cell=n.tree+':'+n.col+':'+n.row;if(cells.has(cell))errors.push('Two nodes occupy '+n.tree+' column '+n.col+', row '+n.row+'.');cells.add(cell);
 }
 const nodes=raw.nodes as unknown as ResearchNode[],byId=new Map(nodes.map(n=>[n.id,n]));
 for(const n of nodes){for(const prerequisite of n.prerequisites)if(!names.has(prerequisite))errors.push(n.id+' references missing prerequisite '+prerequisite+'.');for(const b of n.buffIds)if(!buffs.has(b))errors.push(n.id+' references missing bonus '+b+'.');}
 if(raw.routes!==undefined&&(!Array.isArray(raw.routes)||raw.routes.length>2400))return ['Use at most 2,400 custom connection routes.'];const routes=new Set<string>();
 for(const route of (raw.routes??[]) as unknown[]){if(!object(route)||!id(route.from)||!id(route.to)||!byId.get(route.to)?.prerequisites.includes(route.from)||!['auto','straight','elbow'].includes(String(route.style))||typeof route.bend!=='number'||!Number.isFinite(route.bend)||Math.abs(route.bend)>1)return ['A connection route has invalid endpoints, style or bend.'];const key=route.from+'>'+route.to;if(routes.has(key))return ['Duplicate connection route.'];routes.add(key);}
 const visited=new Set<string>(),active=new Set<string>();let cyclic=false;function visit(key:string){if(active.has(key)){cyclic=true;return;}if(visited.has(key))return;active.add(key);for(const next of byId.get(key)?.prerequisites??[])visit(next);active.delete(key);visited.add(key);}for(const n of nodes)visit(n.id);if(cyclic)errors.push('Prerequisite links contain a cycle.');
 return errors.slice(0,100);
}
export function validateResearchDraft(raw:unknown):ResearchDraft{
 const errors=researchIssues(raw);if(errors.length)throw Error(errors.join(' '));const value=raw as ResearchDraft;
 const draft:ResearchDraft={title:value.title.trim(),nodes:value.nodes.map(n=>({id:n.id,tree:n.tree,name:n.name,cost:n.cost,time:n.time,mass:n.mass,energy:n.energy,categories:n.categories,prerequisites:[...n.prerequisites],buffIds:[...n.buffIds],unlocks:[...n.unlocks],abilities:[...n.abilities],col:n.col,row:n.row,availableFromStart:n.availableFromStart===true,...(n.iconId?{iconId:n.iconId}:{}),...(n.templateId?{templateId:n.templateId}:{})})),
  buffs:value.buffs.map(b=>({id:b.id,weaponCategory:b.weaponCategory,effects:Object.fromEntries(Object.entries(b.effects).map(([key,props])=>[key,{...props}]))})),
  icons:(value.icons??[]).filter(icon=>value.nodes.some(n=>n.iconId===icon.id)).map(icon=>({id:icon.id,name:icon.name,data:icon.data})),routes:(value.routes??[]).map(r=>({from:r.from,to:r.to,style:r.style,bend:r.bend}))};
 if(new TextEncoder().encode(JSON.stringify(draft)).length>RESEARCH_DOCUMENT_LIMIT-100_000)throw Error('Research draft exceeds its 8 MiB file limit.');return draft;
}

export function researchDocument(draft:unknown){return {schema:2,baseId:RESEARCH_BASE,gameplayApplied:false,source:{label:'Supreme Commander 2 1.260 + Infinite War Battle Pack',url:'',author:'Original game reference'},draft:validateResearchDraft(draft)};}

export const RESEARCH_DOCUMENT_LIMIT=8_388_608;
export interface ResearchIcon{id:string;name:string;data:string}
export interface ResearchRoute{from:string;to:string;style:'auto'|'straight'|'elbow';bend:number}
/** Inspect a bounded canonical raster PNG; no SVG, URLs, animation or executable content. */
export function researchPng(data:unknown):Uint8Array{
 if(typeof data!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)||data.length>131_100)throw Error('Choose a PNG icon no larger than 96 KiB after conversion.');
 const bytes=Uint8Array.from(atob(data.slice(22)),c=>c.charCodeAt(0));if(bytes.length>98_304||![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b))throw Error('Invalid PNG icon.');
 const view=new DataView(bytes.buffer);let at=8,header=false,image=false,end=false;
 while(at+12<=bytes.length){const size=view.getUint32(at),type=String.fromCharCode(...bytes.subarray(at+4,at+8));if(size>98_304||at+12+size>bytes.length)throw Error('Invalid PNG icon chunk.');let crc=0xffffffff;for(let i=at+4;i<at+8+size;i++){crc^=bytes[i];for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}if(((crc^0xffffffff)>>>0)!==view.getUint32(at+8+size))throw Error('Invalid PNG icon checksum.');
  if(!['IHDR','IDAT','IEND','sRGB','gAMA','cHRM','pHYs'].includes(type))throw Error('Unsupported PNG icon metadata. Import a PNG, JPEG or WebP through the editor.');
  if(type==='IHDR'){if(header||at!==8||size!==13||view.getUint32(at+8)!==128||view.getUint32(at+12)!==128||bytes[at+16]!==8||![2,6].includes(bytes[at+17])||bytes[at+18]!==0||bytes[at+19]!==0||bytes[at+20]!==0)throw Error('Icons must be 128 × 128 non-interlaced RGB/RGBA PNG images.');header=true;}
  if(type==='IDAT'){if(!header||end)throw Error('Invalid PNG icon order.');image=true;}if(type==='IEND'){if(size!==0||!header||!image||at+12!==bytes.length)throw Error('Invalid PNG icon end.');end=true;break;}at+=size+12;
 }if(!end)throw Error('Incomplete PNG icon.');return bytes;
}

/** Imported node art wins; unit unlocks use the same Reforged build textures. */
export function researchNodeIcon(node:ResearchNode,draft:ResearchDraft,state:Pick<ResearchState,'referenceIcons'|'unitIcons'>):string|undefined{
 const custom=draft.icons?.find(icon=>icon.id===node.iconId);if(custom)return custom.data;
 const units=[...new Set(node.unlocks.map(id=>id.toLowerCase()).filter(id=>Object.hasOwn(state.unitIcons??{},id)&&typeof state.unitIcons?.[id]==='string'))];
 if(units.length===1)return state.unitIcons![units[0]];
 return state.referenceIcons?.[node.id]||state.referenceIcons?.[node.templateId??''];
}
