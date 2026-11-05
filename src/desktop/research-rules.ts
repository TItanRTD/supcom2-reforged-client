import {verifyRuleset,type ResearchRuleset} from '../server/research-publication';
import type {HostRoomRequest} from '../shared/model';
/** Resolve the immutable room pin, never the administrator's newest draft. */
export async function fetchRoomResearch(context:HostRoomRequest,id:unknown):Promise<ResearchRuleset|undefined>{
 if(id===undefined)return;if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('This room has an invalid research ruleset.');
 const response=await fetch(context.server+'/api/research/rulesets/'+id,{headers:{Authorization:'Bearer '+context.token},signal:AbortSignal.timeout(20000),redirect:'error'});
 if(!response.ok||!response.body)throw Error('Could not retrieve this room’s published research. Update the server/client and rejoin.');
 let size=0;const parts:Buffer[]=[];for await(const chunk of response.body){size+=chunk.length;if(size>8_388_608)throw Error('Research publication exceeds its size limit.');parts.push(Buffer.from(chunk));}
 const result=verifyRuleset(JSON.parse(Buffer.concat(parts).toString('utf8')));if(result.id!==id)throw Error('The research publication differs from the room’s pinned version.');return result;
}
