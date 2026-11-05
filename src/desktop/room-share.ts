import { PROTOCOL, type HostRoomRequest, type LiveLobby, type Snapshot, type SteamLobbyLink } from '../shared/model';
import { LIVE_MAX_AGE_MS, isLiveSteamLobbyId } from './live-lobby';
export function validateHostRoom(input: unknown): HostRoomRequest {
  const r = input as Partial<HostRoomRequest> | null;
  if (!r || typeof r.server !== 'string' || typeof r.token !== 'string' || typeof r.roomId !== 'string') throw new Error('Join a community room before hosting.');
  const u = new URL(r.server);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
    throw new Error('Invalid room server address.');
  if (!/^[a-f0-9]{64}$/.test(r.token) || !/^[a-f0-9-]{36}$/i.test(r.roomId)) throw new Error('Invalid room session.');
  if(r.applyMap!==undefined&&typeof r.applyMap!=='boolean')throw new Error('Invalid map handoff option.');
  return {server:u.origin,token:r.token,roomId:r.roomId,...(r.applyMap===true?{applyMap:true}:{})};
}
export type RoomApi = (context: HostRoomRequest, action: string, body?: object) => Promise<Snapshot>;
export class RoomRequestError extends Error{constructor(message:string,readonly status:number){super(message);this.name='RoomRequestError';}}
export function transientRoomError(error:unknown){return error instanceof RoomRequestError?error.status===429||error.status>=500:error instanceof TypeError||error instanceof SyntaxError||error instanceof Error&&['TimeoutError','AbortError'].includes(error.name);}
export const roomApi: RoomApi = async (c,action,body) => {
  const response = await fetch(`${c.server}/api/${action}`,{ method:body===undefined?'GET':'POST',
    headers:{Authorization:`Bearer ${c.token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(3500) });
  const result = await response.json();
  if (!response.ok) throw new RoomRequestError(result.error ?? 'Room server request failed.',response.status);
  return result as Snapshot;
};
export function ownsRoom(snapshot: Snapshot,c: HostRoomRequest,playerId?: string): boolean {
  return snapshot.protocol===PROTOCOL && snapshot.room?.id===c.roomId && snapshot.room.hostId===snapshot.playerId && (!playerId || playerId===snapshot.playerId);
}
export class HostRoomShare {
  private context: HostRoomRequest | null = null;
  private playerId = '';
  private owned: SteamLobbyLink | null = null;
  private epoch = 0;
  private working = false;
  private timer: NodeJS.Timeout | null = null;
  private message = 'Automatic game sharing has not started.';
  constructor(private readonly live:()=>LiveLobby,private readonly request: RoomApi = roomApi,private readonly now = Date.now,private readonly observed:(c:HostRoomRequest,leaseId:string,state:Snapshot)=>void=()=>{}) {}
  async begin(input: unknown, startTimer = true): Promise<Snapshot> {
    if (this.context) throw new Error('A host-sharing session is already active.');
    const c = validateHostRoom(input), snapshot = await this.request(c,'state');
    if (!ownsRoom(snapshot,c)) throw new Error('Only the current community-room host can start this game lobby.');
    if (snapshot.room!.steamLink) await this.request(c,'steam-clear',{linkId:snapshot.room!.steamLink.id});
    this.context=c; this.playerId=snapshot.playerId;this.owned=null;this.epoch++;
    this.message='Waiting for a live host lobby ID; sharing starts automatically after detection.';
    if (startTimer) { this.timer=setInterval(()=>void this.tick(),2000);this.timer.unref(); }
    return snapshot;
  }
  status() { return {enabled:!!this.context,lobbyId:this.owned?.lobbyId??null,message:this.message}; }
  private freshHost(): string | null {
    const l=this.live();return l.status==='active' && l.role==='host' && this.now()-l.observedAt<=LIVE_MAX_AGE_MS && isLiveSteamLobbyId(l.lobbyId)?l.lobbyId:null;
  }
  private async clear(c:HostRoomRequest,link:SteamLobbyLink,playerId=this.playerId):Promise<void> {
    try {const s=await this.request(c,'state');if(ownsRoom(s,c,playerId)&&s.room!.steamLink?.id===link.id)await this.request(c,'steam-clear',{linkId:link.id});}catch{/* Short server lease handles an unreachable server. */}
  }
  async tick(): Promise<void> {
    if(!this.context || this.working)return;
    this.working=true;const c=this.context,epoch=this.epoch,playerId=this.playerId;
    try {
      const id=this.freshHost();
      if(!id){const old=this.owned;this.owned=null;if(old)await this.clear(c,old);this.message='No live host lobby observed; guests have no automatic join link.';return;}
      const state=await this.request(c,'state');
      if(epoch!==this.epoch)return;
      if(!ownsRoom(state,c,this.playerId)){await this.stop('Room membership or host changed; automatic sharing stopped.');return;}
      const current=state.room!.steamLink;
      if(this.owned && current?.id!==this.owned.id && !(current===null && Date.parse(this.owned.expiresAt)<=this.now())) {
        await this.stop('The shared link was cleared or replaced; automatic sharing stopped.');return;
      }
      if(!this.owned && current){await this.stop('Another lobby link is published; automatic sharing stopped.');return;}
      if(this.freshHost()!==id || epoch!==this.epoch)return;
      const next=await this.request(c,'steam-auto',{lobbyId:id,expectedLinkId:current?.id??null});
      const link=next.room?.steamLink;
      if(!link || !ownsRoom(next,c,this.playerId) || link.lobbyId!==id || link.source!=='automatic')throw new Error('Server did not confirm the expected automatic lobby link.');
      if(epoch!==this.epoch || this.freshHost()!==id){await this.clear(c,link,playerId);return;}
      this.owned={...link};this.message=`Sharing current game lobby ${id}. The join link expires if observations or heartbeats stop.`;
      try{this.observed(c,link.id,next);}catch{/* Map display updates cannot interrupt link sharing. */}
    }catch{this.message='Room server unavailable or changed. Automatic links expire without renewal.';}
    finally{this.working=false;}
  }
  async stop(message='Automatic lobby sharing stopped.'):Promise<void>{
    if(this.timer)clearInterval(this.timer);this.timer=null;
    const c=this.context,old=this.owned,playerId=this.playerId;this.context=null;this.owned=null;this.epoch++;this.message=message;
    if(c&&old)await this.clear(c,old,playerId);
  }
}

/** Read the display title only after checking the authenticated room and current Steam link. */
export async function joinedRoomTitle(input:unknown,lobbyId:string,request:RoomApi=roomApi):Promise<string>{
 const c=validateHostRoom(input),s=await request(c,'state');if(s.protocol!==PROTOCOL||s.room?.id!==c.roomId||!s.room.players.some(p=>p.id===s.playerId)||s.room.steamLink?.lobbyId!==lobbyId||Date.parse(s.room.steamLink.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(s.room.steamLink.expiresAt)))throw Error('The current Reforged room no longer matches this game lobby.');return s.room.name;
}
