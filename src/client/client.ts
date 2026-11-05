import {playtestPanel,playtestCards} from './playtest-admin.js';
import type {PlaytestAdmin} from '../shared/playtests.js';
let adminPlaytests:PlaytestAdmin|null=null;
import {sendMapPackage} from './map-upload.js';
import { PROTOCOL, CLIENT_VERSION, MATCH_QUEUES, COLOUR_DEFINITIONS, LADDER_FFA_COLOURS, MAP_PACKAGE_LIMIT, type MapPackage, type MapRepositoryPage, type GameMap, type RoomMap, type RoomSummary, type MatchSummary, type DesktopBridge, type DesktopProfile, type Snapshot, type PublicSetupStatus } from '../shared/model.js';
import {ResearchWorkshop} from './research-workshop.js';
declare global { interface Window { desktop?: DesktopBridge } }
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
let publicSetupState:PublicSetupStatus|null=null,publicSetupPolling=false,setupConnected=false;
let token = sessionStorage.getItem('sc2-token') ?? '';
let server = sessionStorage.getItem('sc2-server') ?? (location.protocol.startsWith('http') ? location.origin : (localStorage.getItem('s2r-server')??'https://supcom2reforged.com'));
let snapshot: Snapshot | null = null;
let localProfile: DesktopProfile | null = null;
let statisticsRequest=0;
let accountUser:string|null=sessionStorage.getItem('s2r-account-user');
let rememberedToken='',savedAccessKey='',savedConnectionServer='';
let awaitingOwnerConnection=false;
let ownEmail:{email:string|null;emailVerified:boolean;preferences?:{faction:string;colour:string}}|null=null;
let adminUsers:AdminDashboard['users']=[];
let currentPage='auth',connectionWanted=!!token,reconnectFailures=0,nextReconnectAt=0;
let busy = false;
let exportingDiagnostics=false;
let polling = false;
let generation = 0;
let lastRoom = '';
let lastRooms = '';
let profileUploaded = false;
let steamRoomKey = '';
let logPolling = false;
let gameRunning = false;
let connectionPhase='';
let gamePreparing=false;
const desktop = window.desktop;
let installedMaps:GameMap[]=[];
let mapRepositoryPage:MapRepositoryPage|null=null,mapRepositoryScope='',mapRepositoryEpoch=0,mapRepositoryBusy=false,mapRepositoryLoading=false,mapRepositoryNotice='',mapRepositorySearchTimer:ReturnType<typeof setTimeout>|undefined,mapRepositoryAbort:AbortController|null=null;
let mapDownloadId='';
const transferPanel=document.createElement('section');transferPanel.id='map-transfer';transferPanel.className='panel map-transfer';transferPanel.hidden=true;transferPanel.innerHTML='<p id="map-transfer-label" role="status"></p><progress id="map-transfer-bar" max="100" value="0" aria-label="Map download progress"></progress><button id="map-transfer-cancel" class="secondary">Cancel download</button>';element('status').closest('.status-strip')!.after(transferPanel);
let mapTransfer:{id:string;received:number;total:number;stage?:string;message?:string}|null=null;
function paintMapTransfer(value:NonNullable<typeof mapTransfer>){
 if(!Number.isFinite(value.total)||value.total<=0||!Number.isFinite(value.received)||value.received<0||value.received>value.total)return;
 mapTransfer=value;const percent=Math.min(100,Math.floor(value.received/value.total*100)),label=value.stage==='ready'?'Map installed and ready.':value.stage==='installing'?'Installing and checking map…':'Downloading map '+percent+'% · '+(value.received/1024/1024).toFixed(1)+' / '+(value.total/1024/1024).toFixed(1)+' MiB';
 transferPanel.hidden=false;element('map-transfer-label').textContent=label;element<HTMLProgressElement>('map-transfer-bar').value=percent;element('map-transfer-cancel').hidden=value.stage==='ready';
 for(const item of Array.from(document.querySelectorAll<HTMLElement>('[data-map-transfer]'))){if(item.dataset.mapTransfer!==value.id)continue;item.hidden=false;item.querySelector('span')!.textContent=label;item.querySelector('progress')!.value=percent;}
 if(mapRepositoryBusy&&mapDownloadId===value.id)element('map-upload-status').textContent=label;
 if(value.stage==='ready')setTimeout(()=>{if(mapTransfer===value)transferPanel.hidden=true;},5000);
}
desktop?.onMapPackageProgress?.(paintMapTransfer);
element('map-transfer-cancel').addEventListener('click',()=>{void desktop?.cancelMapPackageDownload?.();transferPanel.hidden=true;});
let selectedRoomId='';
let mapEpoch=0, previewRevision=0;
let selectedMapId='',mapPage=0;
let listView=localStorage.getItem('s2r-view')??'tiles';
const previews=new Map<string,string|null>(), previewPending=new Set<string>();
const matchClocks=new Map<string,{seconds:number;at:number}>();
let clockSnapshot:Snapshot|null=null;
function matchSeconds(m:MatchSummary){const clock=matchClocks.get(m.runId);return clock?clock.seconds+(performance.now()-clock.at)/1000:m.elapsedSeconds;}
function elapsedLabel(seconds:number){const s=Math.max(0,Math.floor(Number.isFinite(seconds)?seconds:0)),h=Math.floor(s/3600),min=Math.floor(s/60)%60,sec=s%60;return (h?h+':'+String(min).padStart(2,'0'):String(min).padStart(2,'0'))+':'+String(sec).padStart(2,'0');}
function updateMatchClocks(){
 if(clockSnapshot!==snapshot){clockSnapshot=snapshot;const runs=new Set<string>();for(const m of snapshot?.matches??[]){runs.add(m.runId);const prior=matchClocks.get(m.runId);matchClocks.set(m.runId,{seconds:Math.max(m.elapsedSeconds,prior?matchSeconds(m):0),at:performance.now()});}for(const run of matchClocks.keys())if(!runs.has(run))matchClocks.delete(run);}
 for(const time of Array.from(document.querySelectorAll<HTMLElement>('[data-match-clock]'))){const m=snapshot?.matches?.find(m=>m.runId===time.dataset.matchClock);if(m){time.textContent='~ '+elapsedLabel(matchSeconds(m));time.title=reconnectFailures?'Connection interrupted; waiting for updated timing.':'Elapsed since battle detection; includes loading and pauses.';}}
}
function browserMap(r:RoomSummary):RoomMap|null{return 'mapId' in r?installedMaps.find(m=>m.id.toLowerCase()===(r as MatchSummary).mapId?.toLowerCase())??r.map:r.map;}
function browserMapLabel(r:RoomSummary){return browserMap(r)?.name??r.mapLabel;}
function browserPlayers(r:RoomSummary){return r.players.filter(p=>!p.observer).map(p=>p.name+(p.ai?' (AI)':'')).join(' · ');}

