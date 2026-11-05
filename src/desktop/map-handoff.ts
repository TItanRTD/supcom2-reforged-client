import type { MapHandoffStatus } from '../shared/model';
const FAILURE:Record<number,string>={5:'The requested map was not found in the game’s loaded map catalog.',6:'The native lobby did not become ready before the map handoff timed out.',7:'The game’s map catalog did not pass validation.',8:'The native map function returned a different selection.',9:'The lobby closed or host authority changed before map selection.',10:'The game catalog contained duplicate matches for the requested map.'};
function normalise(value:unknown):string|null{
 if(typeof value!=='string'||value.length>240)return null;
 const p=value.replace(/\\/g,'/').toLowerCase();
 return /^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/.test(p)&&!p.split('/').some(s=>s==='.'||s==='..')?p:null;
}
export class MapHandoffTracker {
 private status:MapHandoffStatus;
 private streak=0;
 private lastAt=0;
 private lastSample=-Infinity;
 constructor(private requested:string,private now=Date.now){
  const id=normalise(requested);if(!id)throw new Error('Invalid map handoff request.');this.requested=id;
  this.status={state:'waiting',requestedMap:id,currentMap:null,message:'Applying the room’s selected map. Waiting for the host lobby and two matching readbacks.'};
 }
 unavailable(message='Map readback is unavailable. Confirm the map inside SupCom 2.'){
  this.streak=0;this.status={...this.status,state:'unavailable',currentMap:null,message};
 }
 ingest(value:unknown){
  const s=value as Record<string,unknown>|null;if(!s||typeof s!=='object'){this.unavailable();return;}
  if(s.kind==='ended'){this.unavailable('Game process closed; map confirmation cleared.');return;}
  if(s.mapStatus===0||s.mapStatus===undefined){this.unavailable('This game process has no readable map-handoff state.');return;}
  if(typeof s.mapStatus==='number'&&FAILURE[s.mapStatus]){this.streak=0;this.status={...this.status,state:'failed',currentMap:normalise(s.currentMap),message:FAILURE[s.mapStatus]+' Select the map manually before starting, or recreate the lobby.'};return;}
  // The state header belongs to Steam; native LAN hosting can leave it at 0.
  if(s.kind!=='sample'||s.readOK!==true||s.visible!==true||s.isHost!==true||s.mapReadOK!==true||normalise(s.requestedMap)!==this.requested){this.unavailable();return;}
  const current=normalise(s.currentMap);if(!current){this.unavailable();return;}
  const now=this.now();if(now-this.lastAt>5000)this.streak=0;this.lastAt=now;
  if(s.mapStatus===1||s.mapStatus===2){this.streak=0;this.status={...this.status,state:'waiting',currentMap:current,message:'Waiting for the game’s map-selection attempt to finish.'};return;}
  if(s.mapStatus!==3&&s.mapStatus!==4){this.unavailable();return;}
  if(current!==this.requested){this.streak=0;this.status={...this.status,state:'changed',currentMap:current,message:'SupCom 2 currently has a different map selected. Automatic selection will not override later map changes.'};return;}
  if(now>this.lastSample)this.streak++;this.lastSample=now;
  this.status={...this.status,state:this.streak>=2?'confirmed':'waiting',currentMap:current,message:this.streak>=2?'Native lobby readback matches the requested map. Confirm its name in SupCom 2 before starting.':'First matching native map readback received; waiting for confirmation.'};
 }
 get():MapHandoffStatus{
  if(this.status.state==='confirmed'&&this.now()-this.lastAt>5000)this.unavailable('Map readback expired. Confirm the current map inside SupCom 2.');
  return {...this.status};
 }
}
