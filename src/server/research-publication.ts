import {createHash} from 'node:crypto';
import {RESEARCH_BASE,validateResearchDraft,type ResearchDraft} from '../shared/research';
export interface ResearchRuleset{format:'s2r-research-ruleset-v1';baseId:typeof RESEARCH_BASE;compiler:'0.27.29';id:string;draft:ResearchDraft}
export function rulesetFor(draft:unknown):ResearchRuleset{
 const value=validateResearchDraft(draft);
 const originalIds=new Set<string>(require('./data/research-retail.json').draft.nodes.map((n:{id:string})=>n.id));
 for(const n of value.nodes){if(!originalIds.has(n.id)&&!n.categories.trim())throw Error('Choose affected unit categories for new research '+n.id+'.');if(n.templateId&&!originalIds.has(n.templateId))throw Error('Choose an original research item as the template for '+n.id+'.');if(n.tree==='UNPLACED'||n.col>9||n.row>7)throw Error('In-game research uses the original 9-column, 7-row tree. Place every item inside its faction tree before applying.');}
 const body={format:'s2r-research-ruleset-v1' as const,baseId:RESEARCH_BASE as typeof RESEARCH_BASE,compiler:'0.27.29' as const,draft:value};
 return {...body,id:createHash('sha256').update(JSON.stringify(body)).digest('hex')};
}
export function verifyRuleset(raw:unknown):ResearchRuleset{
 const v=raw as Partial<ResearchRuleset>|null;if(!v||v.format!=='s2r-research-ruleset-v1'||v.baseId!==RESEARCH_BASE||v.compiler!=='0.27.29'||typeof v.id!=='string')throw Error('Incompatible research ruleset.');
 const result=rulesetFor(v.draft);if(result.id!==v.id)throw Error('Research ruleset checksum differs.');return result;
}