input('server-url').value = server;
input('account-name').value=(localStorage.getItem('supcom2-name')??localStorage.getItem('sc2-name'))??'';
input('display-name').value = (localStorage.getItem('supcom2-name')??localStorage.getItem('sc2-name')) ?? '';
function status(message: string, error = false) { const box = element('status'); box.textContent = message; box.classList.toggle('error', error); const dialog=element<HTMLDialogElement>('create-dialog'),notice=element('create-status'); if(notice&&dialog.open){notice.textContent=message;notice.hidden=false;notice.classList.toggle('error',error);} }
function normaliseServer(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a server address such as http://127.0.0.1:47820 without a path.');
  return url.origin;
}
async function api<T>(route: string, body?: object): Promise<T> {
  if(body&&['create','join'].includes(route))body={...body,researchSupported:true};
  let response: Response;const requestToken=token,requestServer=server;
  try { response = await fetch(`${server}/api/${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(route==='maps/rescan'?150000:/^(account\/(register|email|resend-verification|request-reset)|admin\/mail-test)$/.test(route)?45000:7000) }); }
  catch { throw new Error(`Cannot reach ${server}. For shared rooms, both PCs need the same reachable server address; 127.0.0.1 means this PC. Check the saved server connection in your profile.`); }
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && requestToken && requestToken===token && requestServer===server) { offline(); status('Session expired. Sign in again.', true); }
    throw new Error(data.error ?? `HTTP ${response.status}`);
  }
  if (data.protocol !== undefined && data.protocol !== PROTOCOL) { offline(); throw new Error('Client and room server protocols differ. Update the incompatible client or server.'); }
  return data as T;
}
const researchWorkshop=new ResearchWorkshop(element('research-workshop'),(route,body)=>api(route.replace('admin/research','admin/research/v2'),body),desktop?.saveResearchDraft?draft=>desktop.saveResearchDraft!(draft):undefined,desktop?.stockResearchIcons?()=>desktop.stockResearchIcons!():undefined);
function offline() {
  resetMapRepository();
  generation++; token = ''; snapshot = null;chatTo='';chatEpoch++;chatKey='';socialFriends=[];element('social-messages')?.replaceChildren(); profileUploaded = false;accountUser=null;ownEmail=null;sessionStorage.removeItem('s2r-account-user');
  sessionStorage.removeItem('sc2-token'); lastRoom = ''; lastRooms = ''; render();
  if(currentPage==='replays'){communityReplayRows=[];communityReplayNotice='Sign in to browse and share community replays. Local recordings stay available.';drawReplays();}
}
async function task(work: () => Promise<void>) {
  if (busy) return;
  busy = true; generation++;
  try { await work(); } catch (error) {
    // A rejected select change must restore authoritative choices even when the
    // next server snapshot has the same JSON as before the attempted change.
    lastRoom = ''; render();
    status(error instanceof Error ? error.message : 'Request failed.', true);
  }
  finally { busy = false; }
}
async function command(action: string, body: object) {
  const next = await api<Snapshot>(action, body);
  snapshot = next; render();
}
function options(values: readonly (string | number)[], selected: string | number) {
  return values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(value)}</option>`).join('');
}
function render() {
  researchWorkshop.setAccess(snapshot?.admin&&token?server+'|'+token:null);
  const connected = !!token && !!snapshot;
  updateMapRepositoryControls();
  element('connection-state').textContent = reconnectFailures?'RECONNECTING':connected ? 'CONNECTED' : 'OFFLINE';
  element('connection-state').classList.toggle('online', connected);
  element('connect-button').hidden = connected;
  element('disconnect-button').hidden = !connected;
  for (const id of ['server-url', 'display-name', 'access-key']) input(id).disabled = connected;
  input('room-name').disabled = !connected || !!snapshot?.room;
  element<HTMLButtonElement>('create-button').disabled = !connected || !!snapshot?.room || snapshot?.hosting?.approved===false;
  for(const id of ['open-create','home-create'])element<HTMLButtonElement>(id).disabled=connected&&snapshot?.hosting?.approved===false;
  element('hosting-approval').textContent=!connected?'':snapshot?.hosting?.approved===false?'Hosting awaits administrator approval. You can browse and join games.':'Your account can host games on this server.';
  updateIdentity();renderAccount();showPage();
  updateMatchClocks();
  const roomListKey = JSON.stringify([snapshot?.rooms,snapshot?.matches?.map(m=>({...m,elapsedSeconds:0})),!!reconnectFailures, snapshot?.room?.id,selectedRoomId,input('room-search').value,element<HTMLSelectElement>('room-sort').value,listView,previewRevision]);
  if (roomListKey !== lastRooms) {
    lastRooms = roomListKey;
    element('room-count').textContent = connected ? `${snapshot!.rooms.length} open · ${snapshot!.matches?.length??0} in progress` : 'Connect to browse';
    const search=input('room-search').value.trim().toLowerCase();
    const order=element<HTMLSelectElement>('room-sort').value;
    const matchesSearch=(r:RoomSummary)=>[r.name,r.host,browserMapLabel(r),...r.players.map(p=>p.name)].join(' ').toLowerCase().includes(search);
    const sortRooms=(a:RoomSummary,b:RoomSummary)=>order==='name'?a.name.localeCompare(b.name):order==='map'?browserMapLabel(a).localeCompare(browserMapLabel(b)):b.count-a.count||a.name.localeCompare(b.name);
    const rooms=(snapshot?.rooms??[]).filter(matchesSearch).sort(sortRooms),matches=(snapshot?.matches??[]).filter(matchesSearch).sort(sortRooms);
    if(selectedRoomId&&!snapshot?.rooms.some(r=>r.id===selectedRoomId)&&!snapshot?.matches?.some(r=>r.id===selectedRoomId))selectedRoomId='';
    element('open-lobby-count').textContent=String(rooms.length);
    element('progress-match-count').textContent=String(matches.length);
    element('rooms').classList.toggle('table-view',listView==='table');
    element('rooms').innerHTML=rooms.length?rooms.map(r=>`<button class="room-card ${r.id===selectedRoomId?'selected':''}" data-select="${esc(r.id)}" aria-pressed="${r.id===selectedRoomId}"><span class="map-thumb">${mapImage(r.map,r.mapObservedAt?'PREVIEW UNAVAILABLE':undefined)}</span><span class="room-copy"><h3>${esc(r.name)}</h3><p>${esc(r.mapLabel)}</p><span class="room-meta"><span>${r.count}/${r.capacity} players</span><span class="${r.live?'live-tag':''}">${r.nativePhase?'Reforged lobby':r.live?'Live lobby':'Gathering'}${r.passwordProtected?' · Password':''}${r.friendsOnly?' · Friends':''}</span></span><p class="host-line">Host · ${esc(r.host)}</p></span></button>`).join(''):`<div class="empty">${connected?search?'No games match your search.':'No games yet. Create the first one.':'Connect to your server to find a game.'}${!connected?'<p><button class="secondary" data-page="profile">Connection settings</button></p>':''}</div>`;
    element('matches-progress').classList.toggle('table-view',listView==='table');
    element('matches-progress').innerHTML=matches.length?matches.map(m=>`<button class="room-card match-card ${m.id===selectedRoomId?'selected':''}" data-select="${esc(m.id)}" aria-pressed="${m.id===selectedRoomId}"><span class="map-thumb">${mapImage(browserMap(m))}</span><span class="room-copy"><h3>${esc(m.name)}</h3><p>${esc(browserMapLabel(m))}</p><span class="room-meta"><span class="match-state">${m.mode==='matchmaking'?'Matchmaking':'In progress'}</span><span class="match-clock" data-match-clock="${esc(m.runId)}">~ ${elapsedLabel(matchSeconds(m))}</span></span><p class="match-players" title="${esc(browserPlayers(m))}">${esc(browserPlayers(m))}</p></span></button>`).join(''):`<div class="empty">${!connected?'Connect to see matches in progress.':snapshot?.matches===undefined?'Upgrade your server to 0.27.14 to see matches in progress.':search?'No matches fit your search.':'No matches are in progress.'}</div>`;
    element('match-browser-note').textContent=reconnectFailures?'Connection interrupted. Listings may be out of date.':'Elapsed time starts when the host’s battle is detected.';
    for(const r of rooms.slice(0,30))if(r.map)void requestPreview(r.map.id);
    for(const r of matches.slice(0,30)){const m=browserMap(r);if(m)void requestPreview(m.id);}
    renderSelected();
    updateMatchClocks();
  }

  const room = snapshot?.room;
  element('room-panel').hidden = !room;
  const roomKey = JSON.stringify(room ? {...room, steamLink: null,nativeHost:null} : room);
  if (room && roomKey !== lastRoom) {
    lastRoom = roomKey;
    element('room-panel').innerHTML = `<div class="section-heading"><div><p class="eyebrow">GAME SESSION</p><h2>${esc(room.name)}</h2></div><button id="leave-room" class="secondary danger">Leave game listing</button></div><p class="muted small">${room.observedMap?'Map in game':'Requested map'}: ${esc(room.observedMap?.name??room.mapLabel)} · ${room.players.length}/${room.capacity} in this listing</p><div class="session-players">${room.players.map(p=>`<span>${esc(p.name)}${p.id===room.hostId?' · Host':''}</span>`).join('')}</div>`;
  }
  if (!room) lastRoom = '';
  element<HTMLButtonElement>('clear-profile').disabled = !connected;
  renderSteamRoom();
}
function renderSteamRoom() {
  const room = snapshot?.room;
  const host = room?.hostId === snapshot?.playerId;
  const key = room ? `${room.id}:${room.hostId}` : '';
  if (key !== steamRoomKey) {
    steamRoomKey = key;
    input('publish-lobby-id').value = '';
    input('confirm-lobby').checked = false;
  }
  element('steam-room-panel').hidden = !room;
  element('steam-host-controls').hidden = !host;
  const link = room?.steamLink;
  const ready=room?.nativeHost?.phase==='lobby-observed'||!!link&&Date.parse(link.expiresAt)>Date.now();
  element('connection-role').textContent=host?'YOUR LOBBY':'JOIN LOBBY';
  element('shared-steam-status').textContent=!localProfile?'Select your game in Commander → Settings to continue.':gameRunning
    ? gamePreparing?'Preparing Supreme Commander 2…':connectionPhase==='battle-observed'?'Battle in progress. Return to Supreme Commander 2.':'Supreme Commander 2 is open. Set up your game and ready up there.'
    : host?'Launch your lobby, then choose teams, factions and the map in Supreme Commander 2.'
    : ready?'The host’s lobby is ready. Join to choose your faction and ready up.':'Waiting for the host to open their lobby…';
  element<HTMLButtonElement>('host-room-game').textContent=gamePreparing?'Opening game…':gameRunning?'Game is open':'Launch game lobby';
  element('join-room-game').hidden=!!host;
  element('join-room-game').textContent=gameRunning?'Game is open':ready?'Join game lobby':'Waiting for host';
  element<HTMLButtonElement>('host-room-game').disabled = !desktop?.hostRoom || !localProfile || !host || gameRunning;
  element('host-room-game').title='Independent Reforged multiplayer · up to eight connections';
  element<HTMLButtonElement>('host-steam-fallback').disabled=!desktop?.hostRoom||!localProfile||!host||gameRunning;
  element<HTMLButtonElement>('host-native-room').disabled=!desktop?.hostNativeRoomTest||!localProfile||!host||gameRunning||!!room?.nativeHost;
  element('native-room-status').textContent=room?.nativeHost?`Host test: ${room.nativeHost.phase.replaceAll('-',' ')}. Public native joining is not available. The private LAN guest probe is unverified.`:'';
  element('native-guest-controls').hidden=!room?.nativeHost||!!host;
  element<HTMLButtonElement>('join-native-probe').disabled=!desktop?.joinNativeRoomProbe||!localProfile||gameRunning||!!host||room?.nativeHost?.phase!=='lobby-observed';

  element<HTMLButtonElement>('clear-steam').disabled = !link;
  element<HTMLButtonElement>('join-room-game').disabled = !desktop || !localProfile || !!host || gameRunning || !(room?.nativeHost?.phase==='lobby-observed'&&desktop.joinIndependentRoom||link&&Date.parse(link.expiresAt)>Date.now());
}
function refreshDiagnosticsControls(){for(const id of ['export-game-logs'])element<HTMLButtonElement>(id).disabled=exportingDiagnostics||!desktop?.exportGameLogs;}
async function exportLaunchDiagnostics(){
 if(exportingDiagnostics||!desktop?.exportGameLogs)return;exportingDiagnostics=true;refreshDiagnosticsControls();
 const field=element('game-diagnostics-status');field.classList.remove('error');field.textContent='Preparing the latest launch diagnostics…';
 try{const result=await desktop.exportGameLogs();field.textContent=result.message;status(result.message);}
 catch(error){field.textContent=error instanceof Error?error.message:'Could not export diagnostics.';field.classList.add('error');status(field.textContent,true);}
 finally{exportingDiagnostics=false;refreshDiagnosticsControls();}
}
function showGame() {
  element('selected-game-path').textContent=localProfile?.path??'Choose your SupCom 2 installation to enable game launch and local map discovery.';
  element('game-info').textContent = localProfile ? `${localProfile.path}\nSHA-256: ${localProfile.profile.exeSha256}\nExecutable checked. ${localProfile.profile.largeAddressAware===true?'Large Address Aware enabled · up to 4 GB virtual address space on 64-bit Windows.':localProfile.profile.largeAddressAware===false?'Large Address Aware is disabled for this executable.':'Memory flag not identified.'}` : 'No game selected. Choose SupremeCommander2.exe from your installation’s bin folder.';
  element('game-info').classList.add('fingerprint');
  element<HTMLButtonElement>('launch-stock').disabled = !localProfile;
  element<HTMLButtonElement>('launch-diagnostic').disabled = !localProfile;
  refreshDiagnosticsControls();
  element<HTMLButtonElement>('join-steam').disabled = !localProfile;
  input('steam-lobby-id').disabled = !localProfile;
  element<HTMLButtonElement>('inspect-game').disabled = !localProfile;
  renderSteamRoom();
  element<HTMLButtonElement>('rescan-maps').disabled=!localProfile||!desktop?.scanMaps;
  element<HTMLButtonElement>('maps-rescan').disabled=!localProfile||!desktop?.scanMaps;
}
async function uploadProfile() {
  if (token && localProfile) { await command('profile', { profile: localProfile.profile }); profileUploaded = true; }
}
element('connect-form').addEventListener('submit', event => {
  event.preventDefault(); void task(async () => {
    await desktop?.saveAccount?.(null);rememberedToken='';accountUser=null;sessionStorage.removeItem('s2r-account-user');
    server = normaliseServer(input('server-url').value);
    const result = await api<{ token: string }>('session', { name: input('display-name').value, accessKey: input('access-key').value, protocol: PROTOCOL });
    connectionWanted=true;reconnectFailures=0;nextReconnectAt=0;token = result.token;
    sessionStorage.setItem('sc2-token', token); sessionStorage.setItem('sc2-server', server);localStorage.setItem('s2r-server',server);
    localStorage.setItem('sc2-name', input('display-name').value); input('access-key').value = '';
    snapshot = await api<Snapshot>('state');
    await uploadProfile(); render(); status('Connected. Create a room or join an existing one.');
  });
});
element('disconnect-button').addEventListener('click', () => void task(async () => {
  connectionWanted=false;rememberedToken='';reconnectFailures=0;await desktop?.saveAccount?.(null);
  await desktop?.stopHostSharing?.();
  try { await api('disconnect', {}); } finally { offline(); status('Disconnected.'); }
}));
element('create-form').addEventListener('submit', event => {
  event.preventDefault(); void task(async () => {
    const m=installedMaps.find(m=>m.id===element<HTMLSelectElement>('create-map').value);
    if(!snapshot?.features?.managedLobbies)throw Error('Upgrade your Reforged server to 0.18.0 before creating games.');
    if(element<HTMLSelectElement>('create-transport').value==='steam'&&(input('create-password').value||input('create-friends').checked))throw Error('Private games require the Reforged connection mode.');
    await command('create', { name: input('room-name').value, map:m?roomMap(m):null, capacity:Math.min(8,m?.players??8),managed:!!desktop?.hostRoom&&!!localProfile,gameType:element<HTMLSelectElement>('create-game-type').value,password:input('create-password').value,friendsOnly:input('create-friends').checked,faction:element<HTMLSelectElement>('create-faction').value,colour:element<HTMLSelectElement>('create-colour').value });
    input('create-password').value='';
    selectedRoomId=snapshot!.room!.id;closeCreate();navigate('play');lastRooms='';render();
    status('Room created. Other players on this server can join.');
    if(input('create-launch').checked&&desktop?.hostRoom&&localProfile){if(element<HTMLSelectElement>('create-transport').value==='steam'){status((await desktop.hostRoom({server,token,roomId:snapshot!.room!.id,...(snapshot?.room?.map?{applyMap:true}:{})})).message);gameRunning=true;renderSteamRoom();}else await beginHost();}
  });
});
element('browser-panel').addEventListener('click', event => {
  const id=(event.target as HTMLElement).closest<HTMLElement>('[data-select]')?.dataset.select;
  if(id){selectedRoomId=id;lastRooms='';render();}
});
element('room-panel').addEventListener('click', event => {
  if (!(event.target as HTMLElement).closest('#leave-room')) return;
  void task(async () => { await desktop?.stopHostSharing?.(); await command('leave', {}); status('Left game listing.'); });
});
if (desktop) {
  element('host-room-game').addEventListener('click', () => void task(beginHost));
  element('host-steam-fallback').addEventListener('click',()=>void task(async()=>{const room=snapshot?.room;if(!room||room.hostId!==snapshot?.playerId)throw Error('Only the host can launch the fallback.');status((await desktop.hostRoom({server,token,roomId:room.id,...(snapshot?.room?.map?{applyMap:true}:{})})).message);gameRunning=true;renderSteamRoom();}));
  element<HTMLButtonElement>('choose-game').disabled = false;
  element('choose-game').addEventListener('click', () => void task(async () => { const result = await desktop.chooseGame(); if (result) { localProfile = result; showGame(); await uploadProfile(); await scanMaps(); status('SupCom 2 executable selected. Game files were not modified.'); } }));
  element('inspect-game').addEventListener('click', () => void task(async () => { localProfile = await desktop.inspectGame(); showGame(); await uploadProfile(); await scanMaps(); status('Executable fingerprint refreshed.'); }));
  element('launch-stock').addEventListener('click', () => void task(async () => { status((await desktop.launchStockGame()).message); }));
  element('launch-diagnostic').addEventListener('click', () => void task(async () => { status((await desktop.launchDiagnosticGame()).message); }));
  element<HTMLButtonElement>('open-logs').disabled = false;
  for(const id of ['export-game-logs'])element(id).addEventListener('click',()=>void exportLaunchDiagnostics());
  element('open-logs').addEventListener('click', () => void task(async () => { await desktop.openLogs(); status('Opened the diagnostic log folder. Logs are created by the game after launch.'); }));
  element<HTMLButtonElement>('inspect-log').disabled = false;
  element('inspect-log').addEventListener('click', () => void task(async () => {
    const result = await desktop.inspectLobbyLog(); if (!result) return;
    element('log-inspection').textContent = `${result.fileName}: ${result.report.message}${result.report.lobbyId ? ` Last observed join ID: ${result.report.lobbyId}.` : ''}`;
    // A newer unusable log must not leave an older candidate ready to publish.
    input('steam-lobby-id').value = result.report.lobbyId ?? '';
    if (snapshot?.room && snapshot.room.hostId === snapshot.playerId) { input('publish-lobby-id').value = result.report.lobbyId ?? ''; input('confirm-lobby').checked = false; }
    status('Log read locally. Review the result and confirm the host still has that exact lobby open.');
  }));
}
for(const [id,setup]of [['firewall-check',false],['firewall-setup',true]] as const){
 element<HTMLButtonElement>(id).disabled=!desktop?.gameFirewall;
 element(id).addEventListener('click',()=>void task(async()=>{if(!desktop?.gameFirewall)return;const field=element('firewall-status');field.textContent=setup?'Waiting for Windows firewall setup…':'Checking Windows firewall…';for(const b of ['firewall-check','firewall-setup'])element<HTMLButtonElement>(b).disabled=true;try{field.textContent=(await desktop.gameFirewall({setup,includePublic:input('firewall-public').checked})).message;}catch(e){field.textContent=(e as Error).message;throw e;}finally{for(const b of ['firewall-check','firewall-setup'])element<HTMLButtonElement>(b).disabled=false;}}));
}
element('publish-steam-form').addEventListener('submit', event => {
  event.preventDefault(); void task(async () => {
    await desktop?.stopHostSharing?.();
    snapshot = await api<Snapshot>('state'); render();
    const room = snapshot?.room; if (!room) throw new Error('Join a community room first.');
    await command('steam-publish', { lobbyId: input('publish-lobby-id').value, confirmCurrent: input('confirm-lobby').checked, expectedLinkId: room.steamLink?.id ?? null });
    input('confirm-lobby').checked = false;
    status('Steam lobby shared with this room. Guests can now click Join host’s SupCom 2 lobby.');
  });
});
element('clear-steam').addEventListener('click', () => void task(async () => {
  await desktop?.stopHostSharing?.();
  snapshot = await api<Snapshot>('state'); render();
  await command('steam-clear', { linkId: snapshot?.room?.steamLink?.id ?? null });
  status('Shared game lobby cleared. Publish a fresh ID after creating a new game lobby.');
}));
element('join-room-game').addEventListener('click', () => void task(joinCurrentGame));
element('steam-join-form').addEventListener('submit', event => {
  event.preventDefault();
  if (desktop) void task(async () => { status((await desktop.joinSteamLobby(input('steam-lobby-id').value)).message); });
});
element('clear-profile').addEventListener('click', () => void task(async () => { await command('profile', { profile: null }); profileUploaded = true; status('Room fingerprint cleared for configuration rehearsal. Local game selection is unchanged.'); }));
async function poll() {
  if(awaitingOwnerConnection&&!token&&desktop?.serverManagerConnection&&!busy){try{const c=await desktop.serverManagerConnection();input('server-url').value=c.address!;input('access-key').value=c.accessKey!;savedConnectionServer=c.address!;savedAccessKey=c.accessKey!;await desktop.saveConnection?.({server:c.address!,accessKey:c.accessKey!});awaitingOwnerConnection=false;status('Server ready. Connection saved; sign in with your existing account.');}catch{/* Owner may still be choosing an interface. */}}

  if ((!token&&!rememberedToken) || !connectionWanted || polling || busy || Date.now()<nextReconnectAt) return;
  polling=true;const current=generation,restoring=!token;
  try{
    if(!token){await acceptAccount(await api<AccountResult>('account/restore',{refreshToken:rememberedToken,protocol:PROTOCOL}),rememberedToken);}
    else{const next=await api<Snapshot>('state');if(current!==generation)return;snapshot=next;await syncAccountName(next.account);}
    if(localProfile&&!profileUploaded){await uploadProfile();if(current!==generation)return;}
    if(reconnectFailures)status('Reconnected to your S2R server.');reconnectFailures=0;nextReconnectAt=0;render();
  }catch(error){
    if(!connectionWanted)return;
    const message=error instanceof Error?error.message:'Server unavailable.';
    if((/disabled|protocol|versions differ|signed in elsewhere/i.test(message)||restoring&&/expired/i.test(message))&&!token){connectionWanted=false;rememberedToken='';reconnectFailures=0;await desktop?.saveAccount?.(null);render();status(message,true);return;}
    reconnectFailures++;nextReconnectAt=Date.now()+Math.min(30_000,1500*2**Math.min(reconnectFailures-1,5));status('Connection interrupted. Retrying automatically. '+message,true);render();
  }finally{polling=false;}
}
async function init() {
  if(desktop?.publicSetupStatus){try{const state=await desktop.publicSetupStatus();element('resume-public-setup').hidden=!state.canResume;publicSetupState=state;}catch(e){status((e as Error).message,true);}}
  try{const c=await desktop?.loadConnection?.();if(c){if(token&&server!==c.server)offline();server=normaliseServer(c.server);savedAccessKey=c.accessKey;savedConnectionServer=c.server;input('server-url').value=server;input('access-key').value=savedAccessKey;}}catch(e){status((e as Error).message,true);}

  if (desktop) { try { localProfile = await desktop.inspectGame(); } catch (error) { status(String(error), true); } showGame(); if(localProfile)await scanMaps(); }
  if (desktop?.serverInterfaces) {
    try {
      const addresses = await desktop.serverInterfaces();
      element<HTMLSelectElement>('server-interface').innerHTML = options(addresses, addresses[0]);
      element('private-server-panel').hidden = false;
      showPrivateServer(await desktop.privateServerStatus());
    } catch (error) { status(String(error), true); }
  }
  applyPreferences(); showPage();void checkClientUpdate(false);
  let saved:Awaited<ReturnType<NonNullable<DesktopBridge['loadAccount']>>>=null;
  try{saved=await desktop?.loadAccount?.()??null;if(saved&&saved.server===server){rememberedToken=saved.refreshToken;connectionWanted=true;}}catch{status('Saved sign-in could not be read. Sign in again.',true);}
  if(token)await task(async()=>{snapshot=await api<Snapshot>('state');ownEmail=await api<{email:string|null;emailVerified:boolean}>('account/profile');input('profile-email').value=ownEmail.email??'';if(!ownEmail.email)element<HTMLDetailsElement>('email-settings').open=true;await uploadProfile();render();void checkClientUpdate(false);status('Session restored.');});
  if(!token&&saved&&saved.server===server)await task(async()=>{connectionWanted=true;rememberedToken=saved!.refreshToken;server=normaliseServer(saved!.server);input('server-url').value=server;await acceptAccount(await api<AccountResult>('account/restore',{refreshToken:saved!.refreshToken,protocol:PROTOCOL}),saved!.refreshToken);status('Signed in as '+accountUser+'.');});
  render(); setInterval(() => void poll(), 1500);
  if (desktop?.readLaunchStatus) { void pollLaunch(); setInterval(() => void pollLaunch(), 5000); }
}
async function pollLaunch() {
  if (!desktop || logPolling) return;
  logPolling = true;
  try {
    const state = await desktop.readLaunchStatus();
    if(state.preparing){const names:Record<string,string>={'starting-preparation-worker':'Starting game preparation','preparing-display-settings':'Reading display settings','preparing-fresh-runtime':'Preparing a fresh game interface copy',
'preparing-research':'Preparing published research',
'preparing-runtime':'Preparing the game copy','preparing-runtime-files':'Checking game-data links','preparing-seed-interface':'Creating the initial game interface','preparing-verify-originals':'Verifying original game files','preparing-interface-files':'Preparing interface files','preparing-read-interface-inputs':'Reading interface inputs','preparing-check-interface-cache':'Checking the prepared interface','preparing-build-interface':'Building the game interface','preparing-check-older-interface':'Checking an older interface version','preparing-save-interface':'Saving the game interface','preparing-native-executable':'Preparing the game executable','preparing-save-executable':'Saving the game executable','preparing-save-manifest':'Finishing game preparation','checking-processes':'Checking Steam and game processes','checking-host-room':'Checking your lobby','preparing-host-game':'Preparing the game interface','preparing-guest-game':'Preparing the game interface','preparing-replay-game':'Preparing replay playback','connecting-host-relay':'Connecting to Reforged','launching-game':'Starting Supreme Commander 2'};status((names[state.preparing.stage]??'Preparing Supreme Commander 2')+' · '+Math.floor(state.preparing.elapsedMs/1000)+'s');}
    const publication=element('game-publication-status');publication.hidden=!state.running||!state.nativeHost;publication.textContent=state.nativeHost?.message??'';publication.classList.toggle('error',!!state.nativeHost&&!state.nativeHost.active);
    gamePreparing=!!state.preparing;connectionPhase=snapshot?.room?.nativeHost?.phase??'';
    const changed=gameRunning!==state.running;gameRunning = state.running;renderSteamRoom();if(changed&&currentPage==='replays')drawReplays();
    element<HTMLButtonElement>('launch-udp-test').disabled=gameRunning||!localProfile||!desktop.launchNativeUdpTest;
    element<HTMLButtonElement>('restore-native-lobby').disabled=gameRunning||!localProfile||!desktop.restoreNativeLobby;
    if(desktop.nativeUdpStatus)element('udp-test-status').textContent=(await desktop.nativeUdpStatus()).message;
    const handoff=element('map-handoff-status');handoff.hidden=!state.mapHandoff;
    handoff.textContent=state.mapHandoff?state.mapHandoff.message+(state.mapHandoff.currentMap?' Current: '+state.mapHandoff.currentMap:''):'';
    handoff.classList.toggle('error',!!state.mapHandoff&&['failed','changed','unavailable'].includes(state.mapHandoff.state));
    element('launch-status').textContent = `${state.running ? 'Client-started process is running.' : 'No client-started process is running.'} ${state.logName ?? ''} ${state.live?.message ?? state.report.message}`;
    element('host-game-status').textContent = !state.running?'Game closed. Launch the lobby when you are ready.':state.relay?.active?`${state.relay.message} Packets sent: ${state.relay.sent} · received: ${state.relay.received}. ${state.nativeGuest?.message??''}`:state.nativeHost?.message??state.sharing?.message ?? 'Select your Steam installation, join a room, and launch the lobby.';
  } catch { element('launch-status').textContent = 'Could not read the latest launch log. Use the log folder to inspect it.'; }
  finally { logPolling = false; }
}
function showPrivateServer(state: {running:boolean,address:string|null,accessKey:string|null,adminConfigured?:boolean}) {
  element<HTMLButtonElement>('import-admin-setup').disabled=!state.running||!!state.adminConfigured||!desktop?.importAdminSetup;
  element('admin-setup-status').textContent=state.adminConfigured?'Administrator PIN configured on this server.':'Server owner: import your private administrator setup file here.';
  input('hosted-server-url').value = state.address ?? '';
  input('hosted-server-key').value = state.accessKey ?? '';
  element<HTMLButtonElement>('start-server').disabled = state.running;
  element<HTMLButtonElement>('stop-server').disabled = !state.running;
  element<HTMLSelectElement>('server-interface').disabled = state.running;
  element('private-server-status').textContent = state.running ? 'Room server running. Share the address and key below.' : 'Room server is stopped.';
}
element('start-server').addEventListener('click', () => void task(async () => {
  if (!desktop) return;
  const result = await desktop.startPrivateServer(element<HTMLSelectElement>('server-interface').value);
  if (token) { try { await desktop.stopHostSharing(); await api('disconnect', {}); } catch { /* Old server may be unreachable. */ } finally { offline(); } }
  showPrivateServer(result);
  input('server-url').value = result.address!; input('access-key').value = result.accessKey!;
  status('Private server started. Sign in or create an account above; guest connection is in Advanced settings.');
}));
element('stop-server').addEventListener('click', () => void task(async () => {
  if (!desktop) return;
  const local = await desktop.privateServerStatus();
  await desktop.stopPrivateServer();
  if (server === local.address){connectionWanted=false;reconnectFailures=0;offline();}
  showPrivateServer({running:false,address:null,accessKey:null});
  status('Private room server stopped.');
}));


function navigate(page:string){
 if(!['home','play','maps','leaderboard','replays','profile','admin','auth'].includes(page))return;
 currentPage=page;showPage();if(currentPage==='maps'){renderMaps();if(!element('maps-community').hidden)void loadMapRepository();}if(currentPage==='leaderboard')void task(loadLeaderboard);if(currentPage==='replays')void loadReplays().catch(error=>status(error instanceof Error?error.message:'Could not load replays.',true));if(currentPage==='admin')void task(loadAdmin);if(currentPage==='profile'){void loadMatchStatistics();fillPlayerPreferences();if(accountUser)void loadFriends().catch(()=>{});}
}
function showPage(){
 element('community-connection').textContent=server==='https://supcom2reforged.com'?'Community server · supcom2reforged.com':'Saved server · '+server;
 const connected=!!token&&!!snapshot;
 const localReplayPage=currentPage==='replays'&&!!desktop?.scanReplays;
 if(!connected&&!localReplayPage)currentPage='auth';else if(connected&&currentPage==='auth')currentPage='home';
 const unlocked=!!snapshot?.admin&&Date.parse(snapshot.admin.expiresAt)>Date.now();
 if(currentPage==='admin'&&!unlocked)currentPage='profile';
 element('main-nav').hidden=!connected;element('nav-admin').hidden=!unlocked;
 element('auth-local-replays').hidden=!desktop?.scanReplays;element('replays-sign-in').hidden=connected;
 for(const page of ['auth','home','play','maps','leaderboard','replays','profile','admin']){
  element('page-'+page).hidden=page!==currentPage;
  const nav=element('nav-'+page);if(nav){nav.classList.toggle('active',page===currentPage);nav.setAttribute('aria-current',page===currentPage?'page':'false');}
 }
 // Reparent only when the auth/profile destination changes. Appending a panel
 // to the same parent still detaches focused inputs during background polling.
 for(const [panelId,slotId]of [['account-panel',connected?'profile-account-slot':'auth-account-slot'],['advanced-connection',connected?'admin-server-slot':'auth-connection-slot'],['private-server-panel',connected?'admin-server-slot':'auth-owner-slot']]){
  const panel=element(panelId),slot=element(slotId);if(panel.parentElement!==slot)slot.append(panel);
 }
 element('advanced-connection').hidden=!unlocked;
 element('private-server-panel').hidden=!desktop||connected&&!unlocked;
 element('mm-pool-admin').hidden=!unlocked;
 if(!unlocked)element('admin-dashboard').replaceChildren();
}
function updateIdentity(){
 const name=input('display-name').value.trim()||'Commander';
 element('nav-profile').textContent=name;element('profile-name').textContent=name;
 element('profile-avatar').textContent=name.slice(0,2).toUpperCase();
}
function applyPreferences(){
 let accent=localStorage.getItem('s2r-accent')??'amber';if(accent==='purple'){accent='green';localStorage.setItem('s2r-accent',accent);}const density=localStorage.getItem('s2r-density')??'comfortable';
 const colours:Record<string,string>={amber:'#f3cd46',blue:'#6ca7eb',red:'#ee7279',green:'#62cf83'};
 document.documentElement.style.setProperty('--accent',colours[accent]??colours.amber);document.documentElement.style.setProperty('--accent-soft',(colours[accent]??colours.amber)+'1c');
 document.body.dataset.theme=accent;
 input('accent-choice').value=accent;
 document.querySelectorAll<HTMLElement>('[data-theme-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.themeChoice===accent)));element<HTMLSelectElement>('density-choice').value=density;document.body.classList.toggle('compact',density==='compact');
 for(const view of ['tiles','table']){element('view-'+view).classList.toggle('active',view===listView);element('view-'+view).setAttribute('aria-pressed',String(view===listView));}
}
function roomMap(m:GameMap):RoomMap{return {id:m.id,name:m.name,players:m.players,metadataHash:m.metadataHash,...(m.starts?{starts:m.starts}:{})};}
function mapImage(m:RoomMap|null|undefined,missingLabel='MAP CHOSEN IN GAME'):string{
 const image=m?previews.get(m.id.toLowerCase()):null;
 return image?`<img src="${image}" alt="${esc(m!.name)} map preview" loading="lazy">`:`<span class="map-fallback">${esc(m?'PREVIEW UNAVAILABLE':missingLabel)}</span>`;
}
async function requestPreview(id:string){
 const key=id.toLowerCase(),epoch=mapEpoch;
 if(!desktop?.mapPreview||previews.has(key)||previewPending.has(key)||!installedMaps.some(m=>m.id.toLowerCase()===key))return;
 previewPending.add(key);
 try{
  const value=await desktop.mapPreview(id);
  if(epoch!==mapEpoch)return;
  if(previews.size>=80)previews.delete(previews.keys().next().value!);
  previews.set(key,typeof value==='string'&&value.length<500000&&/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value)?value:null);
  previewRevision++;rankedPoolSignature='';lastRooms='';render();showCreateMap();if(!element('page-maps').hidden)renderMaps();renderPool();renderSpawnEditor();
 }catch{if(epoch===mapEpoch)previews.set(key,null);}finally{previewPending.delete(key);}
}
async function scanMaps(){
 if(!desktop?.scanMaps||!localProfile)return;
 const epoch=++mapEpoch;previews.clear();previewPending.clear();
 element('map-scan-status').textContent='Scanning installed map archives…';
 try{
  const result=await desktop.scanMaps();if(epoch!==mapEpoch)return;
  installedMaps=result.maps;
  element('map-scan-status').textContent=`${installedMaps.length} installed skirmish maps found.${result.warnings.length?' Some archives could not be read.':''}`;
  element('map-scan-details').textContent=[result.directory,...result.warnings].join('\n');
  element<HTMLSelectElement>('create-map').innerHTML='<option value="">Choose inside SupCom 2</option>'+installedMaps.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}${m.players?' · '+m.players+' players':''}</option>`).join('');
  mapPage=0;rankedPoolSignature='';lastRoom='';lastRooms='';render();showCreateMap();renderMaps();renderPool();renderSpawnEditor();
 }catch(error){if(epoch===mapEpoch){installedMaps=[];renderMaps();element('map-scan-status').textContent='Could not scan maps: '+String(error);}}
}
function showCreateMap(){
 const m=installedMaps.find(m=>m.id===element<HTMLSelectElement>('create-map').value);

 element('create-map-preview').innerHTML=mapImage(m);element('create-map-info').textContent=m?`${m.players?m.players+' start positions':'Unknown start positions'} · ${m.archive}`:installedMaps.length?'Choose a local map or select it inside the game.':'Choose your game installation to discover maps.';
 input('apply-native-map').checked=!!m;input('apply-native-map').disabled=!m||!desktop?.hostRoom||!localProfile;if(input('apply-native-map').disabled)input('apply-native-map').checked=false;

 if(m)void requestPreview(m.id);
}
function closeCreate(){const d=element<HTMLDialogElement>('create-dialog');if(typeof d.close==='function')d.close();else d.removeAttribute('open');}
function openCreate(){
 if(!token||!snapshot){navigate('profile');status('Connect to a room server first, then create your game.');return;}
 if(snapshot.hosting?.approved===false){navigate('profile');status('Ask your server administrator to approve this account for hosting.',true);return;}
 if(snapshot.room){navigate('play');status('Leave your current lobby before creating another game.');return;}
 navigate('play');element('create-status').hidden=true;input('create-password').value='';element<HTMLSelectElement>('create-faction').value=ownEmail?.preferences?.faction??'UEF';element<HTMLSelectElement>('create-colour').value=ownEmail?.preferences?.colour??'Blue';showCreateMap();input('apply-native-map').checked=!input('apply-native-map').disabled;const d=element<HTMLDialogElement>('create-dialog');if(typeof d.showModal==='function')d.showModal();else d.setAttribute('open','');
 input('create-launch').disabled=!desktop?.hostRoom||!localProfile;input('create-launch').checked=!!desktop?.hostRoom&&!!localProfile;
 if(!input('room-name').value)input('room-name').value=(input('display-name').value||'Commander')+'’s game';input('room-name').focus();
}
async function beginHost(){
 const room=snapshot?.room;if(!desktop?.hostRoom||!room||room.hostId!==snapshot?.playerId)throw new Error('Only the room host can start hosting.');
 status('Preparing your Reforged lobby from the installed game…');
 status((await (desktop.hostIndependentRoom??desktop.hostRoom)({server,token,roomId:room.id,...(snapshot?.room?.map?{applyMap:true}:{})})).message);gameRunning=true;renderSteamRoom();
}
async function joinCurrentGame(){
 const room=snapshot?.room;
 if(desktop?.joinIndependentRoom&&room?.nativeHost){status((await desktop.joinIndependentRoom({server,token,roomId:room.id})).message);gameRunning=true;renderSteamRoom();return;}
 const link=room?.steamLink;if(!desktop||!room||!link)throw new Error('Wait for the host’s live game lobby.');
 const next=await api<Snapshot>('steam-ticket',{linkId:link.id});snapshot=next;render();
 if(next.protocol!==PROTOCOL||next.room?.id!==room.id||next.room?.steamLink?.id!==link.id||next.room.steamLink.lobbyId!==link.lobbyId)throw new Error('The shared lobby changed. Select it and try again.');
 status((await desktop.joinSteamLobby(link.lobbyId,{server,token,roomId:room.id})).message);
}
function renderSelected(){
 const oldPassword=element<HTMLInputElement>('join-password'),passwordState=oldPassword?{room:oldPassword.dataset.room,value:oldPassword.value,focused:document.activeElement===oldPassword,start:oldPassword.selectionStart,end:oldPassword.selectionEnd}:null;
 const match=snapshot?.matches?.find(r=>r.id===selectedRoomId);
 const r=match??snapshot?.rooms.find(r=>r.id===selectedRoomId);
 element('selected-lobby').hidden=!!snapshot?.room&&!match;
 if(!r){element('selected-lobby').innerHTML='<div class="selection-empty"><span class="selection-symbol" aria-hidden="true">⌖</span><h2>Select a game</h2><p>Choose a lobby to see its map, host, and players here.</p></div>';return;}
 if(match){
  const active=match.players.filter(p=>!p.observer),observers=match.players.filter(p=>p.observer);
  element('selected-lobby').innerHTML=`<div class="map-preview">${mapImage(browserMap(match))}<span class="map-preview-caption">Map preview</span></div><div class="lobby-detail-body"><p class="eyebrow">${match.mode==='matchmaking'?'MATCHMAKING':'CUSTOM GAME'} · IN PROGRESS</p><h2>${esc(match.name)}</h2><dl class="detail-grid"><dt>${match.mapSource==='game-lobby'?'Map at launch':'Requested map'}</dt><dd>${esc(browserMapLabel(match))}</dd><dt>Host</dt><dd>${esc(match.host)}</dd><dt>Elapsed</dt><dd class="match-clock" data-match-clock="${esc(match.runId)}">~ ${elapsedLabel(matchSeconds(match))}</dd><dt>Players at start</dt><dd>${match.count}</dd></dl><p class="muted small">Time includes loading and pauses. Late joining is unavailable.</p><div class="team-box"><h3>${match.rosterSource==='game-lobby'?'PLAYERS AT START':'REFORGED PLAYERS AT DETECTION'}</h3>${[...active,...observers].map(p=>`<p class="match-player"><span>${esc(p.name)}</span><span class="muted">${p.observer?'Observer':(p.ai?'AI · ':'')+(match.rosterSource==='game-lobby'?(p.team===-1?'FFA':'Team '+p.team):'')}</span></p>`).join('')}</div><p class="live-minimap-note">Live minimap coming later</p></div>`;
  const map=browserMap(match);if(map)void requestPreview(map.id);return;
 }
 element('selected-lobby').innerHTML=`<div class="map-preview">${mapImage(r.map,r.mapObservedAt?'PREVIEW UNAVAILABLE':undefined)}</div><div class="lobby-detail-body"><p class="eyebrow">${r.nativePhase?'INDEPENDENT NATIVE LOBBY':r.live?'HOST LOBBY LIVE':'GATHERING PLAYERS'}</p><h2>${esc(r.name)}</h2><dl class="detail-grid"><dt>${r.mapObservedAt?'Map in game':'Requested map'}</dt><dd>${esc(r.mapLabel)}</dd><dt>Host</dt><dd>${esc(r.host)}</dd><dt>Players in Reforged</dt><dd>${r.count} / ${r.capacity}</dd></dl>${r.passwordProtected?`<label>Lobby password<input id="join-password" data-room="${esc(r.id)}" type="password" maxlength="64" autocomplete="off"></label>`:''}<button id="join-selected-game" ${!token||!!snapshot?.room||r.count>=r.capacity?'disabled':''}>${desktop&&(r.live||r.nativePhase==='lobby-observed')?'Join game':'Join lobby'}</button>${r.map&&!installedMaps.some(m=>m.id.toLowerCase()===r.map!.id.toLowerCase())?'<p class="muted small">This map was not found in your local catalog.</p>':''}<div class="team-box"><h3>CONNECTED THROUGH S2R</h3>${r.players.map(p=>`<p>${esc(p.name)}</p>`).join('')}</div></div>`;
 if(passwordState?.room===r.id){const field=element<HTMLInputElement>('join-password');if(field){field.value=passwordState.value;if(passwordState.focused){field.focus();field.setSelectionRange(passwordState.start,passwordState.end);}}}
 if(r.map)void requestPreview(r.map.id);
}
element('selected-lobby').addEventListener('click',event=>{
 if(!(event.target as HTMLElement).closest('#join-selected-game'))return;
 const id=selectedRoomId;if(!id)return;
 void task(async()=>{
  const selected=snapshot?.rooms.find(r=>r.id===id);
  if(selected?.live&&desktop&&!localProfile)throw new Error('Choose your SupCom 2 executable in your profile first.');
  await command('join',{roomId:id,password:element<HTMLInputElement>('join-password')?.value??''});navigate('play');
  if(desktop&&localProfile&&(snapshot?.room?.steamLink||snapshot?.room?.nativeHost?.phase==='lobby-observed'))await joinCurrentGame();else status('Joined the lobby. Waiting for the host’s game connection.');
 });
});
document.addEventListener('click',event=>{const link=(event.target as HTMLElement).closest<HTMLElement>('[data-page]');if(link){event.preventDefault();navigate(link.dataset.page!);}});
input('display-name').addEventListener('input',updateIdentity);
for(const id of ['accent-choice','density-choice'])element(id).addEventListener('change',()=>{localStorage.setItem('s2r-accent',element<HTMLSelectElement>('accent-choice').value);localStorage.setItem('s2r-density',element<HTMLSelectElement>('density-choice').value);applyPreferences();});
for(const view of ['tiles','table'])element('view-'+view).addEventListener('click',()=>{listView=view;localStorage.setItem('s2r-view',view);applyPreferences();lastRooms='';render();});
element('room-search').addEventListener('input',()=>render());element('room-sort').addEventListener('change',()=>render());
setInterval(updateMatchClocks,1000);
element('open-create').addEventListener('click',openCreate);element('home-create').addEventListener('click',openCreate);
for(const id of ['close-create','cancel-create'])element(id).addEventListener('click',closeCreate);
element('create-transport').addEventListener('change',showCreateMap);element('create-map').addEventListener('change',showCreateMap);element('rescan-maps').addEventListener('click',()=>void task(scanMaps));
void init();

function renderMaps(){
 const search=input('map-search').value.trim().toLowerCase(),filter=element<HTMLSelectElement>('map-filter').value;
 const maps=installedMaps.filter(m=>m.name.toLowerCase().includes(search)&&(filter==='all'||filter==='large'&&(m.players??0)>8||filter!=='large'&&m.players!==null&&m.players<=Number(filter)&&m.players>(Number(filter)===2?0:Number(filter)-2)));
 const pages=Math.max(1,Math.ceil(maps.length/12));mapPage=Math.min(mapPage,pages-1);
 const visible=maps.slice(mapPage*12,mapPage*12+12);
 element('maps-status').textContent=installedMaps.length?`${maps.length} of ${installedMaps.length} installed maps · Page ${mapPage+1} of ${pages}`:element('map-scan-status').textContent;
 element('map-grid').innerHTML=visible.length?visible.map(m=>`<button class="map-card ${selectedMapId===m.id?'selected':''}" data-map="${esc(m.id)}" aria-pressed="${selectedMapId===m.id}"><span class="map-preview">${mapImage(m)}</span><strong>${esc(m.name)}</strong><span>${m.players?m.players+' start positions':'Unknown start positions'}</span></button>`).join('')+`<div class="map-pagination"><button class="secondary" id="maps-prev" ${mapPage===0?'disabled':''}>Previous</button><span>${mapPage+1} / ${pages}</span><button class="secondary" id="maps-next" ${mapPage+1===pages?'disabled':''}>Next</button></div>`:'<p class="empty">'+(installedMaps.length?'No maps match your filters.':'No maps to display. Choose your game in your profile, then rescan.')+'</p>';
 const m=installedMaps.find(m=>m.id===selectedMapId);
 element('map-details').innerHTML=m?`<div class="map-preview">${mapImage(m)}</div><p class="eyebrow">INSTALLED BATTLEFIELD</p><h2>${esc(m.name)}</h2><p class="muted">${m.players?m.players+' start positions':'Unknown start positions'}</p><p class="muted small">Source: ${esc(m.archive)}</p><button id="host-map" ${m.players!==null&&m.players<2?'disabled':''}>Host on this map</button><p class="muted small">S2R currently supports up to 8 players. Confirm the requested map inside SupCom 2.</p>`:'<h2>Select a map</h2><p class="muted">Choose a map to see its preview and create a game.</p>';
 if(!element('page-maps').hidden){for(const m of visible)void requestPreview(m.id);if(m)void requestPreview(m.id);}
}
function resetMapRepository(){
 mapRepositoryEpoch++;mapRepositoryAbort?.abort();mapRepositoryAbort=null;mapRepositoryPage=null;mapRepositoryScope='';mapRepositoryLoading=false;mapRepositoryBusy=false;mapRepositoryNotice='';clearTimeout(mapRepositorySearchTimer);if(element('map-repository-search'))input('map-repository-search').value='';
 for(const id of ['map-upload-file','map-upload-title','map-upload-description']){const field=element<HTMLInputElement|HTMLTextAreaElement>(id);if(field)field.value='';}
 if(element('map-repository-list')){element('map-repository-list').replaceChildren();element('map-repository-pagination').replaceChildren();element('map-upload-status').textContent='';}
}
function updateMapRepositoryControls(){
 const signed=!!token&&!!accountUser,available=snapshot?.features?.mapRepository===true;
 element<HTMLFieldSetElement>('map-upload-fields').disabled=!signed||!available||mapRepositoryBusy;
 element<HTMLButtonElement>('map-repository-refresh').disabled=!signed||!available||mapRepositoryLoading;
 for(const button of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-map-download],[data-map-delete]')))button.disabled=mapRepositoryBusy;
 if(!mapRepositoryBusy){const field=element('map-upload-status'),reason=!signed?'Sign in with an account to upload maps.':!available?'Update your server to 0.27.16 or newer to use the map repository.':'';if(reason)field.textContent=reason;else if(field.textContent?.startsWith('Sign in with an account')||field.textContent?.startsWith('Update your server'))field.textContent='';}
}
function drawMapRepository(){
 const page=mapRepositoryPage;
 element('map-repository-status').textContent=mapRepositoryLoading?'Loading community maps…':mapRepositoryNotice||(page?`${page.total} map package${page.total===1?'':'s'} · Page ${page.page+1} of ${page.pages}`:'Open the community repository to browse shared maps.');
 element('map-repository-list').innerHTML=page?.packages.length?page.packages.map(p=>`<article class="map-package"><div class="map-package-heading"><span class="map-package-symbol" aria-hidden="true">⌖</span><div><h3>${esc(p.title)}</h3><p class="muted small">Uploaded by ${esc(p.uploader)} · ${esc(new Date(p.uploadedAt).toLocaleDateString())}</p></div><button class="secondary" data-map-download="${esc(p.id)}" ${p.scan?.status==='clean'?'':'disabled'}>${desktop?'Install':'Download'}</button>${p.canDelete?`<button class="secondary danger" data-map-delete="${esc(p.id)}">Delete</button>`:''}</div>${p.scan?.status!=='clean'?`<p class="error small">${esc(p.scan?.message??'Pending malware scan. Downloads are disabled.')}</p>${snapshot?.admin?`<button class="secondary" data-map-rescan="${esc(p.id)}">Scan package</button>`:''}`:`<p class="muted small">Malware scan passed · ${esc(p.scan.engine)}</p>`}${p.description?`<p class="map-package-description">${esc(p.description)}</p>`:''}<div class="map-package-maps">${p.maps.map(m=>`<span>${esc(m.name)} <small>${m.players===null?'Unknown starts':m.players+' starts'}</small></span>`).join('')}</div><div class="map-download-progress" data-map-transfer="${esc(p.id)}" hidden><span></span><progress max="100" value="0" aria-label="Map download progress"></progress></div><p class="muted small">${p.maps.length} map${p.maps.length===1?'':'s'} · ${(p.size/1024/1024).toFixed(2)} MiB · ${esc(p.filename)}</p></article>`).join(''):`<p class="empty">${page?'No map packages found. Share a community map to get started.':mapRepositoryNotice||'Community maps will appear here.'}</p>`;
 element('map-repository-pagination').innerHTML=page&&page.pages>1?`<button id="map-repository-prev" class="secondary" ${page.page===0?'disabled':''}>Previous</button><span>${page.page+1} / ${page.pages}</span><button id="map-repository-next" class="secondary" ${page.page+1>=page.pages?'disabled':''}>Next</button>`:'';
 if(mapTransfer)paintMapTransfer(mapTransfer);updateMapRepositoryControls();
}
async function loadMapRepository(page=0){
 const scope=server+'|'+token;
 if(scope!==mapRepositoryScope){resetMapRepository();mapRepositoryScope=scope;}
 if(!token||!accountUser){mapRepositoryNotice='Sign in with an account to browse community maps.';drawMapRepository();return;}
 if(snapshot?.features?.mapRepository!==true){mapRepositoryNotice='Update your server to 0.27.16 or newer to use the map repository.';drawMapRepository();return;}
 const epoch=++mapRepositoryEpoch;mapRepositoryLoading=true;mapRepositoryNotice='';drawMapRepository();
 try{const params=new URLSearchParams({q:input('map-repository-search').value.trim(),page:String(page)}),result=await api<MapRepositoryPage>('maps/repository?'+params);if(epoch!==mapRepositoryEpoch||scope!==server+'|'+token)return;mapRepositoryPage=result;}
 catch(e){if(epoch===mapRepositoryEpoch&&scope===server+'|'+token)mapRepositoryNotice=(e as Error).message;}
 finally{if(epoch===mapRepositoryEpoch&&scope===server+'|'+token){mapRepositoryLoading=false;drawMapRepository();}}
}
function mapSource(community:boolean){
 element('maps-editor').hidden=true;element('maps-editor-tab').setAttribute('aria-selected','false');element('maps-editor-tab').classList.add('secondary');element('maps-installed').hidden=community;element('maps-community').hidden=!community;element('maps-rescan').hidden=community;
 for(const id of ['maps-installed-tab','maps-community-tab']){const active=(id==='maps-community-tab')===community;element(id).setAttribute('aria-selected',String(active));element(id).classList.toggle('secondary',!active);}
 if(community)void loadMapRepository();else renderMaps();
}
element('maps-editor-tab').addEventListener('click',()=>{for(const id of ['maps-installed','maps-community','maps-rescan'])element(id).hidden=true;element('maps-editor').hidden=false;for(const id of ['maps-installed-tab','maps-community-tab','maps-editor-tab']){const active=id==='maps-editor-tab';element(id).setAttribute('aria-selected',String(active));element(id).classList.toggle('secondary',!active);}});
element('maps-installed-tab').addEventListener('click',()=>mapSource(false));element('maps-community-tab').addEventListener('click',()=>mapSource(true));
element('map-repository-refresh').addEventListener('click',()=>void loadMapRepository(mapRepositoryPage?.page??0));
input('map-repository-search').addEventListener('input',()=>{clearTimeout(mapRepositorySearchTimer);mapRepositorySearchTimer=setTimeout(()=>void loadMapRepository(),250);});
input('map-upload-file').addEventListener('change',()=>{input('map-upload-title').value='';element('map-upload-status').textContent='The map name is read from the package. You can enter a title to override it.';});
element('map-upload-form').addEventListener('submit',event=>{
 event.preventDefault();if(mapRepositoryBusy)return;
 void (async()=>{
  const scope=server+'|'+token,file=input('map-upload-file').files?.[0],title=input('map-upload-title').value.trim(),description=element<HTMLTextAreaElement>('map-upload-description').value.trim();
  if(!file||!/^.+\.(scd|zip)$/i.test(file.name)||!file.size||file.size>MAP_PACKAGE_LIMIT){element('map-upload-status').textContent='Choose an SCD or ZIP map package up to 512 MiB.';return;}
  if(!token||!accountUser||snapshot?.features?.mapRepository!==true)return;
  const requestServer=server,requestToken=token,controller=new AbortController();mapRepositoryAbort=controller;mapRepositoryBusy=true;updateMapRepositoryControls();element('map-upload-status').textContent='Uploading map package…';
  const timeout=setTimeout(()=>controller.abort(),15*60_000);
  try{
   const params=new URLSearchParams({title,description,filename:file.name}),response=await sendMapPackage(requestServer+'/api/maps/upload?'+params,requestToken,file,controller.signal,(sent,total)=>{if(scope===server+'|'+token)element('map-upload-status').textContent=sent>=total?'Checking map names and package…':'Uploading '+Math.floor(sent/total*100)+'% · '+(sent/1024/1024).toFixed(1)+' / '+(total/1024/1024).toFixed(1)+' MiB';}),result=response.result;
   if(scope!==server+'|'+token)return;if(!response.ok)throw Error(result.error??'Map upload failed.');
   input('map-upload-file').value='';input('map-upload-title').value='';element<HTMLTextAreaElement>('map-upload-description').value='';input('map-repository-search').value='';
   element('map-upload-status').textContent=result.duplicate?'This map package is already in the repository.':result.package?.scan?.status==='clean'?'Map package validated, scanned and published.':'Package uploaded to quarantine. It will be available after validation and a malware scan pass.';await loadMapRepository();
  }catch(e){if(scope===server+'|'+token)element('map-upload-status').textContent=controller.signal.aborted?'Map upload stopped. Try again when connected.':(e as Error).message;}
  finally{clearTimeout(timeout);if(scope===server+'|'+token){mapRepositoryBusy=false;mapRepositoryAbort=null;updateMapRepositoryControls();}}
 })();
});
async function downloadMapPackage(p:MapPackage){
 if(mapRepositoryBusy)return;const scope=server+'|'+token,controller=new AbortController();mapRepositoryAbort=controller;mapRepositoryBusy=true;updateMapRepositoryControls();element('map-upload-status').textContent='Downloading '+p.title+'…';const timeout=setTimeout(()=>controller.abort(),15*60_000);
 try{
  if(desktop?.downloadMapPackage){mapDownloadId=p.id;controller.signal.addEventListener('abort',()=>void desktop.cancelMapPackageDownload?.(),{once:true});const result=await desktop.downloadMapPackage({server,token,id:p.id,filename:p.filename,size:p.size});if(scope===server+'|'+token){element('map-upload-status').textContent=result.message;await scanMaps();}return;}
  const response=await fetch(server+'/api/maps/download/'+encodeURIComponent(p.id),{headers:{Authorization:'Bearer '+token},signal:controller.signal,redirect:'error'});
  if(!response.ok){const data=await response.json();throw Error(data.error??'Map download failed.');}if(!response.body)throw Error('Map download is empty.');
  const reader=response.body.getReader(),chunks:ArrayBuffer[]=[];let size=0;
  for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>MAP_PACKAGE_LIMIT||size>p.size){await reader.cancel();throw Error('Map download exceeded its expected size.');}chunks.push(r.value.slice().buffer);}
  if(size!==p.size)throw Error('Map download was incomplete.');const blob=new Blob(chunks,{type:'application/octet-stream'});
  if(crypto.subtle){const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()),hash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');if(hash!==p.id)throw Error('Map download checksum did not match.');}
  if(scope!==server+'|'+token)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=p.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);element('map-upload-status').textContent='Map package downloaded. Install it manually using its map instructions.';
 }catch(e){if(scope===server+'|'+token)element('map-upload-status').textContent=(e as Error).message;}
 finally{clearTimeout(timeout);if(mapTransfer?.stage!=='ready')transferPanel.hidden=true;mapDownloadId='';if(scope===server+'|'+token){mapRepositoryBusy=false;mapRepositoryAbort=null;updateMapRepositoryControls();}}
}
async function deleteMapPackage(p:MapPackage){
 if(mapRepositoryBusy||!p.canDelete||!confirm('Delete “'+p.title+'” from the community repository? This removes the whole package ('+p.maps.length+' maps). Installed copies stay on players’ PCs.'))return;
 const scope=server+'|'+token;mapRepositoryBusy=true;updateMapRepositoryControls();
 try{await api('maps/delete',{id:p.id});if(scope!==server+'|'+token)return;await loadMapRepository(mapRepositoryPage?.page??0);element('map-upload-status').textContent='Deleted '+p.title+' from the repository.';}
 catch(e){if(scope===server+'|'+token)element('map-upload-status').textContent=(e as Error).message;}
 finally{if(scope===server+'|'+token){mapRepositoryBusy=false;updateMapRepositoryControls();}}
}
element('maps-community').addEventListener('click',event=>{
 const target=(event.target as HTMLElement).closest<HTMLElement>('[data-map-download],[data-map-delete],#map-repository-prev,#map-repository-next');if(!target)return;
 if(target.dataset.mapDelete){const item=mapRepositoryPage?.packages.find(p=>p.id===target.dataset.mapDelete);if(item)void deleteMapPackage(item);}else if(target.dataset.mapDownload){const item=mapRepositoryPage?.packages.find(p=>p.id===target.dataset.mapDownload);if(item)void downloadMapPackage(item);}else void loadMapRepository((mapRepositoryPage?.page??0)+(target.id==='map-repository-next'?1:-1));
});
element('map-grid').addEventListener('click',event=>{
 const target=(event.target as HTMLElement).closest<HTMLElement>('[data-map],#maps-prev,#maps-next');if(!target)return;
 if(target.dataset.map)selectedMapId=target.dataset.map;else mapPage+=target.id==='maps-next'?1:-1;renderMaps();
});
element('map-details').addEventListener('click',event=>{if(!(event.target as HTMLElement).closest('#host-map'))return;element<HTMLSelectElement>('create-map').value=selectedMapId;openCreate();});
for(const id of ['map-search','map-filter'])element(id).addEventListener(id==='map-search'?'input':'change',()=>{mapPage=0;renderMaps();});
element('maps-rescan').addEventListener('click',()=>void task(scanMaps));

interface AccountResult {verification?:string;token:string;account:{id:string;username:string};refreshToken?:string}
function renderAccount(){
 const signed=!!token&&!!accountUser;
 element('rename-settings').hidden=!signed;element('use-community-server').hidden=signed||server==='https://supcom2reforged.com';
 element('saved-connection').textContent='Account server: '+server+(/localhost|127\.0\.0\.1|\[::1\]/i.test(server)?' · This address points to this PC. Use the community server or import your host’s connection file.':'');
 element('email-settings').hidden=!signed;element('password-settings').hidden=!signed;element('admin-access').hidden=!signed||!!snapshot?.admin;
 element('import-server-connection').hidden=signed||!desktop?.importServerConnection;
 element('account-form').hidden=signed;element('account-logout').hidden=!signed;
 element('account-status').textContent=signed?'Signed in as '+accountUser+' on '+server:token?'Connected as a test guest. Sign out of the connection before signing in.':'Sign in on your configured S2R server, or create an account.';
 element<HTMLButtonElement>('account-login').disabled=!!token;element<HTMLButtonElement>('account-register').disabled=!!token;
 input('account-remember').disabled=!desktop?.saveAccount;
 const emailStatus=element('email-status');emailStatus.textContent=ownEmail?.email?'Linked email: '+ownEmail.email+(ownEmail.emailVerified?' · Verified':' · Awaiting verification'):'Add an email address to your existing account.';element('resend-verification').hidden=!signed||!ownEmail?.email||ownEmail.emailVerified;element('email-recovery').hidden=signed;

}
async function syncAccountName(account?:{id:string;username:string}){
 if(!account||!accountUser||accountUser===account.username)return;
 accountUser=account.username;sessionStorage.setItem('s2r-account-user',accountUser);localStorage.setItem('supcom2-name',accountUser);
 input('display-name').value=accountUser;input('account-name').value=accountUser;
 if(rememberedToken)await desktop?.saveAccount?.({server,username:accountUser,refreshToken:rememberedToken});
}
async function acceptAccount(result:AccountResult,refresh=''){
 connectionWanted=true;reconnectFailures=0;nextReconnectAt=0;token=result.token;accountUser=result.account.username;rememberedToken=result.refreshToken??refresh;
 sessionStorage.setItem('sc2-token',token);sessionStorage.setItem('sc2-server',server);sessionStorage.setItem('s2r-account-user',accountUser);
 localStorage.setItem('s2r-server',server);localStorage.setItem('supcom2-name',accountUser);input('display-name').value=accountUser;input('account-name').value=accountUser;input('account-password').value='';input('access-key').value='';
 snapshot=await api<Snapshot>('state');ownEmail=await api<{email:string|null;emailVerified:boolean}>('account/profile');input('profile-email').value=ownEmail.email??'';if(!ownEmail.email)element<HTMLDetailsElement>('email-settings').open=true;await uploadProfile();render();void checkClientUpdate(false);
}
async function signIn(register:boolean){
 if(token)throw new Error('Disconnect your current connection before signing in.');
 if(register&&!input('account-email').value.trim())throw new Error('Enter your email address to create an account.');
 server=normaliseServer(input('server-url').value);void checkClientUpdate(false);
 const connection={server,accessKey:input('access-key').value||(savedConnectionServer===server?savedAccessKey:'')};
 const result=await api<AccountResult>('account/'+(register?'register':'login'),{email:register?input('account-email').value:undefined,username:input('account-name').value,password:input('account-password').value,remember:input('account-remember').checked,accessKey:connection.accessKey,protocol:PROTOCOL});
 savedAccessKey=connection.accessKey;savedConnectionServer=connection.server;await acceptAccount(result);
 try{await desktop?.saveConnection?.(connection);}catch{status('Signed in, but the server connection could not be remembered on this PC.',true);}
 if(desktop?.saveAccount)await desktop.saveAccount(rememberedToken?{server,username:result.account.username,refreshToken:rememberedToken}:null);
 status((register?'Account created. ':'')+'Signed in as '+accountUser+'.'+(result.verification==='sent'?' Check your inbox to verify your email.':result.verification==='delivery-failed'?' Verification email could not be delivered; resend from your profile.':''));
}
element('rename-form').addEventListener('submit',event=>{event.preventDefault();void task(async()=>{if(gameRunning)throw Error('Close Supreme Commander 2 before renaming.');const account=await api<{id:string;username:string}>('account/rename',{username:input('rename-name').value,currentPassword:input('rename-password').value});input('rename-password').value='';await syncAccountName(account);snapshot=await api<Snapshot>('state');render();status('Commander name updated to '+account.username+'. Use this name the next time you sign in.');});});
element('account-form').addEventListener('submit',event=>{event.preventDefault();void task(()=>signIn(false));});
element('account-register').addEventListener('click',()=>{if(element<HTMLFormElement>('account-form').reportValidity())void task(()=>signIn(true));});
element('account-logout').addEventListener('click',()=>void task(async()=>{
 connectionWanted=false;reconnectFailures=0;
 await desktop?.saveAccount?.(null);await desktop?.stopHostSharing?.();
 try{await api('account/logout',{refreshToken:rememberedToken});}finally{rememberedToken='';offline();status('Signed out on this PC.');}
}));

document.addEventListener('click',event=>{
 const option=(event.target as HTMLElement).closest<HTMLElement>('[data-theme-choice]');if(option){input('accent-choice').value=option.dataset.themeChoice!;input('accent-choice').dispatchEvent(new Event('change'));}
});
element('email-form').addEventListener('submit',event=>{event.preventDefault();void task(async()=>{const email=input('profile-email').value,currentPassword=input('email-password').value;input('email-password').value='';ownEmail=await api<{email:string|null;emailVerified:boolean}>('account/email',{email,currentPassword});renderAccount();status('Email saved. If server email is configured, check your inbox for a verification link.');});});
element('password-form').addEventListener('submit',event=>{event.preventDefault();void task(async()=>{
 if(input('new-password').value!==input('confirm-password').value)throw new Error('The new passwords do not match.');
 const currentPassword=input('current-password').value,newPassword=input('new-password').value;
 for(const id of ['current-password','new-password','confirm-password'])input(id).value='';
 await api('account/change-password',{currentPassword,newPassword});rememberedToken='';await desktop?.saveAccount?.(null);snapshot=await api<Snapshot>('state');render();status('Password changed. Remembered sign-ins were revoked.');
});});
element('import-admin-setup').addEventListener('click',()=>void task(async()=>{
 if(!desktop?.importAdminSetup)return;status((await desktop.importAdminSetup()).message);showPrivateServer(await desktop.privateServerStatus());
}));
element('admin-unlock-form').addEventListener('submit',event=>{event.preventDefault();void task(async()=>{
 const pin=input('admin-pin').value;input('admin-pin').value='';
 const result=await api<{admin:{expiresAt:string;permanent?:boolean}}>('admin/unlock',{pin});if(snapshot)snapshot.admin=result.admin;
 render();navigate('admin');await loadAdmin();status(result.admin.permanent?'Administrator access saved to your account.':'Administrator access unlocked. Update this server to 0.24.0 to save it to your account.');
});});
element('admin-lock').addEventListener('click',()=>void task(async()=>{await api('admin/lock',{});if(snapshot)snapshot.admin=null;render();navigate('profile');status('Administrator access locked.');}));
element('admin-refresh').addEventListener('click',()=>void task(loadAdmin));
interface AdminDashboard {admin:{expiresAt:string;permanent?:boolean};uptimeSeconds:number;online:{id:string;name:string}[];users:{id:string;username:string;disabled:boolean;hostApproved:boolean;email:string|null;emailVerified:boolean;createdAt:string|null}[];mail?:{configured:boolean;host:string;port:number;secure:boolean;user:string;from:string};release?:{release:{version:string;publishedAt:string}}|null;server?:{mode:string;origin:string|null;requiresAccessKey:boolean;emailVerification:string;version?:string};roomCount:number;lastBackup:{name:string;at:string}|null;audit:{at:string;actor:string;action:string}[];backupProblem?:boolean}
async function loadAdmin(){
 if(!snapshot?.admin)return;
 const [result,,playtests]=await Promise.all([api<AdminDashboard>('admin/status'),loadRankedPool(),api<PlaytestAdmin>('admin/playtests').catch(()=>null)]);adminPlaytests=playtests;
 element('admin-expiry').textContent=result.admin.permanent?'Administrator access · saved to your account':'Access expires at '+new Date(result.admin.expiresAt).toLocaleTimeString();
 adminUsers=result.users;
 const otherUsers=result.users.filter(u=>u.id!==snapshot?.playerId);
 element('admin-dashboard').innerHTML=matchConfirmation(result.users)+serverFeatures(result)+playtestPanel(adminPlaytests)+`<section class="panel"><p class="eyebrow">REFORGED SERVER</p><h2>${result.server?.mode==='public'?'Public community server':'Private community server'}</h2><p class="muted">${esc(result.server?.origin??server)}</p><p class="muted small">This server stores accounts and lists games. All players must select this same server. ${result.server?.mode==='public'?'Public HTTPS sign-in is enabled.':'Your current private connection is retained; public hosting needs a reachable machine and a domain.'}</p>${desktop?.exportPublicServer?'<details><summary>Manage permanent Reforged server</summary><form id="public-server-form" class="stack"><label>Your public server hostname<input id="public-server-domain" placeholder="play.your-domain.com" required maxlength="253" spellcheck="false"></label><div class="actions"><button type="button" id="automatic-public-setup">Set up / upgrade on this PC</button><button class="secondary">Export for another machine</button></div></form><p class="muted small">Automatic setup uses this PC’s Docker and keeps your existing accounts and admin PIN. Export remains available for a separate server machine. A public hostname and TCP 80/443 forwarding are required for outside access.</p></details>':''}</section><div class="admin-stats"><section class="panel admin-stat">Connected clients<strong>${result.online.length}</strong></section><section class="panel admin-stat">Game listings<strong>${result.roomCount}</strong></section><section class="panel admin-stat">Server uptime<strong>${Math.floor(result.uptimeSeconds/60)} min</strong></section></div><section class="panel"><h2>All accounts (${result.users.length})</h2><p class="muted small">Every registered account on this server, including offline and disabled accounts. Email addresses are visible only to their owner and administrators.</p><label>Search accounts<input id="admin-account-search" type="search" placeholder="Username or email"></label><div class="table-wrap"><table><thead><tr><th>USERNAME</th><th>EMAIL</th><th>CREATED</th><th>STATUS</th><th>HOSTING</th><th>ACTIONS</th></tr></thead><tbody>${result.users.map(u=>`<tr><td>${esc(u.username)}${u.id===snapshot?.playerId?' (you)':''}</td><td>${esc(u.email??"Not linked")}<span class="muted small">${u.email?(u.emailVerified?" · Verified":" · Unverified"):""}</span></td><td>${u.createdAt?esc(new Date(u.createdAt).toLocaleDateString()):"Unknown"}</td><td>${u.disabled?'Disabled':result.online.some(p=>p.id===u.id)?'Online':'Offline'}</td><td>${u.hostApproved?'Approved':'Not approved'} <button class="secondary" data-host-approval="${u.hostApproved?'revoke':'approve'}" data-account="${esc(u.id)}">${u.hostApproved?'Revoke':'Approve'}</button></td><td><div class="admin-user-actions"><details><summary>Rename</summary><form data-admin-rename="${esc(u.id)}" class="stack"><label>Commander name<input name="username" value="${esc(u.username)}" minlength="3" maxlength="24" pattern="[A-Za-z0-9_]+" required autocomplete="off"></label><button>Save name</button></form></details>${u.id===snapshot?.playerId?'':`<button class="secondary" data-admin-action="kick" data-account="${esc(u.id)}">Disconnect</button><button class="secondary" data-admin-action="${u.disabled?'enable':'disable'}" data-account="${esc(u.id)}">${u.disabled?'Enable':'Disable'}</button>`}</div></td></tr>`).join('')}</tbody></table></div></section><div class="admin-grid"><section class="panel"><h2>Account backups</h2><p class="muted">Backups stay on the server. The most recent 14 account backups are retained.</p><p>${result.lastBackup?'Last backup: '+esc(new Date(result.lastBackup.at).toLocaleString()):'No backup recorded since this server started.'}</p>${result.backupProblem?'<p class="error">Automatic backup failed. Check the server’s disk and logs.</p>':''}<button id="admin-backup">Back up accounts</button></section><section class="panel"><h2>Recent administration</h2><ul class="admin-audit">${result.audit.map(a=>`<li>${esc(new Date(a.at).toLocaleTimeString())} · ${esc(a.action)}</li>`).join('')||'<li>No recent actions.</li>'}</ul></section></div><section class="panel admin-reset"><h2>Reset an account password</h2><p class="muted small">Use this to help an account owner recover access. It revokes their remembered sign-ins and disconnects their current session.</p><form id="admin-reset-form" class="stack"><label>Account<select id="admin-reset-user" required><option value="">Choose an account</option>${otherUsers.map(u=>`<option value="${esc(u.id)}">${esc(u.username)}</option>`).join('')}</select></label><label>New password<input id="admin-reset-password" type="password" minlength="9" maxlength="128" required autocomplete="new-password"></label><label>Confirm password<input id="admin-reset-confirm" type="password" minlength="9" maxlength="128" required autocomplete="new-password"></label><button ${!otherUsers.length?'disabled':''}>Reset password</button></form></section>`;
}
element('admin-dashboard').addEventListener('input',event=>{if((event.target as HTMLElement).id!=='admin-account-search')return;const q=input('admin-account-search').value.trim().toLowerCase();for(const row of Array.from(element('admin-dashboard').querySelectorAll('tbody tr')))row.toggleAttribute('hidden',!row.textContent?.toLowerCase().includes(q));});
element('admin-dashboard').addEventListener('input',event=>{
 const target=event.target as HTMLElement;if(!['playtest-filter','playtest-search'].includes(target.id)||!adminPlaytests)return;
 element('playtest-review-list').innerHTML=playtestCards(adminPlaytests,element<HTMLSelectElement>('playtest-filter').value,input('playtest-search').value);
});
element('admin-dashboard').addEventListener('click',event=>{
 const action=(event.target as HTMLElement).closest<HTMLElement>('[data-playtest-review],[data-playtest-open]');if(!action)return;
 void task(async()=>{if(action.dataset.playtestReview)await api('admin/playtests/review',{accountId:action.dataset.account,status:action.dataset.playtestReview,expectedRevision:Number(action.dataset.revision)});else await api('admin/playtests/settings',{applicationsOpen:action.dataset.playtestOpen==='true',expectedRevision:Number(action.dataset.revision)});await loadAdmin();status('Playtest access updated.');});
});
element('admin-dashboard').addEventListener('submit',event=>{
 if((event.target as HTMLElement).id!=='playtest-grant-form')return;event.preventDefault();
 void task(async()=>{const id=element<HTMLSelectElement>('playtest-grant-account').value;await api('admin/playtests/review',{accountId:id,status:'approved',expectedRevision:adminPlaytests?.applications.find(a=>a.accountId===id)?.revision??0});await loadAdmin();status('Tester approved for client downloads.');});
});
element('admin-dashboard').addEventListener('click',event=>{
 const button=(event.target as HTMLElement).closest<HTMLElement>('[data-admin-action],[data-host-approval],#admin-backup');if(!button)return;
 void task(async()=>{
  if(button.dataset.hostApproval){await api('admin/hosting',{accountId:button.dataset.account,approved:button.dataset.hostApproval==='approve'});snapshot=await api<Snapshot>('state');render();status('Hosting approval updated. Native games already running are not closed.');}
  else if(button.id==='admin-backup'){await api('admin/backup',{});status('Account backup created on the server.');}
  else{await api('admin/moderate',{accountId:button.dataset.account,action:button.dataset.adminAction});status('Account action applied.');}
  await loadAdmin();
 });
});
element('admin-dashboard').addEventListener('submit',event=>{
 const rename=(event.target as HTMLElement).closest<HTMLFormElement>('form[data-admin-rename]');
 if(rename){event.preventDefault();void task(async()=>{const account=await api<{id:string;username:string}>('admin/rename',{accountId:rename.dataset.adminRename,username:rename.querySelector<HTMLInputElement>('[name=username]')!.value});if(account.id===snapshot?.playerId)await syncAccountName(account);status('Commander renamed to '+account.username+'. Ratings and games played retained.');await loadAdmin();});return;}
 if((event.target as HTMLElement).id==='admin-match-form'){event.preventDefault();void task(async()=>{const players=Array.from(element('admin-match-form').querySelectorAll<HTMLInputElement>('[data-result-player]:checked')).map(box=>({accountId:box.dataset.resultPlayer!,rank:Number(element<HTMLInputElement>('result-rank-'+box.dataset.resultPlayer!).value)}));await api('admin/match-result',{matchId:input('result-match-id').value,mode:element<HTMLSelectElement>('result-mode').value,players});status('Completed match recorded. Leaderboard totals updated.');await loadAdmin();});return;}
 if((event.target as HTMLElement).id==='public-server-form'){event.preventDefault();void task(async()=>{if(desktop?.exportPublicServer)status((await desktop.exportPublicServer(input('public-server-domain').value)).message);});return;}
 if((event.target as HTMLElement).id!=='admin-reset-form')return;event.preventDefault();void task(async()=>{
  if(input('admin-reset-password').value!==input('admin-reset-confirm').value)throw new Error('The passwords do not match.');
  const newPassword=input('admin-reset-password').value,accountId=element<HTMLSelectElement>('admin-reset-user').value;
  input('admin-reset-password').value='';input('admin-reset-confirm').value='';await api('admin/reset-password',{accountId,newPassword});await loadAdmin();status('Account password reset. Share the new password privately with its owner.');
 });
});

element('open-server-manager').addEventListener('click',()=>void task(async()=>{if(!desktop?.openServerManager)return;await desktop.openServerManager();awaitingOwnerConnection=true;status('Server Manager opened. An existing saved server starts automatically. Configure once for a new server.');}));
element('use-manager-server').addEventListener('click',()=>void task(async()=>{if(!desktop?.serverManagerConnection)return;const state=await desktop.serverManagerConnection();if(token){connectionWanted=false;await desktop.stopHostSharing();try{await api('disconnect',{});}catch{}offline();}input('server-url').value=state.address!;input('access-key').value=state.accessKey!;savedAccessKey=state.accessKey!;savedConnectionServer=state.address!;await desktop?.saveConnection?.({server:state.address!,accessKey:savedAccessKey});status('Saved server connection selected. Sign in with your existing account.');}));
element('use-community-server').addEventListener('click',()=>void task(async()=>{
 if(token)throw Error('Sign out before changing account servers.');
 connectionWanted=false;awaitingOwnerConnection=false;rememberedToken='';offline();
 server='https://supcom2reforged.com';input('server-url').value=server;input('access-key').value='';savedAccessKey='';savedConnectionServer=server;
 sessionStorage.removeItem('sc2-server');await desktop?.saveAccount?.(null);await desktop?.saveConnection?.({server,accessKey:''});localStorage.setItem('s2r-server',server);
 status('Reforged community server selected. Sign in with your community account.');render();
}));
element('import-server-connection').addEventListener('click',()=>void task(async()=>{if(!desktop?.importServerConnection)return;const invitation=await desktop.importServerConnection();if(!invitation)return;if(token)throw new Error('Sign out before selecting another account server.');input('server-url').value=normaliseServer(invitation.server);input('access-key').value=invitation.accessKey;savedAccessKey=invitation.accessKey;savedConnectionServer=invitation.server;rememberedToken='';await desktop?.saveAccount?.(null);await desktop?.saveConnection?.({server:invitation.server,accessKey:invitation.accessKey});status('Server connection imported and remembered. Sign in or create your account.');}));
element('join-native-probe').addEventListener('click',()=>void task(async()=>{const room=snapshot?.room,run=room?.nativeHost;if(!desktop?.joinNativeRoomProbe||!room||!run||room.hostId===snapshot?.playerId)throw Error('Join a native host test as a guest first.');status((await desktop.joinNativeRoomProbe({server,token,roomId:room.id,runId:run.id,address:input('native-guest-address').value.trim()})).message);gameRunning=true;renderSteamRoom();}));
element('host-native-room').addEventListener('click',()=>void task(async()=>{const room=snapshot?.room;if(!desktop?.hostNativeRoomTest||!room||room.hostId!==snapshot?.playerId)throw Error('Only the current room host can launch this test.');status('Preparing the Reforged native lobby…');status((await desktop.hostNativeRoomTest({server,token,roomId:room.id,...(snapshot?.room?.map?{applyMap:true}:{})})).message);gameRunning=true;renderSteamRoom();}));
element('restore-native-lobby').addEventListener('click',()=>void task(async()=>{if(!desktop?.restoreNativeLobby)throw Error('The desktop client is required.');status((await desktop.restoreNativeLobby()).message);}));
element('launch-udp-test').addEventListener('click',()=>void task(async()=>{if(!desktop?.launchNativeUdpTest)throw new Error('This test requires the desktop client.');status((await desktop.launchNativeUdpTest()).message);gameRunning=true;}));


function showPublicSetup(state:PublicSetupStatus){publicSetupState=state;element('public-setup-message').textContent=state.message;element('public-setup-log').textContent=state.log.join('\n');
 const domain=input('setup-domain');if(state.domain&&(!domain.value||state.running))domain.value=state.domain;domain.disabled=state.running;
 element('public-setup-domain-change').hidden=!state.canResume;element<HTMLButtonElement>('public-setup-domain-change').disabled=state.running;
 element<HTMLButtonElement>('public-setup-start').disabled=state.running;element('public-setup-start').textContent=state.canResume?'Upgrade / check server':'Set up server';
 element<HTMLButtonElement>('public-setup-recheck').disabled=state.running||!state.localReady;element<HTMLButtonElement>('public-setup-files').disabled=!state.canResume;element<HTMLButtonElement>('public-setup-close').disabled=state.running;
 element('public-setup-result').textContent=state.localReady?`${state.accountCount} existing accounts retained. Your client uses the local owner connection. Players use the S2R-Server-Connection.json in the server folder. ${state.httpsReady?'HTTPS answered from this PC; test from another network too.':'Complete DNS and TCP 80/443 forwarding, then recheck HTTPS.'}`:'';
}
async function openPublicSetup(domain=''){if(!desktop?.publicSetupStatus)throw new Error('Install the updated desktop client to use automatic setup.');const state=await desktop.publicSetupStatus();showPublicSetup(state);if(!state.canResume)input('setup-domain').value=domain;element<HTMLDialogElement>('public-setup-dialog').showModal();}
element('admin-dashboard').addEventListener('click',event=>{if((event.target as HTMLElement).closest('#automatic-public-setup'))void task(()=>openPublicSetup(input('public-server-domain').value));});
element('resume-public-setup').addEventListener('click',()=>void task(()=>openPublicSetup()));
element('public-setup-close').addEventListener('click',()=>{if(!publicSetupState?.running)element<HTMLDialogElement>('public-setup-dialog').close();});
element('public-setup-dialog').addEventListener('cancel',event=>{if(publicSetupState?.running)event.preventDefault();});
element('public-setup-start').addEventListener('click',()=>void task(async()=>{if(!desktop?.beginPublicSetup)return;setupConnected=false;showPublicSetup(await desktop.beginPublicSetup({domain:publicSetupState?.canResume?publicSetupState.domain:input('setup-domain').value,server,token}));}));
element('public-setup-domain-change').addEventListener('click',()=>void task(async()=>{if(!desktop?.beginPublicSetup)return;if(!token)throw Error('Sign in and unlock Admin before changing the domain.');setupConnected=false;showPublicSetup(await desktop.beginPublicSetup({domain:input('setup-domain').value,server,token,changeDomain:true}));}));
element('public-setup-recheck').addEventListener('click',()=>void task(async()=>{if(desktop?.recheckPublicSetup)showPublicSetup(await desktop.recheckPublicSetup());}));
element('public-setup-files').addEventListener('click',()=>void task(async()=>{await desktop?.openPublicSetupFolder?.();}));
setInterval(()=>{if(publicSetupPolling||!desktop?.publicSetupStatus||!element<HTMLDialogElement>('public-setup-dialog').open)return;publicSetupPolling=true;void desktop.publicSetupStatus().then(async state=>{showPublicSetup(state);if(!state.running&&state.localReady&&!setupConnected){setupConnected=true;connectionWanted=false;offline();server='http://127.0.0.1:47821';input('server-url').value=server;input('access-key').value='';savedAccessKey='';savedConnectionServer=server;const saved=await desktop?.loadAccount?.();if(saved&&saved.server===server){rememberedToken=saved.refreshToken;await acceptAccount(await api<AccountResult>('account/restore',{refreshToken:saved.refreshToken,protocol:PROTOCOL}),saved.refreshToken);}status('Your account server is ready on this PC. Public HTTPS status is shown in setup.');}}).catch(e=>status((e as Error).message,true)).finally(()=>{publicSetupPolling=false;});},1500);

function serverFeatures(result:AdminDashboard){const m=result.mail;return `<div class="admin-grid"><section class="panel"><h2>Verification and recovery email</h2><p class="muted small">SMTP credentials are stored on the server. Blank password keeps the saved password. Use port 587 with STARTTLS, or 465 with implicit TLS.</p><form id="smtp-form" class="stack"><label>SMTP host<input id="smtp-host" value="${esc(m?.host??'')}" required maxlength="253" autocomplete="off"></label><label>Port<input id="smtp-port" type="number" min="1" max="65535" value="${m?.port??587}" required></label><label class="check-row"><input id="smtp-secure" type="checkbox" ${m?.secure?'checked':''}>Implicit TLS (usually port 465)</label><label>Username<input id="smtp-user" value="${esc(m?.user??'')}" maxlength="254" autocomplete="off"></label><label>SMTP password<input id="smtp-password" type="password" maxlength="1024" autocomplete="new-password" placeholder="${m?.configured?'Saved — leave blank to keep':'Provider SMTP password'}"></label><label>Sender email<input id="smtp-from" type="email" value="${esc(m?.from??'')}" required maxlength="254"></label><button>Save SMTP settings</button><button id="smtp-test" type="button" class="secondary">Send test to my email</button></form></section><section class="panel"><h2>Client releases</h2><p class="muted small">Publish a signed Windows installer for approved playtesters. Public downloads stay closed. Existing accounts and settings stay in place.</p><p>Server version: ${esc(result.server?.version??'older release')}<br>Published client: ${esc(result.release?.release.version??'None')}</p>${desktop?.publishUpdate?'<form id="publish-update-form" class="stack"><label>Installer version<input id="publish-version" required placeholder="0.15.0" pattern="[0-9]+\\.[0-9]+\\.[0-9]+" maxlength="20"></label><label>Release notes<textarea id="publish-notes" maxlength="2000" rows="4"></textarea></label><button>Choose installer and publish</button></form>':'<p>Publish installers from the Reforged desktop client.</p>'}</section></div>`;}
element('admin-dashboard').addEventListener('submit',event=>{
 const rename=(event.target as HTMLElement).closest<HTMLFormElement>('form[data-admin-rename]');
 if(rename){event.preventDefault();void task(async()=>{const account=await api<{id:string;username:string}>('admin/rename',{accountId:rename.dataset.adminRename,username:rename.querySelector<HTMLInputElement>('[name=username]')!.value});if(account.id===snapshot?.playerId)await syncAccountName(account);status('Commander renamed to '+account.username+'. Ratings and games played retained.');await loadAdmin();});return;}
 const id=(event.target as HTMLElement).id;if(id!=='smtp-form'&&id!=='publish-update-form')return;event.preventDefault();void task(async()=>{
  if(id==='smtp-form'){const password=input('smtp-password').value;input('smtp-password').value='';await api('admin/mail',{host:input('smtp-host').value.trim(),port:Number(input('smtp-port').value),secure:input('smtp-secure').checked,user:input('smtp-user').value,password,from:input('smtp-from').value.trim()});}
  else if(desktop?.publishUpdate){status('Uploading client installer…');status((await desktop.publishUpdate({server,token,version:input('publish-version').value.trim(),notes:element<HTMLTextAreaElement>('publish-notes').value})).message);}
  await loadAdmin();if(id==='smtp-form')status('SMTP settings saved. Send a test email to check delivery.');
 });
});
element('admin-dashboard').addEventListener('click',event=>{if((event.target as HTMLElement).closest('#smtp-test'))void task(async()=>{await api('admin/mail-test',{});status('SMTP provider accepted the test email. Check your inbox.');});});
element('resend-verification').addEventListener('click',()=>void task(async()=>{await api('account/resend-verification',{});status('Verification email sent. Check your inbox and spam folder.');}));
element('refresh-email').addEventListener('click',()=>void task(async()=>{ownEmail=await api('account/profile');renderAccount();status(ownEmail?.emailVerified?'Email verified. Password recovery is enabled.':'Email is awaiting verification.');}));
element('recovery-form').addEventListener('submit',event=>{event.preventDefault();void task(async()=>{if(token)throw Error('Sign out before requesting password recovery.');server=normaliseServer(input('server-url').value);await api('account/request-reset',{email:input('recovery-email').value});status('If this is a verified account email, a recovery link will arrive shortly.');});});
async function checkClientUpdate(showResult:boolean){if(!desktop?.checkUpdate)return;try{const result=await desktop.checkUpdate(server,accountUser?token:undefined);element('client-update-banner').hidden=!result.available;if(result.available){element('client-update-label').textContent='Reforged '+result.version+' is available';element('client-update-notes').textContent=result.notes;element('download-client-update').hidden=false;element('install-client-update').hidden=true;}else if(showResult)status(result.accessRequired?'Client updates require a signed-in account with playtest approval.':'Your client is up to date.');}catch(e){if(showResult)throw e;}}
element('download-client-update').addEventListener('click',()=>void task(async()=>{if(!desktop?.downloadUpdate)return;status('Downloading the signed client update…');status((await desktop.downloadUpdate(server,accountUser?token:undefined)).message);element('download-client-update').hidden=true;element('install-client-update').hidden=false;}));
element('install-client-update').addEventListener('click',()=>void task(async()=>{if(gameRunning)throw Error('Close SupCom 2 before installing the client update.');await desktop?.installUpdate?.(server);}));
setInterval(()=>{if(token&&!busy&&!gameRunning)void checkClientUpdate(false);},15*60_000);

element('check-client-update').addEventListener('click',()=>void task(()=>checkClientUpdate(true)));

interface LeaderRow {id:string;name:string;position:number|null;games:number;wins:number;losses:number;rating:number|null}
let leaderboardRows:LeaderRow[]=[];
async function loadLeaderboard(){const result=await api<{players:LeaderRow[]}>('leaderboard?mode='+element<HTMLSelectElement>('leaderboard-mode').value);leaderboardRows=result.players;drawLeaderboard();}
function drawLeaderboard(){const search=input('leaderboard-search').value.trim().toLowerCase(),rows=leaderboardRows.filter(p=>p.name.toLowerCase().includes(search));element('leaderboard-content').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Position</th><th>Commander</th><th>Forge Rating</th><th>Games</th><th>Wins</th><th>Losses</th></tr></thead><tbody>${rows.map(p=>`<tr><td>${p.position??'—'}</td><td>${esc(p.name)}</td><td>${p.rating??'Unrated'}</td><td>${p.games}</td><td>${p.wins}</td><td>${p.losses}</td></tr>`).join('')||'<tr><td colspan="6">No matching commanders.</td></tr>'}</tbody></table></div>`;}
element('leaderboard-refresh').addEventListener('click',()=>void task(loadLeaderboard));element('leaderboard-mode').addEventListener('change',()=>void task(loadLeaderboard));element('leaderboard-search').addEventListener('input',drawLeaderboard);
type ReplayRow={id:string;name:string;size:number;modifiedAt?:string;at?:string;owner?:string;selectedFolder?:boolean};
let localReplayRows:ReplayRow[]=[],communityReplayRows:ReplayRow[]=[];
let replayScan:Awaited<ReturnType<NonNullable<DesktopBridge['replayScanReport']>>>=null;
let localReplayFolder:string|null=null,localReplayError='',communityReplayNotice='',replayLoadId=0;
async function loadReplays(){
 const request=++replayLoadId,auth=token,origin=server;let rows=localReplayRows,folder=localReplayFolder,errorMessage='';communityReplayRows=[];
 communityReplayNotice=auth?'Loading community replays…':'Sign in to browse and share community replays. Local recordings stay available.';
 try{if(desktop?.scanReplays)rows=await desktop.scanReplays();}catch(error){errorMessage=error instanceof Error?error.message:'Could not scan local replay folders.';}
 try{if(desktop?.getReplayFolder)folder=await desktop.getReplayFolder();}catch{/* Existing local rows remain usable if folder preferences cannot be read. */}
 const scan=await desktop?.replayScanReport?.().catch(()=>null);
 if(request!==replayLoadId)return;if(scan)replayScan=scan;localReplayRows=rows;localReplayFolder=folder;localReplayError=errorMessage;drawReplays();
 // Remote availability must not hold the local Watch/folder controls busy.
 if(auth&&auth===token&&origin===server)void(async()=>{try{
  const result=await api<{replays:ReplayRow[]}>('replays');
  if(request!==replayLoadId||auth!==token||origin!==server||!element('community-replays'))return;
  communityReplayRows=result.replays;communityReplayNotice='';drawReplays();
 }catch{
  if(request!==replayLoadId||auth!==token||origin!==server||!element('community-replays'))return;
  communityReplayNotice='Community replays are unavailable. Your local recordings can still be watched.';drawReplays();
 }})();
}
function drawReplays(){const q=input('replay-search').value.trim().toLowerCase(),filter=(p:ReplayRow)=>(p.name+' '+(p.owner??'')).toLowerCase().includes(q);
 const card=(p:ReplayRow,local:boolean)=>`<article class="replay-row"><div><strong>${esc(p.name)}</strong><p class="muted small">${p.owner?esc(p.owner)+' · ':''}${local&&p.selectedFolder!==undefined?(p.selectedFolder?'Chosen folder · ':'Other local folder · '):''}${esc(new Date(p.at??p.modifiedAt!).toLocaleString())} · ${(p.size/1024/1024).toFixed(2)} MiB</p></div><div class="actions">${local&&desktop?.playReplay?`<button data-watch-replay="${esc(p.id)}" ${gameRunning?'disabled':''}>Watch</button>`:''}${local&&desktop?.publishReplay?`<button class="secondary" data-share-replay="${esc(p.id)}" ${gameRunning||!token?'disabled':''}>Share</button>`:''}${!local&&desktop?.downloadReplay?`<button data-download-replay="${esc(p.id)}">Download</button>`:''}</div></article>`;
 element('local-replays').innerHTML=(localReplayError?`<p class="muted" role="status">${esc(localReplayError)}</p>`:'')+(desktop?localReplayRows.filter(filter).map(p=>card(p,true)).join('')||'<p class="muted">No matching local Supreme Commander 2 replays. Choose a replay folder if yours is elsewhere.</p>':'<p class="muted">Open the desktop client to watch local replays.</p>');
 element('community-replays').innerHTML=communityReplayNotice?`<p class="muted">${esc(communityReplayNotice)}</p>`:communityReplayRows.filter(filter).map(p=>card(p,false)).join('')||'<p class="muted">No matching community replays yet.</p>';
 element('replay-folder-path').textContent=localReplayFolder?'Saved folder: '+localReplayFolder:'Checking the default Supreme Commander 2 and Reforged replay folders.';
 const scanText=element('replay-scan-summary');scanText.textContent=replayScan&&replayScan.folder===localReplayFolder?`${replayScan.recognized} recordings recognized in your chosen folder · ${replayScan.candidates} replay files checked · ${replayScan.rejected} unsupported replay files · ${replayScan.unreadable} unreadable files${replayScan.limited?' · scan limit reached':''}`:'';
 refreshDiagnosticsControls();
 element<HTMLButtonElement>('replays-folder').disabled=!desktop?.chooseReplayFolder;

}
element('replays-refresh').addEventListener('click',()=>void task(loadReplays));element('replay-search').addEventListener('input',drawReplays);element('replays-folder').addEventListener('click',()=>void task(async()=>{
 const request=++replayLoadId;const rows=await desktop?.chooseReplayFolder?.();if(request!==replayLoadId)return;
 if(rows){const folder=await desktop?.getReplayFolder?.();if(request!==replayLoadId)return;localReplayRows=rows;localReplayError='';localReplayFolder=folder??null;replayScan=await desktop?.replayScanReport?.()??null;if(request!==replayLoadId)return;drawReplays();}
 else await loadReplays();
}));
element('page-replays').addEventListener('click',event=>{const t=(event.target as HTMLElement).closest<HTMLElement>('[data-watch-replay],[data-share-replay],[data-download-replay]');if(!t)return;void task(async()=>{if(t.dataset.watchReplay&&desktop?.playReplay){status((await desktop.playReplay(t.dataset.watchReplay)).message);gameRunning=true;}else if(t.dataset.shareReplay&&desktop?.publishReplay){status((await desktop.publishReplay({id:t.dataset.shareReplay,server,token})).message);await loadReplays();}else if(t.dataset.downloadReplay&&desktop?.downloadReplay){status((await desktop.downloadReplay({id:t.dataset.downloadReplay,server,token})).message);await loadReplays();}drawReplays();});});

function matchConfirmation(users:AdminDashboard['users']){return `<section class="panel"><details><summary>Confirm a completed match</summary><p class="muted small">Only record results you have checked. These update games and wins; skill ratings remain inactive until automatic result validation is ready.</p><form id="admin-match-form" class="stack"><label>Match ID<input id="result-match-id" required value="${crypto.randomUUID()}" readonly></label><label>Mode<select id="result-mode"><option value="1v1">1v1</option><option value="team">Team</option><option value="ffa">Free for all</option></select></label><div class="table-wrap"><table><thead><tr><th>Played</th><th>Commander</th><th>Finishing rank (1 = winner)</th></tr></thead><tbody>${users.filter(u=>!u.disabled).map(u=>`<tr><td><input type="checkbox" data-result-player="${u.id}"></td><td>${esc(u.username)}</td><td><input id="result-rank-${u.id}" type="number" min="1" max="8" value="2" required></td></tr>`).join('')}</tbody></table></div><label class="check-row"><input type="checkbox" required>I have verified the participants and result.</label><button>Record completed match</button></form></details></section>`;}

function fillPlayerPreferences(){element<HTMLSelectElement>('preferred-faction').value=ownEmail?.preferences?.faction??'UEF';element<HTMLSelectElement>('preferred-colour').value=ownEmail?.preferences?.colour??'Blue';}
element('player-preferences').addEventListener('submit',event=>{event.preventDefault();void task(async()=>{ownEmail=await api('account/preferences',{faction:element<HTMLSelectElement>('preferred-faction').value,colour:element<HTMLSelectElement>('preferred-colour').value});element('preferences-status').textContent='Preferences saved.';});});
for(const name of ['custom','matchmaking','coop'])element('tab-'+name).addEventListener('click',()=>{for(const panel of ['custom','matchmaking','coop'])element('play-'+panel).hidden=name!==panel;element('room-count').hidden=name!=='custom';for(const other of ['custom','matchmaking','coop']){element('tab-'+other).setAttribute('aria-selected',String(name===other));element('tab-'+other).classList.toggle('secondary',name!==other);}});
async function loadFriends(){const auth=token;const data=await api<{friends:{id:string;name:string;status:string;online?:boolean}[]}>('friends');if(auth!==token)return;socialFriends=data.friends.filter(f=>f.status==='friend');updateChatChannels();element('friends-list').innerHTML=data.friends.map(f=>`<div class="friend-row"><span>${esc(f.name)} <small>${f.status==='friend'?f.online?'Online':'Offline':f.status==='incoming'?'Wants to be friends':'Request sent'}</small></span><div>${f.status==='incoming'?`<button data-friend-action="accept" data-friend="${f.id}">Accept</button>`:''}${f.status==='friend'?`<button class="secondary" data-chat-friend="${f.id}">Chat</button>`:''}<button class="secondary" data-friend-action="remove" data-friend="${f.id}">${f.status==='friend'?'Remove':f.status==='incoming'?'Decline':'Cancel'}</button></div></div>`).join('')||'<p class="muted">No friends yet. Add a commander by name.</p>';}
element('friends-refresh').addEventListener('click',()=>void task(loadFriends));
element('friend-request-form').addEventListener('submit',event=>{event.preventDefault();void task(async()=>{await api('friends',{action:'request',username:input('friend-name').value});input('friend-name').value='';await loadFriends();});});
element('friends-list').addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLElement>('[data-friend-action]');if(button)void task(async()=>{await api('friends',{action:button.dataset.friendAction,accountId:button.dataset.friend});await loadFriends();});});

