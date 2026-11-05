import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { COLOURS, FACTIONS, MAPS, PROTOCOL, STEAM_LINK_TTL_MS, AUTO_LINK_TTL_MS, NATIVE_HOST_TTL_MS, isSteamLobbyId, type RoomMap, type GameProfile, type Player, type Room, type Snapshot, type MatchSummary, type BattleLobbyInfo, type BrowserPlayer } from '../shared/model';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (message: string, status = 400): never => { throw new ApiError(status, message); };
export function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f\x7f]/.test(value)) return fail(`${label} must contain 1–${max} printable characters.`);
  return value.trim();
}
function profile(value: unknown): GameProfile | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return fail('Invalid game fingerprint.');
  const p = value as Record<string, unknown>;
  if (p.verification !== 'exe-only' || typeof p.exeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(p.exeSha256)) return fail('Invalid game fingerprint.');
  return { verification: 'exe-only', exeSha256: p.exeSha256 };
}
export function roomMap(value: unknown): RoomMap | null {
  if (value === undefined || value === null) return null;
  const m=value as Partial<RoomMap>;
  if(typeof m.id!=='string'||m.id.split('/').some(x=>x==='.'||x==='..')||!/^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/i.test(m.id)||m.id.length>240||typeof m.metadataHash!=='string'||!/^[a-f0-9]{64}$/.test(m.metadataHash))return fail('Invalid installed map metadata.');
  if(m.players!==null&&(!Number.isInteger(m.players)||m.players!<1||m.players!>16))return fail('Invalid map player count.');
  let starts:RoomMap['starts'];
  if(m.starts!==undefined){const s=m.starts;if(!s||!Number.isFinite(s.width)||!Number.isFinite(s.height)||s.width<=0||s.height<=0||s.width>65536||s.height>65536||!Array.isArray(s.points)||s.points.length!==m.players||new Set(s.points.map(p=>p?.slot)).size!==s.points.length||s.points.some(p=>!p||!Number.isInteger(p.slot)||p.slot<0||p.slot>=m.players!||!Number.isFinite(p.x)||!Number.isFinite(p.z)||p.x<0||p.z<0||p.x>s.width||p.z>s.height))return fail('Invalid map start positions.');starts={width:s.width,height:s.height,points:s.points.map(({slot,x,z})=>({slot,x,z}))};}
  if(m.spawnTeams!==undefined&&(!starts||!Array.isArray(m.spawnTeams)||m.spawnTeams.length!==m.players||m.spawnTeams.some(n=>!Number.isInteger(n)||n<0||n>8)))return fail('Invalid team spawn layout.');
  return {id:m.id,name:text(m.name,'Map name',100),players:m.players??null,metadataHash:m.metadataHash,...(starts?{starts}:{}),...(m.spawnTeams?{spawnTeams:[...m.spawnTeams]}:{})};
}
function capacity(value:unknown, fallback=8):number {
 const n=value??fallback;if(!Number.isInteger(n)||(n as number)<2||(n as number)>8)return fail('This build supports 2–8 players.');return n as number;
}
function battleInfo(value:unknown):BattleLobbyInfo {
 if(!value||typeof value!=='object'||Array.isArray(value))return fail('Invalid battle listing.');
 const info=value as BattleLobbyInfo,result:BattleLobbyInfo={};
 if(info.mapId!==undefined){
  if(typeof info.mapId!=='string'||info.mapId.length>240||!/^\/maps\/[\w .-]+\/[\w .-]+_scenario\.lua$/i.test(info.mapId)||info.mapId.split('/').some(x=>x==='.'||x==='..'))return fail('Invalid observed map.');
  result.mapId=info.mapId.toLowerCase();
 }
 if(info.map!==undefined){result.map=roomMap(info.map);if(result.map&&result.map.id.toLowerCase()!==result.mapId)return fail('Observed battle map metadata does not match its scenario.');}
 if(info.players!==undefined){
  if(!Array.isArray(info.players)||!info.players.length||info.players.length>32)return fail('Invalid observed players.');
  result.players=info.players.map(p=>{
   if(!p||!Number.isInteger(p.team)||(p.team!==-1&&(p.team<1||p.team>8))||typeof p.ai!=='boolean'||typeof p.observer!=='boolean')return fail('Invalid observed player.');
   return {name:text(p.name,'Observed player',64),team:p.team,ai:p.ai,observer:p.observer};
  });
  if(result.players.filter(p=>!p.observer).length>8)return fail('Too many active players.');
 }
 return result;
}
interface Session { token: string; player: Player; roomId: string | null; seen: number }
export class Lobby {
  private sessions = new Map<string, Session>();
  private renamingAccounts=new Set<string>();
  setRenaming(id:string,active:boolean){if(active)this.renamingAccounts.add(id);else this.renamingAccounts.delete(id);}
  private rooms = new Map<string, Room>();
  private battleListings=new Map<string,MatchSummary>();
  private mapUpdates=new Map<string,{lease:string;sequence:number}>();
  private clearObservedMap(room:Room){delete room.observedMap;this.mapUpdates.delete(room.id);}
  private passwords=new Map<string,{salt:string;hash:Buffer}>();
  setPreferred(token:string,value:{faction?:unknown;colour?:unknown}){const s=this.session(token);if(s.roomId)return fail('Leave your current lobby first.',409);if(value.faction!==undefined&&!FACTIONS.includes(value.faction as never)||value.colour!==undefined&&!COLOURS.includes(value.colour as never))return fail('Choose a valid faction and colour.');if(value.faction!==undefined)s.player.faction=value.faction as Player['faction'];if(value.colour!==undefined)s.player.colour=value.colour as Player['colour'];}
  assignStarts(id:string,assignments:{id:string;slot:number}[]){const room=this.rooms.get(id);if(!room||!room.map?.spawnTeams||assignments.length!==room.players.length||new Set(assignments.map(a=>a.slot)).size!==assignments.length)throw new ApiError(409,'Invalid matchmaking starts.');for(const p of room.players){const a=assignments.find(a=>a.id===p.id);if(!a||room.map.spawnTeams[a.slot]!==p.team)throw new ApiError(409,'Spawn does not match the assigned team.');}for(const a of assignments)room.players.find(p=>p.id===a.id)!.startPosition=a.slot;}
  closeRoom(id:string){this.rooms.delete(id);this.battleListings.delete(id);this.mapUpdates.delete(id);this.passwords.delete(id);for(const s of this.sessions.values())if(s.roomId===id)s.roomId=null;}
  constructor(private now = () => Date.now(), private ttl = 90_000) {}
  connect(name: unknown, protocol: unknown, identity?: string) {
    this.sweep();
    if (protocol !== PROTOCOL) return fail('Client/server protocol mismatch. Use the same client version.', 409);
    if (this.sessions.size >= 200) return fail('Test server is full.', 503);
    const token = randomBytes(32).toString('hex');
    const player: Player = { id: identity ?? randomUUID(), name: text(name, 'Name', 24), faction: 'UEF', team: 1, colour: 'Blue', ready: false, profile: null };
    this.sessions.set(token, { token, player, roomId: null, seen: this.now() });
    return { token, playerId: player.id, protocol: PROTOCOL };
  }
  private session(token: string) {
    this.sweep();
    const session = this.sessions.get(token);
    if (!session) return fail('Session expired. Connect again.', 401);
    if(this.renamingAccounts.has(session.player.id))throw new ApiError(409,'Account name is being updated. Try again shortly.');
    session.seen = this.now();
    return session;
  }
  private room(session: Session): Room {
    const room = session.roomId ? this.rooms.get(session.roomId) : null;
    return room ?? fail('Join a room first.', 409);
  }
  private invalidate(room: Room) {
    room.revision++;
    room.manifest = null;
    for (const player of room.players) player.ready = false;
  }
  markMatchmade(id:string,matchId:string){const room=this.rooms.get(id);if(!room)throw new ApiError(409,'Match room disappeared.');room.managed=true;room.matchmakingId=matchId;room.rankedRequested=true;}
  assertRenameAllowed(id:string,name:string){
    for(const s of this.sessions.values()){
      if(s.player.id===id&&s.roomId)throw new ApiError(409,'Leave the lobby or finish the game before renaming.');
      if(s.player.id!==id&&s.player.name.toLowerCase()===name.toLowerCase())throw new ApiError(409,'That name is currently in use.');
    }
  }
  renameAccount(id:string,name:string){for(const s of this.sessions.values())if(s.player.id===id)s.player.name=name;}
  presence(){this.sweep();return [...this.sessions.values()].map(s=>({id:s.player.id,name:s.player.name,roomId:s.roomId}));}
  hosts(){return [...new Set([...this.rooms.values()].map(r=>r.hostId))];}
  publicGames(approved?:Set<string>){
    this.sweep();
    const visible=(r:{friendsOnly?:boolean;hostId?:string})=>!r.friendsOnly&&(!approved||!!r.hostId&&approved.has(r.hostId));
    const rooms=[...this.rooms.values()].filter(r=>visible(r)&&r.nativeHost?.phase!=='battle-observed'&&(!r.managed||!!r.steamLink||r.nativeHost?.phase==='lobby-observed')).slice(0,200).map(r=>({id:r.id,name:r.name,host:r.players.find(p=>p.id===r.hostId)?.name??'',map:r.observedMap?.name??r.mapLabel,mode:r.gameType??'Custom',players:r.players.map(p=>({name:p.name,team:p.team,ai:false})),count:r.players.length,capacity:r.capacity,passwordProtected:!!r.passwordProtected}));
    const matches=[...this.battleListings.values()].filter(visible).slice(0,200).map(r=>({id:r.id,name:r.name,host:r.host,map:r.map?.name??r.mapLabel,mode:r.gameType??'Custom',players:r.players.filter(p=>!p.observer).map(p=>({name:p.name,team:p.team,ai:!!p.ai})),elapsedSeconds:Math.max(0,Math.floor((this.now()-Date.parse(r.observedStartedAt))/1000))}));
    return {rooms,matches};
  }
  removeHostedRooms(accountId:string){for(const [id,r]of this.rooms)if(r.hostId===accountId){for(const s of this.sessions.values())if(s.roomId===id){s.roomId=null;s.player.ready=false;}this.closeRoom(id);}}
  snapshot(token: string): Snapshot {
    const s = this.session(token);
    // Copy at the boundary so callers cannot mutate internal state.
    return structuredClone({ protocol: PROTOCOL, playerId: s.player.id,
      rooms: [...this.rooms.values()].filter(r=>r.nativeHost?.phase!=='battle-observed').filter(r=>!r.managed||!!r.steamLink||r.nativeHost?.phase==='lobby-observed').map(r => ({hostId:r.hostId,researchId:r.researchId,gameType:r.gameType,friendsOnly:r.friendsOnly,passwordProtected:r.passwordProtected, id: r.id, name: r.name, host: r.players.find(p => p.id === r.hostId)!.name, mapLabel:r.observedMap?.name??r.mapLabel,mapObservedAt:r.observedMap?.observedAt, count: r.players.length, capacity: r.capacity, prepared: !!r.manifest, live: !!r.steamLink, nativePhase: r.nativeHost?.phase ?? null, map:r.observedMap?r.observedMap.map:r.map, players: r.players.map(p=>({name:p.name,team:p.team})) })),
      matches:[...this.battleListings.values()].map(m=>({...m,elapsedSeconds:Math.max(0,Math.floor((this.now()-Date.parse(m.observedStartedAt))/1000))})),
      room: s.roomId ? this.rooms.get(s.roomId)! : null });
  }
  pinResearch(token:string,id:string|undefined){
    if(id!==undefined&&!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid research ruleset ID.');
    const r=this.room(this.session(token));if(r.hostId!==this.session(token).player.id||r.players.length!==1||r.revision!==1)throw new ApiError(409,'Only a new hosted room can pin research.');
    r.researchId=id;
  }
  act(token: string, action: string, body: Record<string, unknown>): Snapshot {
    const s = this.session(token);
    if(s.roomId&&this.rooms.get(s.roomId)?.matchmakingId&&['player','settings','ready','prepare','lobby-options','steam-publish','steam-auto','steam-clear'].includes(action))return fail('Ladder match assignments and settings are locked.',409);
    if(s.roomId&&this.rooms.get(s.roomId)?.nativeHost?.phase==='battle-observed'&&['player','settings','ready','prepare','lobby-options','steam-publish','steam-auto','steam-clear'].includes(action))return fail('This battle has already started.',409);
    if (action === 'create') {
      if (s.roomId) return fail('Leave your current room first.', 409);
      const name = text(body.name, 'Room name', 48);
      const id = randomUUID();
      const selectedMap=roomMap(body.map), slots=capacity(body.capacity);
      if(selectedMap?.players&&slots>selectedMap.players)return fail('Selected capacity exceeds this map’s known start positions.');
      s.player.ready = false; s.player.team = 1;
      delete s.player.startPosition;
      if(body.gameType!==undefined&&body.gameType!=='vanilla-1.260-iwbp')return fail('This game version is not available.');
      if(body.password!==undefined&&(typeof body.password!=='string'||body.password.length>64))return fail('Lobby password must be at most 64 characters.');
      if(body.password){const salt=randomBytes(16).toString('hex');this.passwords.set(id,{salt,hash:scryptSync(body.password as string,salt,32)});}
      const room: Room = {rankedRequested:false,managed:body.managed===true,pendingUntil:this.now()+120000,gameType:'vanilla-1.260-iwbp',friendsOnly:body.friendsOnly===true,passwordProtected:!!body.password, id, name, hostId: s.player.id, mapLabel: selectedMap?.name ?? 'Choose inside SupCom 2', map: selectedMap, capacity: slots, revision: 1, players: [s.player], manifest: null, steamLink: null, nativeHost: null, chat: [] };
      this.rooms.set(id, room); s.roomId = id;
    } else if (action === 'join') {
      if (s.roomId) return fail('Leave your current room first.', 409);
      const room = this.rooms.get(text(body.roomId, 'Room ID', 40));
      if (!room) return fail('Room no longer exists.', 404);
      if(room.matchmakingId)return fail('Only assigned ladder players can enter this room.',403);
      if(room.nativeHost?.phase==='battle-observed')return fail('This battle has already started.',409);
      const secret=this.passwords.get(room.id);if(secret&&(typeof body.password!=='string'||body.password.length>64||!timingSafeEqual(scryptSync(body.password,secret.salt,32),secret.hash)))return fail('Incorrect lobby password.',403);
      if(room.managed&&!room.steamLink&&room.nativeHost?.phase!=='lobby-observed')return fail('The host lobby is not ready.',409);
      if (room.players.length >= room.capacity) return fail('Room is full.', 409);
      if(room.players.some(p=>p.colour===s.player.colour))s.player.colour = COLOURS.find(c => !room.players.some(p => p.colour === c))!;
      delete s.player.startPosition;
      s.player.team = room.players.length % 2 + 1;
      room.players.push(s.player); s.roomId = room.id; this.invalidate(room);
    } else if(action==='game-closed'){if(s.roomId===body.roomId){const r=this.room(s);if(r.hostId===s.player.id)this.closeRoom(r.id);else this.leave(s);}
    } else if (action === 'leave') {
      this.leave(s);
    } else if (action === 'profile') {
      const next = profile(body.profile);
      if (JSON.stringify(next) !== JSON.stringify(s.player.profile)) {
        s.player.profile = next;
        if (s.roomId) this.invalidate(this.room(s));
      }
    } else if(action==='lobby-map'){
      const r=this.room(s);if(r.hostId!==s.player.id)return fail('Only the room host can publish its game map.',403);
      if(r.nativeHost?.phase==='battle-observed')return fail('This battle has already started.',409);
      const lease=r.nativeHost?.phase==='lobby-observed'?'native:'+r.nativeHost.id:r.steamLink?'steam:'+r.steamLink.id:null;
      if(!lease||body.leaseId!==(r.nativeHost?.id??r.steamLink?.id))return fail('The host lobby changed or expired.',409);
      if(!Number.isSafeInteger(body.sequence)||(body.sequence as number)<1||(body.sequence as number)>0x7fffffff)return fail('Invalid map observation sequence.');
      if(typeof body.mapId!=='string')return fail('Invalid observed map.');
      const id=battleInfo({mapId:body.mapId}).mapId!,map=roomMap(body.map);
      if(map&&map.id.toLowerCase()!==id)return fail('Observed map metadata does not match its scenario.');
      const last=this.mapUpdates.get(r.id);if(last?.lease===lease&&(body.sequence as number)<=last.sequence)return this.snapshot(token);
      this.mapUpdates.set(r.id,{lease,sequence:body.sequence as number});
      if(r.observedMap?.id!==id||JSON.stringify(r.observedMap.map)!==JSON.stringify(map)){
       r.observedMap={id,name:map?.name??id,map,observedAt:new Date(this.now()).toISOString()};if(map?.players&&!r.matchmakingId)r.capacity=Math.min(8,map.players);this.invalidate(r);
      }
    } else if (action === 'player') {
      const r = this.room(s);
      if (!FACTIONS.includes(body.faction as never)) return fail('Unknown faction.');
      if (!Number.isInteger(body.team) || (body.team as number) < 1 || (body.team as number) > 8) return fail('Team must be 1–8.');
      if (!COLOURS.includes(body.colour as never)) return fail('Unknown colour.');
      if (r.players.some(p => p.id !== s.player.id && p.colour === body.colour)) return fail('That colour is already taken.', 409);
      if (s.player.faction !== body.faction || s.player.team !== body.team || s.player.colour !== body.colour) {
        Object.assign(s.player, { faction: body.faction, team: body.team, colour: body.colour });
        this.invalidate(r);
      }
    } else if(action==='lobby-options'){
      const r=this.room(s);if(r.hostId!==s.player.id)return fail('Only the host can change battle settings.',403);if(body.roomId!==r.id)return fail('The lobby changed.',409);if(typeof body.rankedRequested!=='boolean')return fail('Ranked must be on or off.');if(r.rankedRequested!==body.rankedRequested){r.rankedRequested=body.rankedRequested;this.invalidate(r);}
    } else if (action === 'settings') {
      const r = this.room(s);
      if (r.hostId !== s.player.id) return fail('Only the host can change the map.', 403);
      const selectedMap=body.map===undefined?r.map:roomMap(body.map);
      const slots=capacity(body.capacity,r.capacity);
      if(slots<r.players.length)return fail('Capacity cannot be lower than the current player count.',409);
      if(selectedMap?.players&&slots>selectedMap.players)return fail('Capacity exceeds this map’s known start positions.');
      const label=selectedMap?.name??body.mapLabel;
      if(!selectedMap&&label!=='Choose inside SupCom 2'&&!MAPS.includes(label as never))return fail('Unknown map label.');
      if(r.mapLabel!==label||JSON.stringify(r.map)!==JSON.stringify(selectedMap)||r.capacity!==slots){r.mapLabel=label as string;r.map=selectedMap;r.capacity=slots;r.steamLink=null;r.nativeHost=null;this.clearObservedMap(r);this.invalidate(r);}
    } else if (action === 'ready') {
      const r = this.room(s);
      if (typeof body.ready !== 'boolean') return fail('Ready must be true or false.');
      r.manifest = null; r.revision++; s.player.ready = body.ready;
    } else if (action === 'chat') {
      const r = this.room(s);
      r.chat.push({ id: randomUUID(), name: s.player.name, text: text(body.text, 'Message', 300), at: new Date(this.now()).toISOString() });
      r.chat = r.chat.slice(-80);
    } else if (action === 'native-start') {
      const r=this.room(s);
      if(r.hostId!==s.player.id)return fail('Only the room host can start a native test.',403);
      if(body.expectedRunId!==(r.nativeHost?.id??null))return fail('The native host run changed. Refresh the room.',409);
      if(r.nativeHost)return fail('A native host test is already active.',409);
      this.clearObservedMap(r);
      r.steamLink=null;r.manifest=null;
      r.nativeHost={id:randomUUID(),transport:'native-udp-test',phase:'starting',startedAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+NATIVE_HOST_TTL_MS).toISOString(),joinable:false};
    } else if (action === 'native-pulse' || action === 'native-stop') {
      const r=this.room(s);
      if(r.hostId!==s.player.id)return fail('Only the room host can update the native test.',403);
      if(!r.nativeHost||body.runId!==r.nativeHost.id)return fail('The native host run expired or changed.',409);
      if(action==='native-stop'){if(r.nativeHost.phase==='battle-observed')this.closeRoom(r.id);else{r.nativeHost=null;this.clearObservedMap(r);}}
      else {
        if(!['starting','listener-observed','lobby-observed','battle-observed'].includes(body.phase as string))return fail('Invalid native test phase.');
        const listing=body.listing===undefined?{}:battleInfo(body.listing);
        if(body.phase==='battle-observed'&&r.nativeHost.phase!=='battle-observed'){
         const mapId=listing.mapId??r.observedMap?.id??r.map?.id??null,known=listing.map!==undefined?listing.map:r.observedMap?r.observedMap.map:r.map,matchingMap=!!known&&mapId?.toLowerCase()===known.id.toLowerCase(),players:BrowserPlayer[]=listing.players??r.players.map(p=>({name:p.name,team:p.team}));
         this.battleListings.set(r.id,{id:r.id,name:r.name,hostId:r.hostId,host:r.players.find(p=>p.id===r.hostId)!.name,gameType:r.gameType,friendsOnly:r.friendsOnly,passwordProtected:r.passwordProtected,
          map:matchingMap?known:null,mapLabel:matchingMap?known!.name:mapId??r.mapLabel,mapId,
          players,count:players.filter(p=>!p.observer).length,capacity:r.capacity,prepared:false,live:false,nativePhase:'battle-observed',
          runId:r.nativeHost.id,observedStartedAt:new Date(this.now()).toISOString(),elapsedSeconds:0,mode:r.matchmakingId?'matchmaking':'custom',mapSource:listing.mapId||r.observedMap?'game-lobby':'listing',rosterSource:listing.players?'game-lobby':'listing'});
        }
        if(r.nativeHost.phase!=='battle-observed')r.nativeHost.phase=body.phase as typeof r.nativeHost.phase;
        r.nativeHost.expiresAt=new Date(this.now()+NATIVE_HOST_TTL_MS).toISOString();
      }
    } else if (action === 'native-ticket') {
      this.room(s);
      return fail('Native guest connection is not implemented in this test build. Room membership and an observed host listener do not grant in-game admission.',409);
    } else if (action === 'steam-publish'  || action === 'steam-auto') {
      const r = this.room(s);
      if (r.hostId !== s.player.id) return fail('Only the room host can publish a Steam lobby.', 403);
      if(r.nativeHost)return fail('Stop the native test before publishing a Steam lobby.',409);
      if(r.passwordProtected||r.friendsOnly)return fail('Private lobbies require the independent Reforged connection.',409);
      if (!isSteamLobbyId(body.lobbyId)) return fail('Use a decimal Steam lobby ID up to 64 bits.');
      const automatic = action === 'steam-auto';
      if (!automatic && body.confirmCurrent !== true) return fail('Confirm that this is your current open game lobby.');
      if (body.expectedLinkId !== (r.steamLink?.id ?? null)) return fail('Steam lobby link changed. Review it and try again.', 409);
      const renewing = automatic && r.steamLink?.source === 'automatic' && r.steamLink.lobbyId === body.lobbyId;
      if(!renewing)this.clearObservedMap(r);
      r.steamLink = { id: renewing ? r.steamLink!.id : randomUUID(), lobbyId: body.lobbyId, publishedBy: s.player.id,
        publishedAt: renewing ? r.steamLink!.publishedAt : new Date(this.now()).toISOString(),
        expiresAt: new Date(this.now() + (automatic ? AUTO_LINK_TTL_MS : STEAM_LINK_TTL_MS)).toISOString(),
        source: automatic ? 'automatic' : 'manual' };
    } else if (action === 'steam-clear') {
      const r = this.room(s);
      if (r.hostId !== s.player.id) return fail('Only the room host can clear the Steam lobby.', 403);
      if (body.linkId !== (r.steamLink?.id ?? null)) return fail('Steam lobby link changed. Review it and try again.', 409);
      r.steamLink = null;
      this.clearObservedMap(r);
    } else if (action === 'steam-ticket') {
      const r = this.room(s);
      if (!r.steamLink || body.linkId !== r.steamLink.id) return fail('Steam lobby link expired or changed. Ask the host to publish the current lobby.', 409);
      // Explicit guest click revalidates the exact link before local process launch.
      // This is not Steam ownership/membership verification or a match manifest.
    } else if (action === 'prepare') {
      const r = this.room(s);
      if (r.hostId !== s.player.id) return fail('Only the host can prepare a match.', 403);
      if (body.revision !== r.revision) return fail('Room changed. Review settings and try again.', 409);
      if (r.players.length < 2) return fail('At least two players are required.', 409);
      if (!r.players.every(p => p.ready)) return fail('Every player must be ready.', 409);
      if (new Set(r.players.map(p => p.team)).size < 2) return fail('Choose at least two opposing teams.', 409);
      const profiles = r.players.map(p => p.profile);
      const present = profiles.filter(p => p !== null);
      if (present.length && present.length !== profiles.length) return fail('Fingerprint all game executables, or clear all fingerprints for a browser-only rehearsal.', 409);
      if (new Set(present.map(p => p!.exeSha256)).size > 1) return fail('Executable fingerprints differ. Use matching installations.', 409);
      r.manifest = { protocol: PROTOCOL, matchId: randomUUID(), roomId: r.id, roomName: r.name, createdAt: new Date(this.now()).toISOString(), mapLabel: r.mapLabel,
        ruleset: 'stock-unverified', adapter: 'not-implemented', players: structuredClone(r.players),
        warning: 'Configuration rehearsal only. This configuration JSON does not create a SupCom 2 session. EXE equality does not verify game scripts, maps, DLC or mods.' };
    } else return fail('Unknown action.', 404);
    return this.snapshot(token);
  }
  private leave(s: Session) {
    if (!s.roomId) return;
    const r = this.rooms.get(s.roomId);
    s.roomId = null; s.player.ready = false;
    if (!r) return;
    r.players = r.players.filter(p => p.id !== s.player.id);
    if (!r.players.length) this.closeRoom(r.id);
    else if((r.managed||r.nativeHost?.phase==='battle-observed')&&r.hostId===s.player.id)this.closeRoom(r.id);
    else { if (r.hostId === s.player.id) { r.hostId = r.players[0].id; r.steamLink = null;r.nativeHost=null;this.clearObservedMap(r); } this.invalidate(r); }
  }
  disconnect(token: string) { const s = this.sessions.get(token); if (s) this.leave(s); this.sessions.delete(token); }
  sweep() {
    for(const room of this.rooms.values())if(room.nativeHost?.phase==='battle-observed'&&Date.parse(room.nativeHost.expiresAt)<=this.now())this.closeRoom(room.id);
    for(const room of this.rooms.values())if(room.managed&&(!room.nativeHost&&!room.steamLink&&this.now()>(room.pendingUntil??0)||room.nativeHost&&Date.parse(room.nativeHost.expiresAt)<=this.now()||room.steamLink&&Date.parse(room.steamLink.expiresAt)<=this.now()))this.closeRoom(room.id);
    for (const room of this.rooms.values()) if (room.nativeHost && Date.parse(room.nativeHost.expiresAt)<=this.now()){room.nativeHost=null;this.clearObservedMap(room);}
    for (const room of this.rooms.values()) if (room.steamLink && Date.parse(room.steamLink.expiresAt) <= this.now()){room.steamLink = null;this.clearObservedMap(room);}
    for (const [token, s] of this.sessions) if (this.now() - s.seen > this.ttl) this.disconnect(token);
  }
}
