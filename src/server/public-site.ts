import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {CLIENT_VERSION} from '../shared/model';
import type {ResearchWorkshopStore} from './research';
let catalogue:Promise<{units:Record<string,unknown>[];sources:Record<string,string>}>|undefined;
export async function publicUnits(research:ResearchWorkshopStore){
 const data:{units:Record<string,unknown>[];sources:Record<string,string>}=await(catalogue??=readFile(path.join(__dirname,'data/public-units.json'),'utf8').then(JSON.parse));
 const icons=JSON.parse(await readFile(path.join(__dirname,'data/research-reforged-icons.json'),'utf8')).unitIcons;
 const active=await research.activeId();const draft=active?(await research.getRuleset(active)).draft:(await research.getReference()).draft;
 return {version:CLIENT_VERSION,researchId:active??null,basis:'Base unit values before research bonuses. Custom lobbies can select a different research ruleset.',units:data.units.map(u=>({...u,icon:icons[u.id as string]??null,research:draft.nodes.filter(n=>n.unlocks.some(id=>id.toLowerCase()===u.id)).map(n=>({id:n.id,name:n.name,cost:n.cost,prerequisites:n.prerequisites,availableFromStart:n.availableFromStart===true}))}))};
}
export async function publicChangelog(){return JSON.parse(await readFile(path.join(__dirname,'data/public-changelog.json'),'utf8'));}