// Secondary navigation moves existing panels once, without rebuilding live forms.
let profileTab='profile';
const profileSections:Record<string,HTMLElement[]>={profile:[],preferences:[],settings:[],friends:[],statistics:[]};
const profileLayout=element('page-profile').querySelector<HTMLElement>('.profile-layout')!;
const sectionOf=(id:string)=>element(id).closest<HTMLElement>('section.panel')!;
profileSections.profile=[element('profile-account-slot')];
profileSections.preferences=[sectionOf('player-preferences'),sectionOf('accent-choice')];
profileSections.settings=[sectionOf('check-client-update'),sectionOf('choose-game'),element('profile-connection-slot')];
profileSections.friends=[sectionOf('friends-list')];
profileSections.statistics=[element('profile-statistics')];
for(const [name,panels]of Object.entries(profileSections)){const group=document.createElement('div');group.className='profile-tab-panel';group.dataset.profilePanel=name;group.hidden=name!==profileTab;for(const panel of panels)group.append(panel);profileLayout.append(group);}
for(const empty of Array.from(profileLayout.children))if(!empty.hasAttribute('data-profile-panel'))(empty as HTMLElement).hidden=true;
function selectProfileTab(name:string){if(!profileSections[name])return;profileTab=name;document.querySelectorAll<HTMLElement>('[data-profile-panel]').forEach(p=>p.hidden=p.dataset.profilePanel!==name);document.querySelectorAll<HTMLElement>('[data-profile-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.profileTab===name)));element('page-profile').querySelector<HTMLElement>('.profile-banner')!.hidden=name!=='profile';if(name==='friends'&&accountUser)void refreshSocial();if((name==='profile'||name==='statistics')&&accountUser)void loadMatchStatistics();}
document.querySelectorAll<HTMLElement>('[data-profile-tab]').forEach(b=>b.addEventListener('click',()=>selectProfileTab(b.dataset.profileTab!)));
for(const id of ['preferred-colour','create-colour']){const select=element<HTMLSelectElement>(id);select.innerHTML=COLOUR_DEFINITIONS.map(c=>`<option value="${esc(c.name)}">${esc("label" in c?c.label:c.name)}</option>`).join('');}
let socialFriends:{id:string;name:string}[]=[],chatTo='',chatEpoch=0,chatBusy=false,chatKey='';
const chatPanel=document.createElement('section');chatPanel.className='panel social-chat';chatPanel.innerHTML='<div class="section-heading"><h2>Chat</h2><select id="social-channel" aria-label="Chat channel"><option value="">Global</option></select></div><p id="social-chat-status" class="muted small" role="status"></p><div id="social-messages" role="log" aria-label="Messages" aria-live="polite"></div><form id="social-chat-form" class="inline-form"><label class="sr-only" for="social-chat-text">Message</label><input id="social-chat-text" maxlength="1000" placeholder="Message Global" required autocomplete="off"><button>Send</button></form>';
profileSections.friends[0].parentElement!.append(chatPanel);
function updateChatChannels(){const select=element<HTMLSelectElement>('social-channel');const signature=JSON.stringify(socialFriends);if(select.dataset.signature===signature)return;select.dataset.signature=signature;select.innerHTML='<option value="">Global</option>'+socialFriends.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');if(chatTo&&!socialFriends.some(f=>f.id===chatTo)){chatTo='';chatEpoch++;}select.value=chatTo;}
function chooseChat(to:string){chatTo=to;chatEpoch++;chatKey='';element<HTMLSelectElement>('social-channel').value=to;input('social-chat-text').placeholder='Message '+(socialFriends.find(f=>f.id===to)?.name??'Global');element('social-messages').replaceChildren();void loadSocialMessages();}
async function loadSocialMessages(){if(!token||!accountUser)return;const epoch=chatEpoch,auth=token;const supported=snapshot?.features?.chat;if(!supported){element('social-chat-status').textContent='Update this Reforged server to 0.24.0 to enable chat.';return;}try{const result=await api<{messages:{id:string;name:string;text:string;at:string}[]}>('chat'+(chatTo?'?to='+encodeURIComponent(chatTo):''));if(epoch!==chatEpoch||auth!==token)return;const key=JSON.stringify(result.messages);if(key===chatKey)return;chatKey=key;const box=element('social-messages'),bottom=box.scrollHeight-box.scrollTop-box.clientHeight<60;box.innerHTML=result.messages.map(m=>`<article><div><strong>${esc(m.name)}</strong><time>${esc(new Date(m.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</time></div><p>${esc(m.text)}</p></article>`).join('')||'<p class="muted">No messages yet.</p>';if(bottom)box.scrollTop=box.scrollHeight;element('social-chat-status').textContent='';}catch(e){if(epoch===chatEpoch)element('social-chat-status').textContent=(e as Error).message;}}
async function refreshSocial(){if(chatBusy)return;chatBusy=true;try{await loadFriends();await loadSocialMessages();}catch(e){element('social-chat-status').textContent=(e as Error).message;}finally{chatBusy=false;}}
element('social-channel').addEventListener('change',()=>chooseChat(element<HTMLSelectElement>('social-channel').value));
element('friends-list').addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLElement>('[data-chat-friend]');if(b)chooseChat(b.dataset.chatFriend!);});
element('social-chat-form').addEventListener('submit',e=>{e.preventDefault();const text=input('social-chat-text').value,to=chatTo;void task(async()=>{await api('chat',{to:to||null,text});if(input('social-chat-text').value===text)input('social-chat-text').value='';await loadSocialMessages();});});
setInterval(()=>{if(currentPage==='profile'&&profileTab==='friends'&&!busy&&token)void refreshSocial();},4000);

let mmQueues=new Set<import('../shared/model').QueueMode>(['1v1']),mmFactions=new Set(['UEF','Cybran','Illuminate']),mmPools:Record<string,RoomMap[]>={},mmViewedPool='1v1';
let partyState:{party:null|{id:string;leader:string;members:{id:string;name:string;ready:boolean;online:boolean}[]};invitations:{id:string;from:string}[]}={party:null,invitations:[]};
let matchmakerBusy=false,matchLaunchId='',matchLaunchError='';
let mmState:import('../shared/model').MatchmakingStatus={phase:'idle'};
function renderMatchmaking(){
 const available=!!desktop?.hostIndependentRoom&&!!desktop?.joinIndependentRoom&&!!accountUser&&snapshot?.features?.rankedLadder===true;
 element<HTMLButtonElement>('mm-find').disabled=!available||gameRunning||mmState.phase==='idle'&&(!!snapshot?.room||!!partyState.party&&partyState.party.leader!==snapshot?.playerId);
 element('mm-retry').hidden=mmState.phase!=='assigned'||!matchLaunchError||gameRunning;
 let text=!available?'Sign in with the desktop client on an updated Reforged server.':mmState.phase==='idle'?'Choose your factions and match types.':mmState.phase==='searching'?'Searching your selected queues…':gameRunning?'Ranked game opened. The battle starts when every player is ready.':mmState.role==='guest'?'Waiting for your opponent’s game to open…':'Opening your game…';
 if(mmState.phase==='searching'&&mmState.canHost===false)text+=' An approved host is required.';
 element('mm-status').textContent=matchLaunchError||text;
 element('mm-player-name').textContent=accountUser??'Commander';element('mm-rating').textContent='Ladder Forge Rating '+(mmState.rating?.rating??0)+' · '+(mmState.rating?.games??0)+' games';
 element('mm-find').textContent=mmState.phase==='idle'?'Start searching':mmState.phase==='assigned'?'Leave match':'Cancel search';
 element('mm-find').classList.toggle('mm-search-cancel',mmState.phase!=='idle');
 const lock=mmState.phase!=='idle';for(const b of Array.from(document.querySelectorAll<HTMLButtonElement>('[data-mm-faction]'))){b.setAttribute('aria-pressed',String(mmFactions.has(b.dataset.mmFaction!)));b.disabled=lock;}
 element('mm-modes').innerHTML=Object.entries(MATCH_QUEUES).map(([key,q])=>{const st=mmState.stats?.[key as import('../shared/model').QueueMode];const incompatible=!!partyState.party&&partyState.party.members.length>1&&(key.startsWith('ffa')||q.teamSize<partyState.party.members.length);return `<article class="mm-mode"><button data-mm-mode="${key}" aria-pressed="${mmQueues.has(key as import('../shared/model').QueueMode)}" ${lock||incompatible?'disabled':''}>${q.label}</button><button class="secondary mm-map-button" data-mm-pool="${key}">Map pool · ${mmPools[key]?.length??0}</button><p>In queue: ${st?.queued??0}<br>Active matches: ${st?.active??0}<br>Oldest search: ${st?.oldestSeconds??0}s</p></article>`;}).join('');
 const party=partyState.party;element('mm-party-members').innerHTML=party?party.members.map(p=>`<span class="mm-party-member">${esc(p.name)}${p.id===party.leader?' · leader':''}<small> · ${p.ready?'Ready':p.online?'Preparing':'Offline'}</small></span>`).join(''):'Playing solo';
 element('mm-party-create').hidden=!!party;element('mm-party-leave').hidden=!party;element('mm-party-invite').hidden=!party||party.leader!==snapshot?.playerId;
 element('mm-party-invitations').innerHTML=partyState.invitations.map(p=>`<button class="secondary" data-mm-party-accept="${esc(p.id)}">Join ${esc(p.from)}’s party</button>`).join('');

}
async function pollMatchmaking(){
 if(matchmakerBusy||!token||!accountUser||snapshot?.features?.rankedLadder!==true)return;
 matchmakerBusy=true;const activeToken=token,activeServer=server;
 try{
  if((currentPage==='play'||currentPage==='admin')&&Date.now()-rankedPoolAt>15000)await loadRankedPool();
  const next=await api<import('../shared/model').MatchmakingStatus>('matchmaking/status');
  if(activeToken!==token||activeServer!==server)return;
  mmState=next;
  if(currentPage==='play'&&!element('play-matchmaking').hidden){
   partyState=await api('matchmaking/party');
   if(next.phase==='idle'&&localProfile&&installedMaps.length)try{partyState=await api('matchmaking/prepare',mmRequest());}catch{/* Missing pool/installation is shown when Search is pressed. */}
  }
  renderMatchmaking();
  if(next.phase!=='assigned'||!next.matchId||!next.roomId||matchLaunchId===next.matchId||gameRunning||!desktop)return;
  const current=await api<Snapshot>('state');
  if(activeToken!==token||activeServer!==server)return;
  if(current.room?.id!==next.roomId||current.room.matchmakingId!==next.matchId)return;
  snapshot=current;render();
  const chosen=next.map;
  if(!chosen||!installedMaps.some(m=>m.id.toLowerCase()===chosen.id.toLowerCase()&&m.metadataHash===chosen.metadataHash))throw Error('The matched map is missing or changed. Rescan maps before retrying.');
  if(next.role==='guest'&&current.room.nativeHost?.phase!=='lobby-observed')return;
  matchLaunchId=next.matchId;matchLaunchError='';
  const context={server,token,roomId:next.roomId,applyMap:true};
  const launched=next.role==='host'?await desktop.hostIndependentRoom!(context):await desktop.joinIndependentRoom!(context);
  gameRunning=true;status(launched.message);renderSteamRoom();renderMatchmaking();
 }catch(error){matchLaunchError=error instanceof Error?error.message:String(error);renderMatchmaking();}
 finally{matchmakerBusy=false;}
}
element('mm-find').addEventListener('click',()=>void task(async()=>{
 if(mmState.phase!=='idle'){mmState=await api('matchmaking/cancel',{matchId:mmState.matchId});matchLaunchError='';matchLaunchId='';renderMatchmaking();return;}
 if(!localProfile||!desktop)throw Error('Choose your Supreme Commander 2 installation first.');
 if(gameRunning||snapshot?.room)throw Error('Close your current game and leave its lobby first.');
 if(!installedMaps.length)await scanMaps();
 matchLaunchError='';matchLaunchId='';
 await loadRankedPool();
 if(desktop.ensureMap){for(const mode of mmQueues)for(const map of mmPools[mode]??[])if(!installedMaps.some(m=>m.id.toLowerCase()===map.id.toLowerCase()&&m.metadataHash===map.metadataHash)){await desktop.ensureMap({server,token,map});await scanMaps();}}
 mmState=await api('matchmaking/join',mmRequest());renderMatchmaking();
}));
element('mm-retry').addEventListener('click',()=>{matchLaunchId='';matchLaunchError='';void pollMatchmaking();});
setInterval(()=>{if(!token){if(mmState.phase!=='idle'){mmState={phase:'idle'};renderMatchmaking();}matchLaunchId='';matchLaunchError='';return;}void pollMatchmaking();},2000);
renderMatchmaking();

function mmRequest(){if(partyState.party&&partyState.party.members.length>1){const size=partyState.party.members.length;mmQueues=new Set([...mmQueues].filter(q=>!q.startsWith('ffa')&&MATCH_QUEUES[q].teamSize>=size));if(!mmQueues.size)mmQueues.add(size<=2?'2v2':size===3?'3v3':'4v4');}return {clientVersion:CLIENT_VERSION,profile:localProfile?.profile,queues:[...mmQueues],factions:[...mmFactions],maps:installedMaps.filter(m=>m.players===null||m.players>=2).slice(0,250).map(({id,name,players,metadataHash})=>({id,name,players,metadataHash}))};}
element('mm-modes').addEventListener('click',e=>{const b=(e.target as HTMLElement).closest<HTMLElement>('[data-mm-mode],[data-mm-pool]');if(!b)return;if(b.dataset.mmMode&&mmState.phase==='idle'){const mode=b.dataset.mmMode as import('../shared/model').QueueMode;if(mmQueues.has(mode)){if(mmQueues.size>1)mmQueues.delete(mode);}else mmQueues.add(mode);renderMatchmaking();}if(b.dataset.mmPool){mmViewedPool=b.dataset.mmPool;renderPool();}});
for(const b of Array.from(document.querySelectorAll<HTMLElement>('[data-mm-faction]')))b.addEventListener('click',()=>{if(mmState.phase!=='idle')return;const f=b.dataset.mmFaction!;if(mmFactions.has(f)){if(mmFactions.size>1)mmFactions.delete(f);}else mmFactions.add(f);renderMatchmaking();});
async function partyAction(action:string,target?:string){partyState=await api('matchmaking/party',{action,target});renderMatchmaking();}
element('mm-party-create').addEventListener('click',()=>void task(()=>partyAction('create')));
element('mm-party-leave').addEventListener('click',()=>void task(()=>partyAction('leave')));
element('mm-party-invite').addEventListener('submit',e=>{e.preventDefault();void task(async()=>{await partyAction('invite',input('mm-party-name').value.trim());input('mm-party-name').value='';});});
element('mm-party-invitations').addEventListener('click',e=>{const id=(e.target as HTMLElement).closest<HTMLElement>('[data-mm-party-accept]')?.dataset.mmPartyAccept;if(id)void task(()=>partyAction('accept',id));});
let rankedPoolAt=0,rankedPoolSignature='';
var poolPreviewObserver:IntersectionObserver|undefined;
const poolDrafts=new Map<string,Map<string,RoomMap>>(),poolDirty=new Set<string>();
let poolSaving=false;
// Keep the editor below account, release and server controls, with stable inputs.
element('page-admin').append(element('mm-pool-admin'));
function poolDraft(mode:string){
 let draft=poolDrafts.get(mode);if(!draft){draft=new Map((mmPools[mode]??[]).map(m=>[m.id.toLowerCase(),m]));poolDrafts.set(mode,draft);}
 for(const [key,map]of draft){const local=installedMaps.find(m=>m.id.toLowerCase()===key);if(local?.metadataHash===map.metadataHash&&local.players===map.players&&local.starts&&map.starts!==local.starts)draft.set(key,{...map,starts:local.starts});}
 return draft;
}
function poolCatalog(mode:string){const maps=new Map(installedMaps.map(m=>[m.id.toLowerCase(),m as RoomMap]));for(const m of mmPools[mode]??[]){const local=maps.get(m.id.toLowerCase());maps.set(m.id.toLowerCase(),local?.metadataHash===m.metadataHash?{...local,...m,starts:local.starts??m.starts}:m);}return [...maps.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));}
function poolSpawnIssue(m:RoomMap,mode:string):string|undefined{
 if(!m.spawnTeams)return;
 const q=MATCH_QUEUES[mode as import('../shared/model').QueueMode],teams=mode.startsWith('ffa')?q.players:2;
 if(!m.starts||m.spawnTeams.length!==m.players)return 'Rescan this map before assigning its starts.';
 if(m.spawnTeams.some((team,slot)=>!Number.isInteger(team)||team<0||team>teams||team>0&&slot>=8))return 'Choose only supported starts and teams.';
 if(Array.from({length:teams},(_,i)=>m.spawnTeams!.filter(team=>team===i+1).length).some(n=>n!==q.teamSize))return `Assign exactly ${q.teamSize} start${q.teamSize===1?'':'s'} to each team.`;
}
function renderPool(){
 const maps=mmPools[mmViewedPool]??[];element('mm-pool-summary').textContent=MATCH_QUEUES[mmViewedPool as import('../shared/model').QueueMode].label+' · '+maps.length+' maps';
 const publicRoot=element('mm-map-list'),publicScroll=publicRoot.scrollTop,publicSignature=JSON.stringify([mmViewedPool,maps,previewRevision]);
 if(publicRoot.dataset.signature!==publicSignature){publicRoot.dataset.signature=publicSignature;
 publicRoot.innerHTML=maps.length?maps.map(m=>`<article class="pool-preview-card"><h3>${esc(m.name)}</h3><div class="pool-spawn-map" data-pool-preview="${esc(m.id)}">${mapImage(m)}${m.starts?.points.map(p=>`<span class="pool-spawn-marker" data-pool-slot="${p.slot}" aria-label="Start ${p.slot+1}: ${m.spawnTeams?.[p.slot]?'Team '+m.spawnTeams[p.slot]:'Native or unused'}">${p.slot+1}</span>`).join('')??''}</div><p class="muted small">${m.spawnTeams?'Selected starts · '+m.spawnTeams.map((t,i)=>t?'Start '+(i+1)+': Team '+t:'').filter(Boolean).join(' · '):'Native start positions'}</p></article>`).join(''):'<p class="muted small">No maps selected for this queue yet.</p>';
 for(const m of maps){const view=Array.from(publicRoot.querySelectorAll<HTMLElement>('[data-pool-preview]')).find(v=>v.dataset.poolPreview===m.id);if(!view||!m.starts)continue;view.style.aspectRatio=m.starts.width+'/'+m.starts.height;for(const p of m.starts.points){const marker=view.querySelector<HTMLElement>('[data-pool-slot="'+p.slot+'"]')!;marker.style.left=p.x/m.starts.width*100+'%';marker.style.top=p.z/m.starts.height*100+'%';marker.style.setProperty('--spawn-color',COLOUR_DEFINITIONS.find(c=>c.name===LADDER_FFA_COLOURS[(m.spawnTeams?.[p.slot]??0)-1])?.rgb??'#687684');}}
 publicRoot.scrollTop=publicScroll;
 }
 for(const m of maps)void requestPreview(m.id);
 const mode=element<HTMLSelectElement>('mm-pool-mode').value as import('../shared/model').QueueMode||'1v1',draft=poolDraft(mode),catalog=poolCatalog(mode),query=input('mm-pool-search').value.trim().toLowerCase();
 const candidates=catalog.filter(m=>(m.name+' '+m.id).toLowerCase().includes(query)),signature=JSON.stringify([mode,candidates,[...draft],query,previewRevision,poolSaving]);if(signature===rankedPoolSignature)return;rankedPoolSignature=signature;
 element('mm-pool-count').textContent=`${candidates.length} of ${catalog.length} maps · ${draft.size} selected`;
 const invalid=[...draft.values()].map(m=>({map:m,issue:poolSpawnIssue(m,mode)})).find(v=>v.issue),notice=element('mm-pool-validation');
 notice.textContent=invalid?`${invalid.map.name}: ${invalid.issue}`:draft.size>32?'Choose up to 32 maps for this queue.':'';notice.hidden=!notice.textContent;
 element<HTMLButtonElement>('mm-pool-save').disabled=!!invalid||draft.size>32||poolSaving;
 element('mm-pool-save').textContent=poolSaving?'Saving pool…':'Save pool';
 renderSpawnEditor();
 const options=element('mm-pool-options'),scroll=options.scrollTop,selectedScroll=element('mm-pool-selected').scrollTop;poolPreviewObserver?.disconnect();options.innerHTML=candidates.map(m=>{const selected=draft.has(m.id.toLowerCase()),eligible=m.players!==null&&m.players>=MATCH_QUEUES[mode].players;return `<article class="pool-map-card" data-pool-map="${esc(m.id)}"><div class="map-preview">${mapImage(m)}</div><div class="pool-map-body"><strong>${esc(m.name)}</strong><span class="muted small">${m.players??'Unknown'} start positions</span><button type="button" class="${selected?'secondary':''}" data-pool-add="${esc(m.id)}" ${selected||!eligible||draft.size>=32?'disabled':''}>${selected?'In pool':!eligible?'Not enough starts':draft.size>=32?'Pool full':'Add to pool'}</button></div></article>`;}).join('');
 const selected=element('mm-pool-selected');selected.innerHTML=[...draft.values()].map(m=>`<article class="pool-selected-map"><div class="map-preview">${mapImage(m)}</div><div><strong>${esc(m.name)}</strong><p class="muted small">${m.spawnTeams?'Custom spawn layout':m.starts?'Native spawns':'Spawn coordinates unavailable'} · ${m.players??'?'} starts</p><div class="actions"><button type="button" class="secondary" data-pool-spawns="${esc(m.id)}" ${!m.starts?'disabled title="Spawn coordinates are unavailable for this saved map. Rescan maps and verify this map version."':''}>Edit</button><button type="button" class="secondary" data-pool-remove="${esc(m.id)}">Remove</button></div></div></article>`).join('')||'<p class="muted small">Add maps from the catalog to build this pool.</p>';
 element('mm-pool-selected-count').textContent=`Selected maps · ${draft.size}/32`;
 options.scrollTop=scroll;selected.scrollTop=selectedScroll;
 if(!element('mm-pool-admin').hidden){for(const m of draft.values())void requestPreview(m.id);if(typeof IntersectionObserver==='function'){poolPreviewObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)void requestPreview((entry.target as HTMLElement).dataset.poolMap!);},{root:options,rootMargin:'160px'});options.querySelectorAll('[data-pool-map]').forEach(card=>poolPreviewObserver!.observe(card));}else for(const m of candidates.slice(0,18))void requestPreview(m.id);}

 if(!candidates.length){const message=document.createElement('p');message.className='muted';message.textContent=catalog.length?'No matching maps.':'Choose your game installation and scan maps in Settings.';options.append(message);}
}
element('mm-pool-mode').innerHTML=Object.entries(MATCH_QUEUES).map(([key,q])=>`<option value="${key}">${q.label}</option>`).join('');
element('mm-pool-mode').addEventListener('change',()=>{spawnMapId='';renderPool();});
element('mm-pool-search').addEventListener('input',renderPool);
element('mm-pool-options').addEventListener('click',e=>{const button=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-pool-add]');if(!button||button.disabled)return;const mode=element<HTMLSelectElement>('mm-pool-mode').value,draft=poolDraft(mode),map=poolCatalog(mode).find(m=>m.id===button.dataset.poolAdd);if(!map||draft.size>=32)return;draft.set(map.id.toLowerCase(),map);poolDirty.add(mode);rankedPoolSignature='';renderPool();});
element('mm-pool-selected').addEventListener('click',e=>{const button=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-pool-remove],[data-pool-spawns]');if(!button||button.disabled)return;const mode=element<HTMLSelectElement>('mm-pool-mode').value,id=button.dataset.poolRemove??button.dataset.poolSpawns!;if(button.dataset.poolRemove){poolDraft(mode).delete(id.toLowerCase());if(spawnMapId===id)spawnMapId='';poolDirty.add(mode);rankedPoolSignature='';renderPool();}else{spawnMapId=id;renderSpawnEditor();element('mm-spawn-editor').scrollIntoView?.({block:'nearest',behavior:'smooth'});}});

async function loadRankedPool(){const pool=await api<{maps:RoomMap[];pools?:Record<string,RoomMap[]>}>('matchmaking/pool');rankedPoolAt=Date.now();mmPools=pool.pools??{'1v1':pool.maps};for(const mode of Object.keys(mmPools))if(!poolDirty.has(mode))poolDrafts.delete(mode);element('mm-pool-admin').hidden=!snapshot?.admin;renderPool();}
element('mm-pool-save').addEventListener('click',()=>void task(async()=>{
 const mode=element<HTMLSelectElement>('mm-pool-mode').value,maps=[...poolDraft(mode).values()],sent=JSON.stringify(maps);
 const invalid=maps.find(m=>poolSpawnIssue(m,mode));if(invalid)throw Error(invalid.name+': '+poolSpawnIssue(invalid,mode));
 poolSaving=true;renderPool();status('Saving '+MATCH_QUEUES[mode as import('../shared/model').QueueMode].label+' map pool…');
 try{
  await api('admin/ranked-pool',{mode,maps});
  const unchanged=JSON.stringify([...(poolDrafts.get(mode)?.values()??[])])===sent;
  if(unchanged){poolDirty.delete(mode);poolDrafts.delete(mode);}
  rankedPoolSignature='';await loadRankedPool();renderMatchmaking();
  status(MATCH_QUEUES[mode as import('../shared/model').QueueMode].label+' map pool saved.'+(unchanged?'':' New edits are not saved.'));
 }finally{poolSaving=false;renderPool();}
}));

var spawnMapId='',spawnPaintTeam=1;
function renderSpawnEditor(){
 const root=element('mm-spawn-editor');if(!root)return;
 const mode=element<HTMLSelectElement>('mm-pool-mode').value as import('../shared/model').QueueMode,entry=poolCatalog(mode).find(m=>m.id===spawnMapId),m=entry?(poolDraft(mode).get(entry.id.toLowerCase())??entry):undefined;
 root.hidden=!m;if(!m)return;const starts=m.starts;if(!starts){root.replaceChildren();return;}
 const spec=MATCH_QUEUES[mode],teams=mode.startsWith('ffa')?spec.players:2,layout=m.spawnTeams,counts=Array.from({length:teams},(_,i)=>layout?.filter(n=>n===i+1).length??0);
 const teamColor=(team:number)=>['#687684','#146fcd','#ff0000','#1bdd1b','#ffe600','#b061fa','#00ffcc','#ff8000','#deddd1'][team]??'#687684';
 const group='Team',issue=poolSpawnIssue(m,mode);if(spawnPaintTeam>teams)spawnPaintTeam=1;
 root.innerHTML=`<div class="section-heading"><h3>${esc(m.name)} · starting positions</h3><button type="button" class="secondary" id="mm-spawn-reset">Use native spawns</button></div><p class="muted small">This layout is saved separately for ${esc(spec.label)}. Assign ${spec.teamSize} start${spec.teamSize===1?'':'s'} per ${group.toLowerCase()}; unused starts stay empty. Players are shuffled within their team's starts.</p><label class="spawn-paint">Assign clicked spawns to<select id="mm-spawn-team"><option value="0" ${spawnPaintTeam===0?'selected':''}>Unused</option>${Array.from({length:teams},(_,i)=>`<option value="${i+1}" ${spawnPaintTeam===i+1?'selected':''}>${group} ${i+1}</option>`).join('')}</select></label><div class="spawn-workspace"><div class="spawn-map">${mapImage(m)}${starts.points.map(p=>`<button type="button" class="spawn-marker" data-spawn-pick="${p.slot}" ${p.slot>=8?'disabled':''} aria-label="Start ${p.slot+1}: ${layout?.[p.slot]?group+' '+layout[p.slot]:'Unused'}">${p.slot+1}</button>`).join('')}</div><div class="spawn-assignments">${starts.points.map(p=>`<label>Start ${p.slot+1}<select data-spawn-slot="${p.slot}" ${p.slot>=8?'disabled':''}><option value="0">Unused</option>${Array.from({length:teams},(_,i)=>`<option value="${i+1}" ${layout?.[p.slot]===i+1?'selected':''}>${group} ${i+1}</option>`).join('')}</select></label>`).join('')}<p id="mm-spawn-status" class="small ${issue?'error':'muted'}" role="status">${layout?counts.map((n,i)=>`${group} ${i+1}: ${n}/${spec.teamSize}`).join(' · ')+(issue?' · '+esc(issue):' · Layout complete. Unused starts will stay empty.'):'Native spawn selection is unrestricted. Assign starts to restrict this map for ladder.'}</p></div></div>`;
 // Assign dynamic geometry through CSSOM; strict CSP blocks style attributes
 // inserted with innerHTML, which otherwise stacks every marker at one corner.
 const map=root.querySelector<HTMLElement>('.spawn-map')!;map.style.aspectRatio=starts.width+'/'+starts.height;
 for(const point of starts.points){const marker=map.querySelector<HTMLButtonElement>('[data-spawn-pick="'+point.slot+'"]')!;marker.style.left=point.x/starts.width*100+'%';marker.style.top=point.z/starts.height*100+'%';marker.style.setProperty('--spawn-color',teamColor(layout?.[point.slot]??0));}
 void requestPreview(m.id);
}
element('mm-pool-options').addEventListener('click',e=>{const id=(e.target as HTMLElement).closest<HTMLElement>('[data-pool-spawns]')?.dataset.poolSpawns;if(id){spawnMapId=id;renderSpawnEditor();}});
function assignPoolSpawn(slot:number,team:number){
 const mode=element<HTMLSelectElement>('mm-pool-mode').value,m=poolDraft(mode).get(spawnMapId.toLowerCase())??poolCatalog(mode).find(m=>m.id===spawnMapId),q=MATCH_QUEUES[mode as import('../shared/model').QueueMode],teams=mode.startsWith('ffa')?q.players:2;
 if(!m?.starts||!Number.isInteger(slot)||slot<0||slot>=8||!m.starts.points.some(p=>p.slot===slot)||!Number.isInteger(team)||team<0||team>teams)return;
 const layout=[...(m.spawnTeams??Array<number>(m.players??0).fill(0))];layout[slot]=team;poolDraft(mode).set(m.id.toLowerCase(),{...m,spawnTeams:layout});poolDirty.add(mode);rankedPoolSignature='';renderPool();
}
element('mm-spawn-editor').addEventListener('change',e=>{const select=e.target as HTMLSelectElement;if(select.id==='mm-spawn-team'){spawnPaintTeam=Number(select.value);return;}if(select.dataset.spawnSlot!==undefined)assignPoolSpawn(Number(select.dataset.spawnSlot),Number(select.value));});
element('mm-spawn-editor').addEventListener('click',e=>{const target=e.target as HTMLElement,pick=target.closest<HTMLButtonElement>('[data-spawn-pick]');if(pick&&!pick.disabled){assignPoolSpawn(Number(pick.dataset.spawnPick),spawnPaintTeam);return;}if(!target.closest('#mm-spawn-reset'))return;const mode=element<HTMLSelectElement>('mm-pool-mode').value,m=poolDraft(mode).get(spawnMapId.toLowerCase());if(m){const {spawnTeams,...rest}=m;poolDraft(mode).set(m.id.toLowerCase(),rest);poolDirty.add(mode);rankedPoolSignature='';renderPool();}});

async function loadMatchStatistics(){
 const request=++statisticsRequest,auth=token;
 if(!auth||!accountUser){element('profile-ratings').textContent='Sign in to view your Forge ratings.';return;}
 try{
  type Row={games:number;wins:number;losses:number;draws:number;winRate:number};
  type Group={rating:{rating:number;games:number};games:number;unknownFactionGames:number;modes:Record<string,Record<string,Row>>};
  const data=await api<{ladder:Group;custom:Group;basis:string}>('account/statistics');if(request!==statisticsRequest||auth!==token)return;
  element('profile-ratings').textContent=`Ladder ${data.ladder.rating.rating.toFixed(1)} · Custom ${data.custom.rating.rating.toFixed(1)} · Forge Rating`;
  element('profile-statistics').innerHTML='<h2>Match statistics</h2><p class="muted small">'+esc(data.basis)+'</p>'+(['ladder','custom']as const).map(kind=>{
   const group=data[kind];return '<section><h3>'+ (kind==='ladder'?'Ladder':'Custom')+' · '+group.games+' confirmed '+(group.games===1?'game':'games')+'</h3>'+Object.entries(group.modes).map(([mode,rows])=>'<h4>'+esc(mode)+'</h4><div class="table-scroll"><table class="statistics-table"><thead><tr><th>Faction</th><th>Games</th><th>Wins</th><th>Losses</th><th>Draws</th><th>Win rate</th></tr></thead><tbody>'+Object.entries(rows).filter(([f,r])=>f!=='UNKNOWN'||r.games>0).map(([f,r])=>'<tr><th>'+esc(f==='ILLUMINATE'?'Aeon / Illuminate':f==='UNKNOWN'?'Unknown':f==='CYBRAN'?'Cybran':f)+'</th><td>'+r.games+'</td><td>'+r.wins+'</td><td>'+r.losses+'</td><td>'+r.draws+'</td><td>'+r.winRate.toFixed(1)+'%</td></tr>').join('')+'</tbody></table></div>').join('')+(group.games?'':'<p class="muted">No confirmed games yet.</p>')+'</section>';
  }).join('');
 }catch(e){if(auth===token){element('profile-ratings').textContent='Forge ratings unavailable on this server.';element('profile-statistics').innerHTML='<h2>Match statistics</h2><p>'+esc((e as Error).message)+'</p>';}}
}

element('map-repository-list').addEventListener('click',event=>{
 const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-map-rescan]');if(!button||!snapshot?.admin)return;
 button.disabled=true;void task(async()=>{await api('maps/rescan',{id:button.dataset.mapRescan});await loadMapRepository(mapRepositoryPage?.page??0);}).finally(()=>{button.disabled=false;});
});
