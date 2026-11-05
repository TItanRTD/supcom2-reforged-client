// Protocol version belongs to this launcher, not to the SC2 executable.
export const PROTOCOL = 9;
export const CLIENT_VERSION = '0.33.6';
export const NATIVE_HOST_TTL_MS = 20_000;
export const AUTO_LINK_TTL_MS = 12_000;
export const STEAM_LINK_TTL_MS = 15 * 60 * 1000;
export function isSteamLobbyId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}
export const FACTIONS = ['UEF', 'Cybran', 'Illuminate'] as const;
export type Faction = typeof FACTIONS[number];
// Retail strategic icon RGB values (GameColors.FactionColors[].icon), not unit paint.
// Stable native IDs: retain retail 0–9; Reforged adds 10–27; retired Light Pink/Light Purple slots become Sky Blue/Lime Green.
export const COLOUR_DEFINITIONS = [
 {id:'blue',name:'Blue',rgb:'#146fcd',nativeId:0},
 {id:'green',name:'Green',rgb:'#1bdd1b',nativeId:1},
 {id:'red',name:'Red',rgb:'#ff0000',nativeId:2},
 {id:'purple',name:'Purple',rgb:'#b061fa',nativeId:3},
 {id:'tan',name:'Tan',label:'Brown',rgb:'#a26b25',nativeId:4},
 {id:'gray',name:'Gray',label:'White',rgb:'#deddd1',nativeId:5},
 {id:'olive',name:'Olive',label:'Olive Green',rgb:'#92b220',nativeId:6},
 {id:'cyan',name:'Cyan',label:'Teal Blue',rgb:'#00ffcc',nativeId:7},
 {id:'yellow',name:'Yellow',rgb:'#ffe600',nativeId:8},
 {id:'orange',name:'Orange',rgb:'#ff8000',nativeId:9},
 {id:'pink',name:'Pink',rgb:'#f0429d',nativeId:10},
 {id:'lavender',name:'Lavender',rgb:'#b8a4e3',nativeId:11},
 {id:'maroon',name:'Maroon',rgb:'#800000',nativeId:12},
 {id:'dark-yellow',name:'Dark Yellow',rgb:'#c2a000',nativeId:13},
 {id:'navy-blue',name:'Navy Blue',rgb:'#173568',nativeId:14},
 {id:'gun-metal-gray',name:'Gun Metal Gray',rgb:'#586d78',nativeId:15},
 {id:'sky-blue',name:'Sky Blue',rgb:'#66c7ff',nativeId:16},
 {id:'light-gray',name:'Light Gray',rgb:'#b4bdc6',nativeId:17},
 {id:'salmon',name:'Salmon',rgb:'#fa8072',nativeId:18},
 {id:'lime-green',name:'Lime Green',rgb:'#a6f000',nativeId:19},
 {id:'mint-green',name:'Mint Green',rgb:'#7ff0bc',nativeId:20},
 {id:'light-tan',name:'Light Tan',label:'Tan',rgb:'#d2b48c',nativeId:21},
 {id:'crimson-red',name:'Crimson Red',rgb:'#dc143c',nativeId:22},
 {id:'indigo',name:'Indigo',rgb:'#5533bb',nativeId:23},
 {id:'charcoal',name:'Charcoal',rgb:'#4a4d54',nativeId:24},
 {id:'tangerine',name:'Tangerine',rgb:'#ffb600',nativeId:25},
 {id:'magenta',name:'Magenta',rgb:'#e600cc',nativeId:26},
 {id:'sand',name:'Sand',rgb:'#e5ad97',nativeId:27},
 {id:'mellow-yellow',name:'Mellow Yellow',rgb:'#faff00',nativeId:28},
 {id:'forest-green',name:'Forest Green',rgb:'#2d4715',nativeId:29}
] as const;
export type Colour = typeof COLOUR_DEFINITIONS[number]['name'];
export const COLOURS:readonly Colour[] = COLOUR_DEFINITIONS.map(c=>c.name);
/** Native option keys and values, verified in the supplied lobbyOptions.lua. */
export const LADDER_RULES = {
 Victory:'demoralization',TeamSpawn:'fixed',UnitCap:'1000',NoRushOption:'Off',
 FogOfWar:'explored',GameSpeed:'normal',CheatsEnabled:'false',Observers:'Allowed',PrebuiltUnits:'Off'
} as const;
export const LADDER_TEAM_COLOURS:readonly (readonly Colour[])[] = [
 ['Blue','Sky Blue','Lavender','Purple'],['Red','Crimson Red','Orange','Yellow']
];
export const LADDER_FFA_COLOURS:readonly Colour[] = ['Blue','Red','Green','Yellow','Purple','Cyan','Orange','Gray'];
// These are lobby labels only until an adapter maps them to validated game IDs.
export const MAPS = ['Open Palms', 'Seton’s Clutch', 'Fields of Isis'] as const;
export interface GameProfile {
  largeAddressAware?:boolean;
  exeSha256: string;
  // This proves only EXE equality, not DLC/scripts/mod compatibility.
  verification: 'exe-only';
}
export interface Player {
  id: string; name: string; faction: Faction; team: number;
  colour: Colour; ready: boolean; profile: GameProfile | null; startPosition?:number;
}
export interface MatchManifest {
  protocol: number; matchId: string; roomId: string; roomName: string;
  createdAt: string; mapLabel: string; ruleset: 'stock-unverified';
  adapter: 'not-implemented'; players: Player[];
  warning: string;
}
export interface MapStarts {width:number;height:number;points:{slot:number;x:number;z:number}[]}
export interface GameMap {
  id: string; name: string; players: number | null; terrain: string; archive: string; metadataHash: string; starts?:MapStarts; spawnTeams?:number[];
}
export interface MapCatalog { maps: GameMap[]; warnings: string[]; directory: string }
export const MAP_PACKAGE_LIMIT=512*1024*1024;
export interface RepositoryMap {id:string;name:string;players:number|null}
export interface MapPackage {id:string;title:string;description:string;filename:string;uploader:string;size:number;uploadedAt:string;maps:RepositoryMap[];canDelete?:boolean;scan?:{status:'clean'|'pending'|'blocked';engine:string;at:string;message:string}}
export interface MapRepositoryPage {configured:boolean;packages:MapPackage[];total:number;page:number;pages:number;maxBytes:number}
export type RoomMap = Pick<GameMap, 'id' | 'name' | 'players' | 'metadataHash' | 'starts' | 'spawnTeams'>;
export type NativeHostPhase = 'starting' | 'listener-observed' | 'lobby-observed' | 'battle-observed';
export interface NativeHostRun {
  id:string; transport:'native-udp-test'; phase:NativeHostPhase;
  startedAt:string; expiresAt:string; joinable:false;
}
/** Display-only host readback. Never authorizes results, joining or simulation. */
export interface BrowserPlayer { name:string;team:number;ai?:boolean;observer?:boolean }
export interface BattleLobbyInfo { mapId?:string;map?:RoomMap|null;players?:BrowserPlayer[] }
export interface ObservedLobbyMap {id:string;name:string;map:RoomMap|null;observedAt:string}
export interface MatchSummary extends RoomSummary {
  runId:string;observedStartedAt:string;elapsedSeconds:number;
  mode:'custom'|'matchmaking';mapId:string|null;
  mapSource:'game-lobby'|'listing';rosterSource:'game-lobby'|'listing';
}
export interface Room {
  id: string; name: string; hostId: string; mapLabel: string;
  researchId?:string;matchmakingId?:string;rankedRequested?:boolean;managed?:boolean;pendingUntil?:number;gameType?:'vanilla-1.260-iwbp';friendsOnly?:boolean;passwordProtected?:boolean;
  capacity: number; map: RoomMap | null; revision: number; players: Player[];
  observedMap?:ObservedLobbyMap;
  manifest: MatchManifest | null;
  steamLink: SteamLobbyLink | null;
  nativeHost: NativeHostRun | null;
  chat: { id: string; name: string; text: string; at: string }[];
}
export interface SteamLobbyLink {
  id: string; lobbyId: string; publishedBy: string; publishedAt: string; expiresAt: string;
  source: 'manual' | 'automatic';
}
export interface GameLogReport {
  lobbyId: string | null;
  state: 'no-session' | 'join-requested' | 'entered' | 'left' | 'failed';
  message: string;
}
export interface MapHandoffStatus {state:'waiting'|'confirmed'|'failed'|'changed'|'updated'|'unavailable';requestedMap:string;currentMap:string|null;message:string}
export interface LaunchStatus {
  preparing?:{stage:string;elapsedMs:number};
  running: boolean; logName: string | null; report: GameLogReport;
  mapHandoff?: MapHandoffStatus;
  nativeGuest?:{message:string};
  relay?: {active:boolean;paired:boolean;sent:number;received:number;message:string};
  nativeHost?: {active:boolean;message:string};
  live?: LiveLobby; sharing?: { enabled: boolean; lobbyId: string | null; message: string };
}
export interface RoomSummary {
  id: string; name: string; host: string; mapLabel: string;
  researchId?:string;hostId?:string;gameType?:string;friendsOnly?:boolean;passwordProtected?:boolean;
  nativePhase?: NativeHostPhase | null;
  mapObservedAt?:string;
  count: number; capacity: number; prepared: boolean; live: boolean; map: RoomMap | null; players: BrowserPlayer[];
}
export interface Snapshot {
  account?:{id:string;username:string};
  serverVersion?:string;features?:{managedLobbies:boolean;privateLobbies:boolean;social:boolean;chat?:boolean;nativePreferences:boolean;lobbyBalance?:boolean;rankedLadder?:boolean;matchmaking?:boolean;lobbyMapSync?:boolean;mapRepository?:boolean};
  hosting?:{approvalRequired:boolean;approved:boolean};
  matches?:MatchSummary[];
  protocol: number; playerId: string; rooms: RoomSummary[]; room: Room | null; admin?: {expiresAt:string;permanent?:boolean} | null;
}
export interface LiveLobby {
  lobbyId: string | null; status: 'waiting' | 'active' | 'left' | 'unavailable';
  role: 'host' | 'guest' | null; observedAt: number; message: string;
}
export interface HostRoomRequest { server: string; token: string; roomId: string; applyMap?: boolean }
export interface PrivateServerStatus { running: boolean; address: string | null; accessKey: string | null; adminConfigured?: boolean }
export interface DesktopProfile { path: string; profile: GameProfile }
export interface SavedAccount { server: string; username: string; refreshToken: string }
export type ReplayPlayback = 'reforged' | 'original';
export interface PublicSetupStatus {running:boolean;stage:string;message:string;domain:string;localReady:boolean;httpsReady:boolean;canResume:boolean;accountCount:number;log:string[];directory:string}
export interface DesktopBridge {
  gameFirewall?(request:{setup:boolean;includePublic:boolean}):Promise<{message:string}>;
  stockResearchIcons?():Promise<Record<string,string>>;
  downloadMapPackage?(request:{server:string;token:string;id:string;filename:string;size:number}):Promise<{message:string;catalog?:MapCatalog}>;
  ensureMap?(request:{server:string;token:string;map:RoomMap}):Promise<MapCatalog>;
  cancelMapPackageDownload?():Promise<void>;
  onMapPackageProgress?(callback:(value:{id:string;received:number;total:number;stage?:'downloading'|'installing'|'ready';message?:string})=>void):()=>void;
  saveResearchDraft?(draft:import('./research').ResearchDraft):Promise<{message:string}>;
  scanReplays?():Promise<{id:string;name:string;size:number;modifiedAt:string;selectedFolder?:boolean}[]>;
  chooseReplayFolder?():Promise<{id:string;name:string;size:number;modifiedAt:string;selectedFolder?:boolean}[]|null>;
  getReplayFolder?():Promise<string|null>;
  replayScanReport?():Promise<{folder:string|null;files:number;candidates:number;recognized:number;rejected:number;unreadable:number;limited:boolean}|null>;
  playReplay?(id:string,playback?:ReplayPlayback):Promise<{message:string}>;
  publishReplay?(value:{id:string;server:string;token:string}):Promise<{message:string}>;
  downloadReplay?(value:{id:string;server:string;token:string}):Promise<{message:string}>;
  hostIndependentRoom?(request:HostRoomRequest):Promise<{message:string}>;
  joinIndependentRoom?(request:HostRoomRequest):Promise<{message:string}>;
  checkUpdate?(server:string,token?:string):Promise<{available:boolean;version:string;notes:string;size:number;accessRequired?:boolean}>;
  downloadUpdate?(server:string,token?:string):Promise<{message:string;version:string}>;
  installUpdate?(server:string):Promise<void>;
  publishUpdate?(value:{server:string;token:string;version:string;notes:string}):Promise<{message:string}>;
  joinNativeRoomProbe?(request:HostRoomRequest & {address:string;runId:string}):Promise<{message:string}>;
  hostNativeRoomTest?(request:HostRoomRequest):Promise<{message:string}>;
  restoreNativeLobby?():Promise<{message:string}>;
  beginPublicSetup?(request:{domain:string;server:string;token:string;changeDomain?:boolean}):Promise<PublicSetupStatus>;
  publicSetupStatus?():Promise<PublicSetupStatus>;
  recheckPublicSetup?():Promise<PublicSetupStatus>;
  openPublicSetupFolder?():Promise<void>;
  loadConnection?():Promise<{server:string;accessKey:string}|null>;
  saveConnection?(value:{server:string;accessKey:string}):Promise<void>;
  exportPublicServer?(domain:string):Promise<{message:string}>;
  openServerManager?():Promise<void>;
  serverManagerConnection?():Promise<PrivateServerStatus>;
  importServerConnection?():Promise<{server:string;accessKey:string}|null>;
  launchNativeUdpTest?():Promise<{message:string}>;
  nativeUdpStatus?():Promise<{running:boolean;message:string}>;
  importAdminSetup?(): Promise<{message:string}>;
  loadAccount?(): Promise<SavedAccount | null>;
  saveAccount?(account: SavedAccount | null): Promise<void>;
  scanMaps(): Promise<MapCatalog>;
  mapPreview(id: string): Promise<string | null>;
  hostRoom(request: HostRoomRequest): Promise<{ message: string }>;
  stopHostSharing(): Promise<void>;
  serverInterfaces(): Promise<string[]>;
  startPrivateServer(address: string): Promise<PrivateServerStatus>;
  stopPrivateServer(): Promise<void>;
  privateServerStatus(): Promise<PrivateServerStatus>;
  inspectGame(): Promise<DesktopProfile | null>;
  chooseGame(): Promise<DesktopProfile | null>;
  launchStockGame(): Promise<{ message: string }>;
  launchDiagnosticGame(): Promise<{ message: string }>;
  joinSteamLobby(lobbyId: string,context?:HostRoomRequest): Promise<{ message: string }>;
  openLogs(): Promise<void>;
  exportGameLogs?(): Promise<{message:string}>;
  inspectLobbyLog(): Promise<{ fileName: string; report: GameLogReport } | null>;
  readLaunchStatus(): Promise<LaunchStatus>;
  saveManifest(manifest: MatchManifest): Promise<boolean>;
}

export const MATCH_QUEUES={ '1v1':{players:2,teamSize:1,label:'1v1'},'2v2':{players:4,teamSize:2,label:'2v2'},'3v3':{players:6,teamSize:3,label:'3v3'},'4v4':{players:8,teamSize:4,label:'4v4'},'ffa4':{players:4,teamSize:1,label:'FFA · 4'},'ffa6':{players:6,teamSize:1,label:'FFA · 6'},'ffa8':{players:8,teamSize:1,label:'FFA · 8'}} as const;
export type QueueMode=keyof typeof MATCH_QUEUES;
export interface MatchmakingStatus {queue?:QueueMode;queues?:QueueMode[];stats?:Partial<Record<QueueMode,{queued:number;active:number;oldestSeconds:number}>>;rating?:{rating:number;games:number};phase:'idle'|'searching'|'accepting'|'assigned';queuedAt?:string;canHost?:boolean;matchId?:string;map?:RoomMap;opponent?:string;acceptBy?:string;accepted?:boolean;opponentAccepted?:boolean;roomId?:string;role?:'host'|'guest'}
