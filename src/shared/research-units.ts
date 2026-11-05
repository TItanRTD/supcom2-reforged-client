import type {ResearchDraft,ResearchNode} from './research';
export const OPTIONAL_RESEARCH_UNITS=[

 {id:'rfuc01',name:'Centurion',tree:'UEF_LAND',role:'UEF light experimental',factory:'Land Gantry',unlockId:'RF_CENTURION_UNLOCK',locked:true,provisional:true},
 {id:'rfurb01',name:'Swab',tree:'UEF_LAND',role:'UEF reclamation bot',factory:'Land Factory',unlockId:'RF_SWAB_UNLOCK',locked:true},
 {id:'rfcrb01',name:'Caliper',tree:'CYBRAN_LAND',role:'Cybran reclamation bot',factory:'Land Factory',unlockId:'RF_CALIPER_UNLOCK',locked:true},
 {id:'rfirb01',name:'Conduit',tree:'ILLUMINATE_LAND',role:'Aeon reclamation bot',factory:'Land Factory',unlockId:'RF_CONDUIT_UNLOCK',locked:true},
 {id:'rfuas01',name:'Kestrel',tree:'UEF_AIR',role:'UEF air scout',factory:'Air Factory',unlockId:'RF_KESTREL_UNLOCK',locked:false},
 {id:'rfias01',name:'Oracle',tree:'ILLUMINATE_AIR',role:'Aeon air scout',factory:'Air Factory',unlockId:'RF_ORACLE_UNLOCK',locked:false},
 {id:'rfup01',name:'UEF Light Point Defense',tree:'UEF_STRUCTURES',role:'UEF defense',factory:'ACU or Engineer',unlockId:'RF_UEF_LIGHT_PD_UNLOCK',locked:false},
 {id:'rfcp01',name:'Cybran Light Point Defense',tree:'CYBRAN_STRUCTURES',role:'Cybran defense',factory:'ACU or Engineer',unlockId:'RF_CYBRAN_LIGHT_PD_UNLOCK',locked:false},
 {id:'rfip01',name:'Aeon Light Point Defense',tree:'ILLUMINATE_STRUCTURES',role:'Aeon defense',factory:'ACU or Engineer',unlockId:'RF_AEON_LIGHT_PD_UNLOCK',locked:false},
 {id:'rfut01',name:'UEF Tactical Missile Defense',tree:'UEF_STRUCTURES',role:'UEF tactical missile defense',factory:'ACU or Engineer',unlockId:'RF_UEF_TMD_UNLOCK',locked:true,provisional:true},
 {id:'rfct01',name:'Cybran Tactical Missile Defense',tree:'CYBRAN_STRUCTURES',role:'Cybran tactical missile defense',factory:'ACU or Engineer',unlockId:'RF_CYBRAN_TMD_UNLOCK',locked:true,provisional:true},
 {id:'rfit01',name:'Aeon Tactical Missile Defense',tree:'ILLUMINATE_STRUCTURES',role:'Aeon tactical missile defense',factory:'ACU or Engineer',unlockId:'RF_ILLUMINATE_TMD_UNLOCK',locked:true,provisional:true},
] as const;
export function optionalUnitHelp(id:string){const unit=OPTIONAL_RESEARCH_UNITS.find(u=>u.id===id);if(!unit)return '';return unit.name+' is built by the '+unit.factory+'. '+(unit.id==='rfuc01'?'Researching this unlock also enables the UEF Land Gantry. ':'')+(unit.locked?'It stays locked until you add and apply an unlock.':'Adding an unlock makes this unit require research when you apply the draft.')+('provisional'in unit&&unit.provisional?' Its gameplay balance is provisional.':'');}
/** Invoked only by the editor's explicit Add unit unlock action. */
export function optionalUnitNode(draft:ResearchDraft,unitId:string):ResearchNode{
 const unit=OPTIONAL_RESEARCH_UNITS.find(u=>u.id===unitId);if(!unit)throw Error('Choose an installed optional unit.');
 if(draft.nodes.some(n=>n.unlocks.some(id=>id.toLowerCase()===unit.id)))throw Error(unit.name+' is already linked to a research node.');
 let id:string=unit.unlockId,suffix=2;while(draft.nodes.some(n=>n.id===id))id=unit.unlockId+'_'+suffix++;
 for(let row=1;row<=7;row++)for(let col=1;col<=9;col++)if(!draft.nodes.some(n=>n.tree===unit.tree&&n.row===row&&n.col===col))return{id,name:unit.name,tree:unit.tree,cost:1,time:0,mass:0,energy:0,categories:unit.id,prerequisites:[],buffIds:[],unlocks:[unit.id.toUpperCase()],abilities:[],col,row,availableFromStart:false};
 throw Error('The '+unit.tree.split('_')[0]+' tree has no empty cell. Move or remove a node before adding '+unit.name+'.');
}
