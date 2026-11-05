import {CLIENT_VERSION} from '../shared/model';
/** Only revisions with a preserved generator can select simulation data. */
export const REPLAY_REVISIONS = ['0335','0334','0333','0332','0331','0329','0328','0327','0326','0325','0324','0323','0322','0321','0320','0313','0312','0311','0310','0306','0305','0304','0301','0300','0292','0291','0290','0282','0280','02733','02732','02731','02730','02729','02728','02727','02726','02725','02723','02722','02721','02720','02719'] as const;
export type ReplayRevision = 'current' | typeof REPLAY_REVISIONS[number];
export function replayRevision(version:string|undefined):ReplayRevision {
 if(version===undefined||version===CLIENT_VERSION)return 'current';
 if(version==='0.33.0')return '0331';
 // 0.30.2/0.30.3 share the delivered 0.30.4 battle profile.
 if(version==='0.30.2'||version==='0.30.3')return '0304';
 // 0.28.2 changed client map rendering only; its native profile is 0.28.1.
 if(version==='0.28.1')return '0282';
 const known=REPLAY_REVISIONS.find(r=>version===`0.${Number(r.slice(1,3))}.${Number(r.slice(3))}`);
 if(!known)throw Error('This Reforged replay requires version '+version+'. Its simulation profile is not included in this client.');
 return known;
}
export function validateReplayRevision(value:unknown):ReplayRevision {
 if(value===undefined||value==='current')return 'current';
 if(REPLAY_REVISIONS.some(r=>r===value))return value as ReplayRevision;
 throw Error('Unsupported replay simulation profile.');
}
