import {OPTIONAL_RESEARCH_UNITS} from '../shared/research-units';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { stat } from 'node:fs/promises';
import { MailService } from './mail';
import { ReleaseStore } from './releases';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { ApiError, Lobby } from './lobby';
import { Accounts } from './accounts';
import { PROTOCOL, CLIENT_VERSION } from '../shared/model';
import { AdminGate } from './admin';
import {ResearchWorkshopStore} from './research';
import {MapRepository} from './map-repository';
import { isIP } from 'node:net';
import {SocialChat} from './social';
import {Matchmaker} from './matchmaking';
import {RankedLadder} from './ladder';
import {NativeRelay,type RelayGrant} from './native-relay';
import {NativeMeshRelay} from './mesh-relay';
import {MatchHistory,ReplayVault,type MatchMode} from './community';
import {publicUnits,publicChangelog} from './public-site';
import {DownloadTickets} from './download-tickets';

export interface ServerOptions { maps?:MapRepository; research?:ResearchWorkshopStore; ladder?:RankedLadder; history?:MatchHistory; replays?:ReplayVault; host?: string; port?: number; accessKey?: string; lobby?: Lobby; accounts?: Accounts; admin?: AdminGate; publicOrigin?: string;requireHostApproval?:boolean;requireEmail?:boolean;mail?:MailService;releases?:ReleaseStore }
export function makeServer(options: ServerOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  const accessKey = options.accessKey ?? '';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const publicUrl=options.publicOrigin?new URL(options.publicOrigin):null;
  if(publicUrl&&(publicUrl.protocol!=='https:'||publicUrl.origin!==options.publicOrigin||!loopback))throw new Error('Public mode requires an HTTPS origin and a loopback-only backend behind the HTTPS proxy.');
  if (!loopback && accessKey.length < 20) throw new Error('LAN mode requires SC2_ACCESS_KEY of at least 20 characters.');
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', host]);
  if(publicUrl)allowedHosts.add(publicUrl.hostname);
  try {
    for (const entries of Object.values(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === 'IPv4') allowedHosts.add(entry.address);
  } catch { /* Some containers restrict interface enumeration. Explicit host and loopback still work. */ }
  const lobby = options.lobby ?? new Lobby();
  const accounts = options.accounts ?? new Accounts();
  const mapRepository=options.maps??new MapRepository(accounts.directory?path.join(accounts.directory,'maps'):undefined);
  const ladder=options.ladder??new RankedLadder(accounts.directory?path.join(accounts.directory,'ranked-ladder.json'):undefined);
  const research=options.research??new ResearchWorkshopStore(accounts.directory?path.join(accounts.directory,'research-draft.json'):undefined);
  const customLadder=new RankedLadder(accounts.directory?path.join(accounts.directory,'custom-ratings.json'):undefined);
  const matchmaker=new Matchmaker(lobby,Date.now,ladder);
  const admin=options.admin??new AdminGate(),started=Date.now();
  const adminLocked=new Set<string>(),social=new SocialChat(accounts,accounts.directory?path.join(accounts.directory,'chat.json'):undefined);
  const adminState=async(token:string)=>{const id=[...accountSessions].find(([,t])=>t===token)?.[0];return !adminLocked.has(token)&&id&&await accounts.canAdmin(id)?{expiresAt:'9999-12-31T23:59:59.999Z',permanent:true}:admin.status(token);};
  const history=options.history??new MatchHistory(),replays=options.replays??new ReplayVault();
  const mail=options.mail??new MailService(),releases=options.releases;
  const retire=(id:string)=>{const active=accountSessions.get(id);if(active){adminLocked.delete(active);admin.lock(active);lobby.disconnect(active);accountSessions.delete(id);retiredSessions.set(active,Date.now());if(retiredSessions.size>1000)retiredSessions.delete(retiredSessions.keys().next().value!);}};
  async function sendChallenge(id:string,purpose:'verify'|'reset'){
    if(!publicUrl)throw new ApiError(503,'Configure the public HTTPS hostname before sending account links.');
    if(!(await mail.status()).configured)throw new ApiError(503,'Email delivery is not configured. Ask your server administrator.');
    const challenge=await accounts.issueEmailChallenge(id,purpose),link=publicUrl.origin+'/account/'+(purpose==='verify'?'verify':'reset')+'?token='+challenge.token;
    try{await mail.send(challenge.email,purpose==='verify'?'Verify your Reforged email':'Reset your Reforged password',`Hello ${challenge.username},\n\n${purpose==='verify'?'Confirm your email address':'Choose a new password'} using this link:\n${link}\n\nThis link expires in ${purpose==='verify'?'24 hours':'30 minutes'}. If you did not request it, ignore this email.\nSupreme Commander 2: Reforged`);}catch(e){await accounts.cancelEmailChallenge(challenge.token);throw e;}
  }
  async function automaticVerification(id:string){if(!publicUrl||!(await mail.status()).configured)return 'not-configured';try{await sendChallenge(id,'verify');return 'sent';}catch{return 'delivery-failed';}}

  let lastBackup:{name:string;at:string}|null=null,backupProblem=false,backingUp=false;
  async function automaticBackup(){
    if(!accounts.persistent||backingUp||lastBackup&&Date.now()-Date.parse(lastBackup.at)<86400_000)return;
    backingUp=true;try{lastBackup=await accounts.backup();backupProblem=false;}catch{backupProblem=true;console.error('Automatic account backup failed. Check server storage.');}finally{backingUp=false;}
  }
  const audit:{at:string;actor:string;action:string}[]=[];
  const logAdmin=(actor:string,action:string)=>{audit.push({at:new Date().toISOString(),actor,action});if(audit.length>100)audit.shift();};
  const state=async(token:string)=>{
    lobby.snapshot(token);
    const approved=new Set((await accounts.list()).filter(a=>a.hostApproved&&!a.disabled).map(a=>a.id));
    if(options.requireHostApproval)for(const id of lobby.hosts())if(!approved.has(id))lobby.removeHostedRooms(id);
    const current=lobby.snapshot(token),friends=new Set((await accounts.friends(current.playerId)).filter(f=>f.status==='friend').map(f=>f.id));current.rooms=current.rooms.filter(r=>!r.friendsOnly||r.hostId===current.playerId||friends.has(r.hostId!));
    current.matches=current.matches?.filter(r=>!r.friendsOnly||r.hostId===current.playerId||friends.has(r.hostId!));
    const account=accountSessions.get(current.playerId)===token?await accounts.profile(current.playerId):null;
    return {...current,...(account?{account:{id:account.id,username:account.username}}:{}),serverVersion:CLIENT_VERSION,features:{rankedLadder:true,managedLobbies:true,privateLobbies:true,social:true,chat:true,nativePreferences:true,lobbyBalance:true,matchmaking:true,lobbyMapSync:true,mapRepository:mapRepository.configured},admin:await adminState(token),hosting:{approvalRequired:!!options.requireHostApproval,approved:!options.requireHostApproval||approved.has([...accountSessions].find(([,t])=>t===token)?.[0]??'')}};
  };
  const renamingAccounts=new Set<string>(),renamingNames=new Set<string>();
  const retiredSessions=new Map<string,number>();
  const accountSessions = new Map<string,string>();
  const downloadTickets=new DownloadTickets();
  const downloadAccount=(value:string|undefined)=>{
    if(!value)throw new ApiError(401,'Sign in with an approved playtest account to download the client.');
    if(retiredSessions.has(value))throw new ApiError(401,'Sign in again.');
    const id=[...accountSessions].find(([,t])=>t===value)?.[0];
    if(!id||lobby.snapshot(value).playerId!==id)throw new ApiError(401,'Sign in again.');
    return id;
  };
  const accountRates = new Map<string,{since:number;count:number}>();
  const roomRates=new Map<string,{since:number;count:number}>();
  const rates = new Map<string, { since: number; count: number }>();
  const assets = new Map([
    ['/public/site.js', ['client/public-site.js', 'text/javascript; charset=utf-8']],
    ['/public/site.css', ['client/public-site.css', 'text/css; charset=utf-8']],
    ['/client/index.html', ['client/index.html', 'text/html; charset=utf-8']],
    ['/client/client.js', ['client/client.js', 'text/javascript; charset=utf-8']],
    ['/client/style.css', ['client/style.css', 'text/css; charset=utf-8']],
    ['/client/map-upload.js', ['client/map-upload.js', 'text/javascript; charset=utf-8']],
    ['/client/research-workshop.js', ['client/research-workshop.js', 'text/javascript; charset=utf-8']],
    ['/shared/research.js', ['shared/research.js', 'text/javascript; charset=utf-8']],
    ['/shared/research-units.js', ['shared/research-units.js', 'text/javascript; charset=utf-8']],
    ['/shared/model.js', ['shared/model.js', 'text/javascript; charset=utf-8']]
  ]);
  for (const name of ['s2r-logo','uef','illuminate','cybran','uef-ac1k','uef-fatboy','illuminate-commander','cybran-loyalist']) assets.set(`/client/assets/${name}.png`, [`client/assets/${name}.png`, 'image/png']);
  for(const name of ['battlefield','yellow','green','red','blue'])assets.set(`/client/assets/site-${name}.webp`,[`client/assets/site-${name}.webp`,'image/webp']);
  for(const unit of OPTIONAL_RESEARCH_UNITS)assets.set('/client/assets/units/'+unit.id+'.png',['client/assets/units/'+unit.id+'.png','image/png']);
  assets.set('/client/playtest-admin.js',['client/playtest-admin.js','text/javascript; charset=utf-8']);
  const authorizeRelay=async(token:string,roomId:unknown,runId:unknown):Promise<RelayGrant>=>{
    if(retiredSessions.has(token))throw new ApiError(401,'Sign in again.');
    const current=await state(token),account=[...accountSessions].find(([,t])=>t===token)?.[0],room=current.room;
    if(!account||account!==current.playerId)throw new ApiError(403,'A signed-in Reforged account is required.');
    if(!room||room.id!==roomId||!room.nativeHost||room.nativeHost.id!==runId||Date.parse(room.nativeHost.expiresAt)<=Date.now()||room.steamLink)throw new ApiError(409,'Native room changed or expired.');
    const role=room.hostId===current.playerId?'host':'guest';
    return {roomId:room.id,runId:room.nativeHost.id,playerId:current.playerId,role,ready:room.nativeHost.phase==='lobby-observed'};
  };
  const relay=new NativeRelay(authorizeRelay),mesh=new NativeMeshRelay(authorizeRelay);
  async function renameAccount(actor:string,id:string,body:Record<string,unknown>,verifyPassword:boolean){
    const username=accounts.username(body.username),key=username.toLowerCase();
    if(renamingAccounts.has(id)||renamingNames.has(key))throw new ApiError(409,'An account rename is already in progress.');
    renamingAccounts.add(id);renamingNames.add(key);lobby.setRenaming(id,true);
    try{
      lobby.assertRenameAllowed(id,username);matchmaker.assertRenameAllowed(id);
      const before=await accounts.profile(id);
      if(verifyPassword)try{await accounts.login(before.username,body.currentPassword);}catch(e){if(e instanceof ApiError&&e.status===401)throw new ApiError(400,'Current password is incorrect.');throw e;}
      // Requests already awaiting I/O may have entered a room before the lock.
      lobby.assertRenameAllowed(id,username);matchmaker.assertRenameAllowed(id);
      const account=await accounts.rename(id,username);
      lobby.renameAccount(id,username);matchmaker.forgetPrepared(id);
      logAdmin(actor,'Renamed '+before.username+' to '+username);
      return account;
    }finally{renamingAccounts.delete(id);renamingNames.delete(key);lobby.setRenaming(id,false);}
  }
  let activeRequests=0;const idleWaiters=new Set<()=>void>();
  let scanStopping=false;const startupScan=mapRepository.scanStored(()=>!scanStopping).catch(()=>{});
  const server = Object.assign(createServer(async (req, res) => {
    activeRequests++;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' http: https:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const hostname = new URL(`http://${req.headers.host ?? ''}`).hostname;
      if (!allowedHosts.has(hostname)) throw new ApiError(403, 'Host is not allowed. Use this computer’s IP address.');
      const origin = req.headers.origin;
      // file:// Electron renderer has Origin null. Credentials are explicit bearer tokens.
      if (origin && origin !== 'null' && origin !== (publicUrl?.origin??`http://${req.headers.host}`)) throw new ApiError(403, 'Origin is not allowed.');
      if (origin === 'null') res.setHeader('Access-Control-Allow-Origin', 'null');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      await ladder.load();await customLadder.load();customLadder.importConfirmed(await history.confirmed(),await accounts.list());await customLadder.flush();
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && ['/', '/games', '/units', '/changelog', '/download','/playtest'].includes(url.pathname)) {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(await readFile(path.resolve(__dirname,'../../web/client/public-site.html')));return;}
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [asset, mime] = assets.get(url.pathname)!;
        const content = await readFile(path.resolve(__dirname, '../../web', asset));
        res.writeHead(200, { 'Content-Type': mime }); res.end(content); return;
      }
      if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { ok: true, kind: 'private-test-lobby',protocol:PROTOCOL,version:CLIENT_VERSION,public:!!publicUrl,origin:publicUrl?.origin??null,requiresAccount:!!publicUrl||!!options.requireHostApproval,requiresAccessKey:!!accessKey,requiresEmail:!!options.requireEmail,emailConfigured:(await mail.status()).configured,updates:!!releases,nativeRelay:'s2r-native-v1' }); return; }
      let ip = req.socket.remoteAddress ?? 'unknown';
      const proxyPeer=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip),forwarded=req.headers['x-s2r-client-ip'];
      if(publicUrl&&proxyPeer&&typeof forwarded==='string'&&isIP(forwarded))ip=forwarded;
      const now = Date.now();
      let bucket = rates.get(ip);
      if (!bucket || now - bucket.since > 60_000) { bucket = { since: now, count: 0 }; rates.set(ip, bucket); }
      if (++bucket.count > 1200) throw new ApiError(429, 'Too many requests. Wait one minute.');
      if (rates.size > 1000) for (const [key, value] of rates) if (now - value.since > 60_000) rates.delete(key);
      const accountRate=()=>{let a=accountRates.get(ip);if(!a||now-a.since>60_000){a={since:now,count:0};accountRates.set(ip,a);}if(++a.count>12)throw new ApiError(429,'Too many account requests. Wait one minute.');if(accountRates.size>1000)for(const [k,v]of accountRates)if(now-v.since>60_000)accountRates.delete(k);};
      if(req.method==='GET'&&url.pathname==='/api/releases/latest'){
        if(!releases)throw new ApiError(404,'Updates are not configured on this server.');
        const bearer=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1],allowed=!!bearer&&await accounts.canDownload(downloadAccount(bearer));
        json(res,200,{latest:allowed?await releases.latest():null,publicKey:await releases.key(),accessRequired:!allowed});return;
      }
      const download=url.pathname.match(/^\/updates\/([a-f0-9]{64})\.exe$/);
      if(req.method==='GET'&&download&&releases){
        const bearer=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1],ticket=bearer?null:downloadTickets.take(url.searchParams.get('ticket'),download[1]);
        const id=bearer?downloadAccount(bearer):ticket&&accountSessions.get(ticket.accountId)===ticket.session?downloadAccount(ticket.session):downloadAccount(undefined);
        if(!await accounts.canDownload(id))throw new ApiError(403,'Client downloads are limited to approved playtesters.');
        const file=releases.artifact(download[1]);let info;try{info=await stat(file);}catch{throw new ApiError(404,'Release not found.');}res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':info.size,'Content-Disposition':'attachment; filename="S2R-Setup.exe"'});await pipeline(createReadStream(file),res);return;
      }
      if(url.pathname==='/account/verify'||url.pathname==='/account/reset'){
        accountRate();const reset=url.pathname.endsWith('reset');
        if(req.method==='GET'){const key=url.searchParams.get('token')??'';if(!/^[a-f0-9]{64}$/.test(key))throw new ApiError(400,'Invalid account link.');html(res,`<h1>${reset?'Reset password':'Verify email'}</h1><form method="post"><input type="hidden" name="token" value="${key}">${reset?'<label>New password <input type="password" name="password" minlength="9" maxlength="128" required autocomplete="new-password"></label><p><label>Confirm password <input type="password" name="confirm" minlength="9" maxlength="128" required autocomplete="new-password"></label></p>':''}<button>${reset?'Save password':'Confirm email'}</button></form>`);return;}
        if(req.method==='POST'){const form=await readForm(req);if(reset){if(form.password!==form.confirm)throw new ApiError(400,'Passwords do not match.');const result=await accounts.resetPassword(form.token,form.password);retire(result.accountId);}else await accounts.verifyEmail(form.token);html(res,`<h1>${reset?'Password updated':'Email verified'}</h1><p>Return to Reforged ${reset?'and sign in with your new password':'and refresh your profile'}.</p>`);return;}
      }
      if(req.method==='POST'&&url.pathname==='/api/account/request-reset'){
        accountRate();const body=await readJson(req);if(!publicUrl||!(await mail.status()).configured)throw new ApiError(503,'Email recovery is not configured on this server.');const id=await accounts.recoveryAccount(body.email);if(id)try{await sendChallenge(id,'reset');}catch{}json(res,200,{ok:true,message:'If this is a verified account email, a recovery link will arrive shortly.'});return;
      }
      const accountAction = url.pathname.match(/^\/api\/account\/(register|login|restore|logout)$/)?.[1];
      if (req.method === 'POST' && accountAction) {
        let attempts=accountRates.get(ip);
        if(!attempts||now-attempts.since>60_000){attempts={since:now,count:0};accountRates.set(ip,attempts);}
        if(++attempts.count>12)throw new ApiError(429,'Too many account requests. Wait one minute.');
        if(accountRates.size>1000)for(const [key,value] of accountRates)if(now-value.since>60_000)accountRates.delete(key);
        const body=await readJson(req);
        if(accountAction==='logout'){
          await accounts.revoke(body.refreshToken);
          const current=req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
          if(current){adminLocked.delete(current);admin.lock(current);lobby.disconnect(current);for(const [id,value] of accountSessions)if(value===current)accountSessions.delete(id);}
          json(res,200,{ok:true});return;
        }
        if(body.protocol!==PROTOCOL)throw new ApiError(409,'Client/server protocol mismatch. Use compatible Reforged clients and server (protocol 9).');
        if(accountAction!=='restore'&&accessKey&&body.accessKey!==accessKey)throw new ApiError(403,'Incorrect server access key.');
        if(accountAction==='register'&&options.requireEmail&&typeof body.email!=='string')throw new ApiError(400,'An email address is required to create an account.');
        const account=accountAction==='restore'?await accounts.restore(body.refreshToken):accountAction==='register'?await accounts.register(body.username,body.password,body.email):await accounts.login(body.username,body.password);
        if(renamingAccounts.has(account.id))throw new ApiError(409,'Account name is being updated. Try again shortly.');
        account.username=(await accounts.profile(account.id)).username;
        // One live room session per account; signing in elsewhere retires the old session.
        const previous=accountSessions.get(account.id);if(previous){adminLocked.delete(previous);admin.lock(previous);lobby.disconnect(previous);retiredSessions.set(previous,now);if(retiredSessions.size>1000)retiredSessions.delete(retiredSessions.keys().next().value!);}
        if(renamingAccounts.has(account.id))throw new ApiError(409,'Account name is being updated. Try again shortly.');
        const session=lobby.connect(account.username,body.protocol,account.id);accountSessions.set(account.id,session.token);
        const refreshToken=body.remember===true?await accounts.remember(account.id):undefined;
        if(accountAction==='register')await automaticBackup();
        json(res,accountAction==='register'?201:200,{...session,account,refreshToken,...(accountAction==='register'?{verification:await automaticVerification(account.id)}:{})});return;
      }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        if(publicUrl||options.requireHostApproval)throw new ApiError(403,'This server requires an account. Sign in or create one.');
        const body = await readJson(req);
        if (accessKey && body.accessKey !== accessKey) throw new ApiError(403, 'Incorrect server access key.');
        if(typeof body.name==='string'&&renamingNames.has(body.name.toLowerCase()))throw new ApiError(409,'That name is being updated. Try again shortly.');
        if(await accounts.registered(body.name))throw new ApiError(409,'That name belongs to an account. Sign in with its password.');
        json(res, 201, lobby.connect(body.name, body.protocol)); return;
      }
      if(req.method==='GET'&&url.pathname==='/api/public/overview'){
        const approved=options.requireHostApproval?new Set((await accounts.list()).filter(a=>a.hostApproved&&!a.disabled).map(a=>a.id)):undefined;
        json(res,200,{version:CLIENT_VERSION,at:new Date().toISOString(),...lobby.publicGames(approved),release:null,playtest:await accounts.playtestPublic()});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/public/units'){json(res,200,await publicUnits(research));return;}
      if(req.method==='GET'&&url.pathname==='/api/public/changelog'){json(res,200,await publicChangelog());return;}
      const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) throw new ApiError(401, 'Connect first.');
      if(retiredSessions.has(token))throw new ApiError(401,'Account signed in elsewhere. Sign in again.');
      const activeAccount=[...accountSessions].find(([,t])=>t===token)?.[0];
      if(activeAccount&&renamingAccounts.has(activeAccount))throw new ApiError(409,'Account name is being updated. Try again shortly.');
      if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, await state(token)); return; }
      if (req.method === 'POST' && url.pathname === '/api/disconnect') { adminLocked.delete(token);admin.lock(token);lobby.disconnect(token);for(const [id,t]of accountSessions)if(t===token)accountSessions.delete(id);json(res, 200, { ok: true }); return; }
      const accountId=()=>{
        const current=lobby.snapshot(token),id=[...accountSessions].find(([,t])=>t===token)?.[0];
        if(!id||id!==current.playerId)throw new ApiError(403,'Sign in to an account first.');return id;
      };
      if(req.method==='GET'&&url.pathname==='/api/account/playtest'){
        const profile=await accounts.playtestProfile(accountId());json(res,200,{...profile,release:profile.canDownload&&releases?(await releases.latest())?.release??null:null});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/account/playtest'){
        const id=accountId();accountRate();json(res,201,await accounts.applyForPlaytest(id,await readJson(req)));return;
      }
      if(req.method==='POST'&&url.pathname==='/api/account/playtest/download-ticket'){
        const id=accountId();accountRate();await readJson(req);if(!await accounts.canDownload(id))throw new ApiError(403,'Client downloads are limited to approved playtesters.');
        const release=releases?(await releases.latest())?.release:null;if(!release)throw new ApiError(404,'No playtest installer is available yet.');
        const ticket=downloadTickets.issue(id,token,release.sha256);json(res,200,{path:release.path+'?ticket='+ticket,expiresIn:60});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/lobby-balance'){
        accountId();const current=lobby.snapshot(token),room=current.room;if(!room)throw new ApiError(409,'Join a lobby first.');const known=new Set((await accounts.list()).filter(a=>!a.disabled).map(a=>a.id));
        json(res,200,{roomId:room.id,rankedRequested:room.rankedRequested===true,...(room.matchmakingId?{ladder:{matchId:room.matchmakingId,map:room.map,localName:room.players.find(p=>p.id===current.playerId)?.name,players:room.players.map(p=>({name:p.name,team:p.team,colour:p.colour,faction:p.faction,startPosition:p.startPosition})),role:room.hostId===current.playerId?'host':'guest'}}:{}),rankedEligible:!!room.matchmakingId,ratingName:'Forge Rating',status:'active',reason:'OpenSkill ratings; provisional until more games are recorded.',source:room.matchmakingId?'ladder':'custom',players:await Promise.all(room.players.map(async p=>{const r=room.matchmakingId?ladder.rating(p.id):customLadder.rating(p.id);return {name:p.name,games:known.has(p.id)?r.games:null,rating:known.has(p.id)?r.rating:null,uncertainty:known.has(p.id)?r.sigma:null,strength:known.has(p.id)?r.strength:null};})),notice:'These are Reforged account records, not a verified native team roster. No win prediction or automatic team changes.'});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/leaderboard'){accountId();const mode=url.searchParams.get('mode')??'1v1';if(!['ladder','custom','1v1','team','ffa'].includes(mode))throw new ApiError(400,'Choose Ladder or Custom.');json(res,200,mode==='1v1'||mode==='ladder'?ladder.leaderboard(await accounts.list()):mode==='custom'?{...customLadder.leaderboard(await accounts.list()),mode:'custom',ratingName:'Custom Forge Rating'}:await history.leaderboard(mode as MatchMode,await accounts.list()));return;}
      if(req.method==='POST'&&url.pathname==='/api/custom/register'){
        const id=accountId(),body=await readJson(req),current=lobby.snapshot(token),room=current.room,actualMap=room?.observedMap?room.observedMap.map:room?.map;
        if(!room||room.matchmakingId||room.hostId!==id||!room.nativeHost||room.nativeHost.phase==='battle-observed'||!actualMap||room.nativeHost.id!==body.runId)throw new ApiError(409,'This custom run changed or already started.');
        if(body.mapId!==undefined&&(typeof body.mapId!=='string'||body.mapId.toLowerCase()!==actualMap.id.toLowerCase()))throw new ApiError(409,'Waiting for the game lobby map to synchronize.');
        const roster=body.players as {name:string;team:number}[];
        if(!Array.isArray(roster)||roster.length!==room.players.length||roster.length<2||roster.length>8||new Set(roster.map(p=>typeof p?.name==='string'?p.name.toLowerCase():null)).size!==roster.length||roster.some(p=>!p||typeof p.name!=='string'||!Number.isInteger(p.team)||p.team<1||p.team>16||!room.players.some(q=>q.name.toLowerCase()===p.name.toLowerCase())))throw new ApiError(400,'Only a complete human account roster can be rated.');
        const teams=new Set(roster.map(p=>p.team));if(teams.size<2)throw new ApiError(400,'At least two opposing teams are required.');
        customLadder.registerCustom(body.runId as string,room.players.map(p=>({id:p.id,name:p.name,team:roster.find(q=>q.name.toLowerCase()===p.name.toLowerCase())!.team})),actualMap,teams.size>2?'ffa'+roster.length as import('../shared/model').QueueMode:roster.length===2?'1v1':(roster.length/2+'v'+roster.length/2) as import('../shared/model').QueueMode);await customLadder.flush();json(res,200,{registered:true});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/custom/report'){const id=accountId(),body=await readJson(req);json(res,200,await customLadder.reportEvents(body.matchId,id,body.events));return;}
      if(req.method==='GET'&&url.pathname==='/api/maps/repository'){const id=accountId();json(res,200,await mapRepository.list(url.searchParams.get('q')??'',Number(url.searchParams.get('page')??0),{id,admin:!!await adminState(token)}));return;}
      if(req.method==='POST'&&url.pathname==='/api/maps/rescan'){accountId();if(!await adminState(token))throw new ApiError(403,'Administrator access required.');const body=await readJson(req);json(res,200,{package:await mapRepository.rescan(body.id)});return;}
      if(req.method==='POST'&&url.pathname==='/api/maps/delete'){
        const id=accountId(),body=await readJson(req);
        if(typeof body.id!=='string')throw new ApiError(400,'Choose a map package to delete.');
        const removed=await mapRepository.remove(body.id,id,async()=>{if(accountId()!==id)throw new ApiError(403,'Map account changed.');return !!await adminState(token);});
        logAdmin(id,'Deleted community map package '+removed.title+' ('+removed.id+')');json(res,200,{removed:removed.id});return;
      }
      if(req.method==='GET'&&url.pathname==='/api/maps/resolve'){accountId();json(res,200,{package:await mapRepository.resolve(url.searchParams.get('map')??'',url.searchParams.get('hash')??'')});return;}
      if(req.method==='POST'&&url.pathname==='/api/maps/upload'){
        const id=accountId();if(req.headers['content-type']!=='application/octet-stream')throw new ApiError(415,'Upload an SCD or ZIP map package.');
        const declared=req.headers['content-length'];if(declared!==undefined&&(!Number.isSafeInteger(Number(declared))||Number(declared)<0||Number(declared)>mapRepository.maxBytes))throw new ApiError(413,'Map package exceeds the upload size limit.');
        const who=await accounts.profile(id),result=await mapRepository.upload(req,{title:url.searchParams.get('title'),description:url.searchParams.get('description')??'',filename:url.searchParams.get('filename')},id,who.username,async()=>{if(accountId()!==id)throw new ApiError(403,'Map upload account changed.');});
        json(res,result.duplicate?200:201,result);return;
      }
      if(req.method==='GET'&&url.pathname.startsWith('/api/maps/download/')){
        accountId();const item=await mapRepository.get(url.pathname.slice('/api/maps/download/'.length)),extension=item.package.filename.toLowerCase().endsWith('.zip')?'zip':'scd';
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':item.package.size,'Content-Disposition':'attachment; filename="Reforged-Map-'+item.package.id.slice(0,12)+'.'+extension+'"'});await pipeline(createReadStream(item.file),res);return;
      }
      if(url.pathname.startsWith('/api/replays/provenance/')){
       const id=accountId(),replayId=url.pathname.slice('/api/replays/provenance/'.length);
       if(req.method==='GET'){json(res,200,{metadata:await replays.metadata(replayId)});return;}
       if(req.method==='POST'){json(res,200,await replays.saveMetadata(replayId,await readJson(req,8_388_608),id));return;}
      }
      if(req.method==='GET'&&url.pathname==='/api/replays'){accountId();json(res,200,{replays:await replays.list()});return;}
      if(req.method==='POST'&&url.pathname==='/api/replays/upload'){const id=accountId();if(req.headers['content-type']!=='application/octet-stream')throw new ApiError(415,'Upload a replay file.');const who=await accounts.profile(id);json(res,201,await replays.upload(req,url.searchParams.get('name'),id,who.username));return;}
      if(req.method==='GET'&&url.pathname.startsWith('/api/replays/download/')){accountId();const item=await replays.get(url.pathname.slice('/api/replays/download/'.length)),extension=/\.sc2replaydlc$/i.test(item.record.name)?'SC2ReplayDLC':'SC2Replay';res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':item.record.size,'X-Reforged-Replay-Extension':extension,'Content-Disposition':'attachment; filename="'+item.record.id+'.'+extension+'"'});await pipeline(createReadStream(item.file),res);return;}
      if(url.pathname.startsWith('/api/matchmaking/')){
        accountId();const approved=(await state(token)).hosting.approved;
        if(req.method==='GET'&&url.pathname==='/api/matchmaking/pool'){json(res,200,{maps:ladder.getPool(),pools:ladder.getPools()});return;}
        if(req.method==='GET'&&url.pathname==='/api/matchmaking/party'){json(res,200,matchmaker.party(token));return;}
        if(req.method==='GET'&&url.pathname==='/api/matchmaking/status'){const value=matchmaker.status(token,approved);await ladder.flush();json(res,200,value);return;}
        if(req.method==='POST'){
          const body=await readJson(req,131072);
          if(url.pathname==='/api/matchmaking/prepare'){json(res,200,matchmaker.prepare(token,body,approved));return;}
          if(url.pathname==='/api/matchmaking/party'){json(res,200,matchmaker.party(token,String(body.action),body.target));return;}
          if(url.pathname==='/api/matchmaking/join'){const user=await accounts.profile(accountId());lobby.setPreferred(token,user.preferences);const value=matchmaker.join(token,body,approved);await ladder.flush();json(res,200,value);return;}
          if(url.pathname==='/api/matchmaking/report'){json(res,200,body.events?await ladder.reportEvents(body.matchId,accountId(),body.events):await ladder.report(body.matchId,accountId(),body.ranks??body.winner));return;}
          if(url.pathname==='/api/matchmaking/accept')throw new ApiError(409,'Ranked matches now start automatically. Update both clients.');
          if(url.pathname==='/api/matchmaking/cancel'){json(res,200,matchmaker.cancel(token,body.matchId));return;}
        }
        throw new ApiError(404,'Unknown matchmaking action.');
      }
      if(req.method==='POST'&&url.pathname==='/api/native-mesh/ticket'){accountId();json(res,200,await mesh.issue(token,await readJson(req)));return;}
      if(req.method==='POST'&&url.pathname==='/api/native-relay/ticket'){accountId();json(res,200,await relay.issue(token,await readJson(req)));return;}
      if(req.method==='GET'&&url.pathname==='/api/friends'){const id=accountId(),online=new Set(lobby.presence().map(p=>p.id));json(res,200,{friends:(await accounts.friends(id)).map(f=>({...f,online:online.has(f.id)}))});return;}
      if(req.method==='GET'&&url.pathname==='/api/chat'){json(res,200,{messages:await social.list(accountId(),url.searchParams.get('to'))});return;}
      if(req.method==='POST'&&url.pathname==='/api/chat'){json(res,201,await social.send(accountId(),await readJson(req)));return;}
      if(req.method==='POST'&&url.pathname==='/api/friends'){json(res,200,{friends:await accounts.friendship(accountId(),await readJson(req))});return;}
      if(req.method==='POST'&&url.pathname==='/api/account/rename'){
        accountRate();const id=accountId(),body=await readJson(req);
        json(res,200,await renameAccount(id,id,body,true));return;
      }
      if(req.method==='POST'&&url.pathname==='/api/account/preferences'){json(res,200,await accounts.preferences(accountId(),await readJson(req)));return;}
      if(req.method==='GET'&&url.pathname==='/api/account/statistics'){const id=accountId();await Promise.all([ladder.load(),customLadder.load()]);json(res,200,{ladder:ladder.statistics(id),custom:customLadder.statistics(id),basis:'Confirmed results; factions recorded at battle start. Older results without faction evidence are shown as Unknown.'});return;}
      if(req.method==='GET'&&url.pathname==='/api/account/profile'){json(res,200,await accounts.profile(accountId()));return;}
      if(req.method==='POST'&&url.pathname==='/api/account/email'){
        let attempts=accountRates.get(ip);if(!attempts||now-attempts.since>60_000){attempts={since:now,count:0};accountRates.set(ip,attempts);}if(++attempts.count>12)throw new ApiError(429,'Too many account requests. Wait one minute.');
        const id=accountId(),body=await readJson(req),user=await accounts.profile(id);
        try{await accounts.login(user.username,body.currentPassword);}catch(e){if(e instanceof ApiError&&e.status===401)throw new ApiError(400,'Current password is incorrect.');throw e;}
        const profile=await accounts.setEmail(id,body.email);logAdmin(id,'Account email updated');json(res,200,{...profile,verification:await automaticVerification(id)});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/account/resend-verification'){accountRate();const id=accountId();await readJson(req);await sendChallenge(id,'verify');json(res,200,{ok:true});return;}
      if(req.method==='POST'&&url.pathname==='/api/account/change-password'){
        let attempts=accountRates.get(ip);if(!attempts||now-attempts.since>60_000){attempts={since:now,count:0};accountRates.set(ip,attempts);}
        if(++attempts.count>12)throw new ApiError(429,'Too many account requests. Wait one minute.');
        const id=accountId(),body=await readJson(req),user=(await accounts.list()).find(a=>a.id===id)!;
        try{await accounts.login(user.username,body.currentPassword);}catch(e){if(e instanceof ApiError&&e.status===401)throw new ApiError(400,'Current password is incorrect.');throw e;}
        await accounts.changePassword(id,body.newPassword);adminLocked.add(token);admin.lock(token);json(res,200,{ok:true});return;
      }
      if(url.pathname.startsWith('/api/admin/')){
        const id=accountId();
        if(req.method==='POST'&&url.pathname==='/api/admin/unlock'){
          const body=await readJson(req);await admin.unlock(token,body.pin,id,ip,(await accounts.profile(id)).username);await accounts.grantAdmin(id);adminLocked.delete(token);if(!await accounts.canHost(id))await accounts.approveHost(id,true);logAdmin(id,'Persistent administrator access granted');json(res,200,{admin:await adminState(token)});return;
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/lock'){adminLocked.add(token);admin.lock(token);json(res,200,{ok:true});return;}
        if(!await adminState(token))throw new ApiError(403,'Unlock administrator access first.');
        if(req.method==='GET'&&url.pathname==='/api/admin/playtests'){json(res,200,await accounts.playtestAdmin());return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/playtests/settings'){
          const body=await readJson(req),result=await accounts.setPlaytestApplications(body.applicationsOpen,body.expectedRevision);logAdmin(id,'Playtest applications '+(body.applicationsOpen?'opened':'closed'));json(res,200,result);return;
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/playtests/review'){
          const body=await readJson(req),result=await accounts.reviewPlaytest(id,body);logAdmin(id,'Playtest '+body.status+' for '+body.accountId);json(res,200,result);return;
        }
        if(req.method==='GET'&&url.pathname==='/api/admin/status'){
          json(res,200,{admin:await adminState(token),protocol:PROTOCOL,server:{mode:publicUrl?'public':'private',origin:publicUrl?.origin??null,requiresAccessKey:!!accessKey,emailVerification:(await mail.status()).configured?'configured':'not-configured',version:CLIENT_VERSION},mail:await mail.status(),release:releases?await releases.latest():null,uptimeSeconds:Math.floor((Date.now()-started)/1000),online:lobby.presence(),users:await accounts.list(),roomCount:lobby.snapshot(token).rooms.length,lastBackup,backupProblem,audit:audit.slice(-30)});return;
        }
        if(url.pathname.startsWith('/api/admin/research')&&!url.pathname.startsWith('/api/admin/research/v2'))throw new ApiError(409,'Update the client to 0.27.13 or newer to use this research editor.');
        if(req.method==='GET'&&url.pathname==='/api/admin/research/v2/reference'){json(res,200,await research.getReference());return;}
        if(req.method==='GET'&&url.pathname==='/api/admin/research/v2'){json(res,200,await research.get());return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/research/v2'){const body=await readJson(req,8388608);const result=await research.save(body.draft,body.expectedRevision,body.apply===true);logAdmin(id,'Saved research revision '+result.revision+(body.apply===true?' for new custom games':' as draft'));json(res,200,result);return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/research/v2/reset'){const body=await readJson(req);const result=await research.reset(body.expectedRevision);logAdmin(id,'Restored original Supreme Commander 2 research reference draft');json(res,200,result);return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/ranked-pool'){const body=await readJson(req,131072);const maps=await ladder.setPool(body.maps,(body.mode??'1v1') as import('../shared/model').QueueMode);logAdmin(id,'Ranked map pool updated');json(res,200,{maps});return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/match-result'){await history.confirm(await readJson(req),id,new Set((await accounts.list()).map(a=>a.id)));logAdmin(id,'Confirmed match result');json(res,200,{ok:true});return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/mail'){const settings=await mail.configure(await readJson(req));logAdmin(id,'SMTP settings updated');json(res,200,settings);return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/mail-test'){await readJson(req);const profile=await accounts.profile(id);if(!profile.email)throw new ApiError(400,'Link your own email first.');await mail.send(profile.email,'Reforged SMTP test','Your Supreme Commander 2: Reforged server can send email.');json(res,200,{ok:true});return;}
        if(req.method==='POST'&&url.pathname.startsWith('/api/admin/releases/')){if(!releases)throw new ApiError(503,'Release storage is not configured.');if(req.headers['content-type']!=='application/octet-stream')throw new ApiError(415,'Upload an installer as application/octet-stream.');const version=url.pathname.slice('/api/admin/releases/'.length);const release=await releases.publish(version,url.searchParams.get('notes')??'',req);logAdmin(id,'Published client '+version);json(res,201,release);return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/hosting'){
          const body=await readJson(req);if(typeof body.accountId!=='string'||typeof body.approved!=='boolean')throw new ApiError(400,'Choose an account and a hosting approval.');
          await accounts.approveHost(body.accountId,body.approved);if(!body.approved)lobby.removeHostedRooms(body.accountId);logAdmin(id,(body.approved?'Approved hosting for ':'Revoked hosting for ')+body.accountId);json(res,200,{ok:true});return;
        }
        if(req.method==='POST'&&url.pathname==='/api/admin/rename'){accountRate();const body=await readJson(req);if(typeof body.accountId!=='string')throw new ApiError(400,'Choose an account.');json(res,200,await renameAccount(id,body.accountId,body,false));return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/backup'){lastBackup=await accounts.backup();backupProblem=false;logAdmin(id,'Account backup created');json(res,200,{backup:lastBackup});return;}
        if(req.method==='POST'&&['/api/admin/moderate','/api/admin/reset-password'].includes(url.pathname)){
          const body=await readJson(req),user=(await accounts.list()).find(a=>a.id===body.accountId);
          if(!user)throw new ApiError(404,'Account not found.');
          if(user.id===id)throw new ApiError(400,'Use your own account settings to change your password; you cannot moderate yourself.');
          if(url.pathname.endsWith('reset-password')){await accounts.changePassword(user.id,body.newPassword);logAdmin(id,'Password reset for '+user.username);}
          else if(body.action==='disable'||body.action==='enable'){if(body.action==='disable')lobby.removeHostedRooms(user.id);await accounts.setDisabled(user.id,body.action==='disable');logAdmin(id,(body.action==='disable'?'Disabled ':'Enabled ')+user.username);}
          else if(body.action==='kick'){await accounts.revokeAccount(user.id);logAdmin(id,'Disconnected '+user.username);}
          else throw new ApiError(400,'Unknown moderation action.');
          const active=accountSessions.get(user.id);if(active){adminLocked.delete(active);admin.lock(active);lobby.disconnect(active);accountSessions.delete(user.id);}
          json(res,200,{ok:true});return;
        }
        throw new ApiError(404,'Administrator action not found.');
      }
      if(req.method==='GET'&&url.pathname.startsWith('/api/research/rulesets/')){accountId();json(res,200,await research.getRuleset(url.pathname.slice('/api/research/rulesets/'.length)));return;}
      const action = url.pathname.match(/^\/api\/(create|join|leave|game-closed|lobby-map|lobby-options|profile|player|settings|ready|chat|prepare|native-start|native-pulse|native-stop|native-ticket|steam-publish|steam-auto|steam-clear|steam-ticket)$/)?.[1];
      if(req.method==='POST'&&action){
        if(options.requireHostApproval&&['create','steam-auto','steam-publish','settings','prepare','native-start','native-pulse','lobby-map'].includes(action)&&!await accounts.canHost(accountId()))throw new ApiError(403,'Hosting approval is required. Ask your server administrator to approve this account.');
        const body=await readJson(req);if(['player','settings','lobby-options'].includes(action)&&lobby.snapshot(token).room?.matchmakingId)throw new ApiError(409,'The ladder controls this match’s players, map and rules.');if(action==='create'||action==='join'){let attempts=roomRates.get(ip);if(!attempts||Date.now()-attempts.since>60000){attempts={since:Date.now(),count:0};roomRates.set(ip,attempts);}if(++attempts.count>30)throw new ApiError(429,'Too many room requests. Wait one minute.');if(roomRates.size>1000)for(const [key,value]of roomRates)if(Date.now()-value.since>60000)roomRates.delete(key);}
        if(action==='join'){const id=lobby.snapshot(token).playerId,room=lobby.snapshot(token).rooms.find(r=>r.id===body.roomId);if(!room)throw new ApiError(404,'Lobby unavailable.');if(room.friendsOnly&&room.hostId!==id&&!(await accounts.friends(id)).some(f=>f.id===room.hostId&&f.status==='friend'))throw new ApiError(403,'This lobby is only available to the host’s friends.');}
        if(action==='create'||action==='join'){const id=lobby.snapshot(token).playerId;const user=(await accounts.list()).find(a=>a.id===id);if(user){const p=await accounts.profile(id);lobby.setPreferred(token,{faction:action==='create'?body.faction??p.preferences.faction:p.preferences.faction,colour:action==='create'?body.colour??p.preferences.colour:p.preferences.colour});}}
        const researchId=action==='create'?await research.activeId():action==='join'?lobby.snapshot(token).rooms.find(r=>r.id===body.roomId)?.researchId:undefined;
        if(researchId&&body.researchSupported!==true)throw new ApiError(409,'Update to Reforged 0.27.29 or newer for this server’s research rules.');
        lobby.act(token,action,body);if(action==='create')lobby.pinResearch(token,researchId);json(res,200,await state(token));return;
      }
      throw new ApiError(404, 'Endpoint not found.');
    } catch (error) {
      if (error instanceof ApiError) json(res, error.status, { error: error.message });
      else { console.error('Request failed:', error); json(res, 500, { error: 'Server error. See server terminal.' }); }
    }finally{if(--activeRequests===0){for(const resolve of idleWaiters)resolve();idleWaiters.clear();}}
  }),{whenIdle:async()=>{scanStopping=true;await startupScan;if(activeRequests)await new Promise<void>(resolve=>idleWaiters.add(resolve));}});
  const relayAllowed=(req:IncomingMessage)=>{
    const hostname=new URL(`http://${req.headers.host??''}`).hostname;
    if(!allowedHosts.has(hostname))throw new ApiError(403,'Host is not allowed.');
    const origin=req.headers.origin;
    if(origin&&origin!=='null'&&origin!==(publicUrl?.origin??`http://${req.headers.host}`))throw new ApiError(403,'Origin is not allowed.');
  };
  relay.attach(server,relayAllowed);mesh.attach(server,relayAllowed);
  const relayTimer=setInterval(()=>{void relay.sweep();void mesh.sweep();},3000);relayTimer.unref();
  server.requestTimeout = 15*60_000; server.headersTimeout = 10_000; server.maxHeadersCount = 40;
  const sweep = setInterval(() => lobby.sweep(), 10_000); sweep.unref();
  const backupTimer=setInterval(()=>void automaticBackup(),60*60_000);backupTimer.unref();
  server.on('close', () => {scanStopping=true;relay.close();mesh.close();clearInterval(relayTimer);clearInterval(sweep);clearInterval(backupTimer);});
  return server;
}
function json(res: ServerResponse, status: number, body: unknown) {
  if(res.headersSent){if(!res.writableEnded)res.destroy();return;}
  if (!res.writableEnded && !res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
}
async function readJson(req: IncomingMessage,limit=8192): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'Use application/json.');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new ApiError(413, 'Request too large.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw new ApiError(400, 'Invalid JSON object.'); }
}

function html(res:ServerResponse,body:string){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SupCom 2: Reforged account</title><main>'+body+'</main></html>');}
async function readForm(req:IncomingMessage){if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']??''))throw new ApiError(415,'Use the account form.');let body='';for await(const chunk of req){body+=chunk.toString();if(Buffer.byteLength(body)>8192)throw new ApiError(413,'Form too large.');}return Object.fromEntries(new URLSearchParams(body));}
