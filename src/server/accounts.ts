// Private-server accounts. Passwords and remembered tokens are never stored in plaintext.
import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ApiError } from './lobby';
import {COLOURS,FACTIONS} from '../shared/model';
import type {PlaytestData,PlaytestApplication,PlaytestProfile,PlaytestAdmin} from '../shared/playtests';
const derive = promisify(scrypt);
interface Account { id: string; username: string; salt: string; hash: string; disabled?: boolean; administrator?:boolean; createdAt?: string;hostApproved?:boolean; email?:string;emailVerifiedAt?:string;preferences?:{faction:string;colour:string} }
interface Remembered { accountId: string; hash: string; expires: number }
interface Challenge {accountId:string;email:string;purpose:'verify'|'reset';hash:string;created:number;expires:number}
interface Data { schema: 1; accounts: Account[]; remembered: Remembered[];emailChallenges?:Challenge[]; friendships?:{from:string;to:string;accepted:boolean}[];playtests?:PlaytestData }
export class Accounts {
  get directory(){return this.file?path.dirname(this.file):undefined;}
  async canAdmin(id:string){return (await this.load()).accounts.some(a=>a.id===id&&!a.disabled&&a.administrator===true);}
  async grantAdmin(id:string){await this.serial(async()=>{const d=await this.load();if(!d.accounts.some(a=>a.id===id&&!a.disabled))throw new ApiError(403,'Account unavailable.');await this.save({...d,accounts:d.accounts.map(a=>a.id===id?{...a,administrator:true}:a)});});}
  get persistent(){return !!this.file;}
  private queue: Promise<unknown> = Promise.resolve();
  private data: Data | null = null;
  private loading: Promise<Data> | null = null;
  private busy = 0;
  constructor(private file?: string, private now = () => Date.now()) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work); this.queue = result.catch(() => {}); return result;
  }
  private async load() {
    if (this.data) return this.data;
    if (this.loading) return this.loading;
    this.loading = this.read();
    try { return await this.loading; } finally { this.loading = null; }
  }
  private async read() {
    let data: Data = { schema: 1, accounts: [], remembered: [] };
    if (this.file) {
      try {
        data = JSON.parse(await readFile(this.file, 'utf8'));
        if (data.schema !== 1 || !Array.isArray(data.accounts) || !Array.isArray(data.remembered)) throw new Error('Invalid account database.');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    this.data = data; return data;
  }
  async rename(id:string,value:unknown){
    const username=this.username(value);
    return this.serial(async()=>{
      const data=await this.load();
      if(!data.accounts.some(a=>a.id===id))throw new ApiError(404,'Account not found.');
      if(data.accounts.some(a=>a.id!==id&&a.username.toLowerCase()===username.toLowerCase()))throw new ApiError(409,'That username is already registered on this server.');
      await this.save({...data,accounts:data.accounts.map(a=>a.id===id?{...a,username}:a)});
      return {id,username};
    });
  }
  async registered(name: unknown) { return typeof name === 'string' && (await this.load()).accounts.some(a => a.username.toLowerCase() === name.trim().toLowerCase()); }
  private async save(data: Data) {
    if (this.file) {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = this.file + '.tmp-' + randomBytes(8).toString('hex');
      await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      await rename(temp, this.file);
    }
    this.data = data;
  }
  username(value: unknown) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_]{3,24}$/.test(value)) throw new ApiError(400, 'Username must be 3–24 letters, numbers or underscores.');
    return value;
  }
  private password(value: unknown) {
    if (typeof value !== 'string' || value.length < 9 || value.length > 128) throw new ApiError(400, 'Password must contain 9–128 characters.');
    return value;
  }
  private async hash(password: string, salt: string) {
    if (this.busy >= 4) throw new ApiError(429, 'Sign-in is busy. Try again shortly.');
    this.busy++;
    try { return await derive(password, salt, 64) as Buffer; } finally { this.busy--; }
  }
  private email(value:unknown):string {
    if(typeof value!=='string')throw new ApiError(400,'Enter an email address.');
    const email=value.trim().toLowerCase();
    if(email.length>254||! /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)||email.split('@')[0].length>64||email.startsWith('.')||email.includes('..')||email.includes('.@'))throw new ApiError(400,'Enter a valid email address.');
    return email;
  }
  async profile(id:string){const a=(await this.load()).accounts.find(a=>a.id===id);if(!a)throw new ApiError(404,'Account not found.');return {id:a.id,username:a.username,email:a.email??null,emailVerified:!!a.emailVerifiedAt,preferences:a.preferences?{...a.preferences,colour:a.preferences.colour==='Light Pink'?'Sky Blue':a.preferences.colour==='Light Purple'?'Lime Green':a.preferences.colour}:{faction:'UEF',colour:'Blue'}};}
  private playtests(data:Data):PlaytestData {
    const p=data.playtests??{revision:0,applicationsOpen:false,applications:[]};
    if(!Number.isSafeInteger(p.revision)||p.revision<0||typeof p.applicationsOpen!=='boolean'||!Array.isArray(p.applications)||p.applications.length>5000||p.applications.some(a=>!a||typeof a.accountId!=='string'||!Number.isSafeInteger(a.revision)||a.revision<1||!['pending','approved','rejected','revoked'].includes(a.status)))throw Error('Invalid playtest data.');
    return p;
  }
  async playtestPublic(){return {stage:'closed-playtest' as const,applicationsOpen:this.playtests(await this.load()).applicationsOpen};}
  async canDownload(id:string){const d=await this.load(),a=d.accounts.find(a=>a.id===id&&!a.disabled);return !!a&&(a.administrator===true||this.playtests(d).applications.some(p=>p.accountId===id&&p.status==='approved'));}
  async playtestProfile(id:string):Promise<PlaytestProfile>{
    const d=await this.load(),a=d.accounts.find(a=>a.id===id&&!a.disabled);if(!a)throw new ApiError(403,'Account unavailable.');
    const p=this.playtests(d),row=p.applications.find(r=>r.accountId===id);
    const application=row?(({reviewedBy,history,...own})=>own)(structuredClone(row)):null;
    return {applicationsOpen:p.applicationsOpen,canDownload:await this.canDownload(id),administrator:a.administrator===true,application};
  }
  async playtestAdmin():Promise<PlaytestAdmin>{
    const d=await this.load(),p=this.playtests(d);
    return {revision:p.revision,applicationsOpen:p.applicationsOpen,applications:p.applications.flatMap(row=>{const a=d.accounts.find(a=>a.id===row.accountId);return a?[{...structuredClone(row),username:a.username,email:a.email??null,disabled:a.disabled===true}]:[];}),accounts:d.accounts.map(a=>({id:a.id,username:a.username,administrator:a.administrator===true,disabled:a.disabled===true}))};
  }
  async setPlaytestApplications(open:unknown,expected:unknown){
    if(typeof open!=='boolean'||!Number.isSafeInteger(expected))throw new ApiError(400,'Choose whether applications are open and refresh the review queue.');
    await this.serial(async()=>{const d=await this.load(),p=this.playtests(d);if(expected!==p.revision)throw new ApiError(409,'The playtest queue changed. Refresh and try again.');await this.save({...d,playtests:{...p,revision:p.revision+1,applicationsOpen:open}});});
    return this.playtestAdmin();
  }
  async applyForPlaytest(id:string,body:Record<string,unknown>){
    if(!['new','regular','competitive'].includes(body.experience as string)||typeof body.interests!=='string'||body.interests.trim().length<10||body.interests.trim().length>1000||typeof body.setup!=='string'||body.setup.trim().length>400||body.confirmsRequirements!==true)throw new ApiError(400,'Choose your experience, describe what you would test (10–1000 characters), and confirm the Windows/base-game requirements.');
    await this.serial(async()=>{
      const d=await this.load(),p=this.playtests(d),a=d.accounts.find(a=>a.id===id&&!a.disabled);if(!a)throw new ApiError(403,'Account unavailable.');
      if(!p.applicationsOpen)throw new ApiError(403,'Playtest applications are not open yet.');
      if(!a.email)throw new ApiError(400,'Link an email address in your account profile before applying.');
      const previous=p.applications.find(r=>r.accountId===id);
      if(a.administrator||previous&&['pending','approved'].includes(previous.status))throw new ApiError(409,'You already have an application under review or playtest access.');
      const at=new Date(this.now()).toISOString(),row:PlaytestApplication={accountId:id,revision:(previous?.revision??0)+1,status:'pending',experience:body.experience as PlaytestApplication['experience'],interests:(body.interests as string).trim(),setup:(body.setup as string).trim(),submittedAt:at,updatedAt:at,reviewedAt:null,reviewedBy:null,history:[...(previous?.history??[]),{status:'pending' as const,at,actor:id}].slice(-20)};
      await this.save({...d,playtests:{...p,revision:p.revision+1,applications:[...p.applications.filter(r=>r.accountId!==id),row]}});
    });return this.playtestProfile(id);
  }
  async reviewPlaytest(actor:string,body:Record<string,unknown>){
    if(typeof body.accountId!=='string'||!['approved','rejected','revoked'].includes(body.status as string)||!Number.isSafeInteger(body.expectedRevision))throw new ApiError(400,'Choose an account, review decision and current application revision.');
    await this.serial(async()=>{
      const d=await this.load(),p=this.playtests(d),a=d.accounts.find(a=>a.id===body.accountId&&!a.disabled);if(!a)throw new ApiError(404,'Account unavailable.');if(a.administrator)throw new ApiError(400,'Administrators already have download access.');
      const previous=p.applications.find(r=>r.accountId===body.accountId);if((previous?.revision??0)!==body.expectedRevision)throw new ApiError(409,'This application changed. Refresh before reviewing it.');
      if(!previous&&body.status!=='approved')throw new ApiError(400,'Choose an existing application to reject or revoke.');
      const at=new Date(this.now()).toISOString(),status=body.status as 'approved'|'rejected'|'revoked',row:PlaytestApplication={accountId:a.id,experience:previous?.experience??null,interests:previous?.interests??'',setup:previous?.setup??'',submittedAt:previous?.submittedAt??null,history:[...(previous?.history??[]),{status,at,actor}].slice(-20),revision:(previous?.revision??0)+1,status,updatedAt:at,reviewedAt:at,reviewedBy:actor};
      await this.save({...d,playtests:{...p,revision:p.revision+1,applications:[...p.applications.filter(r=>r.accountId!==a.id),row]}});
    });return this.playtestAdmin();
  }
  async preferences(id:string,value:Record<string,unknown>){
    if(!FACTIONS.includes(value.faction as never)||!COLOURS.includes(value.colour as never))throw new ApiError(400,'Choose a faction and colour.');
    await this.serial(async()=>{const data=await this.load();if(!data.accounts.some(a=>a.id===id&&!a.disabled))throw new ApiError(403,'Account unavailable.');await this.save({...data,accounts:data.accounts.map(a=>a.id===id?{...a,preferences:{faction:value.faction as string,colour:value.colour as string}}:a)});});return this.profile(id);
  }
  async friends(id:string){const d=await this.load();return (d.friendships??[]).filter(f=>f.from===id||f.to===id).flatMap(f=>{const other=d.accounts.find(a=>a.id===(f.from===id?f.to:f.from)&&!a.disabled);return other?[{id:other.id,name:other.username,status:f.accepted?'friend':f.to===id?'incoming':'outgoing'}]:[];});}
  async friendship(id:string,value:Record<string,unknown>){await this.serial(async()=>{const d=await this.load(),target=d.accounts.find(a=>value.username?typeof value.username==='string'&&a.username.toLowerCase()===value.username.toLowerCase():a.id===value.accountId);if(!target||target.disabled||target.id===id)throw new ApiError(400,'Choose another registered commander.');let rows=d.friendships??[],found=rows.find(f=>f.from===id&&f.to===target.id||f.to===id&&f.from===target.id);
    if(value.action==='request'){if(!found){if(rows.filter(f=>f.from===id||f.to===id).length>=200||rows.filter(f=>f.from===target.id||f.to===target.id).length>=200)throw new ApiError(409,'Friend list limit reached.');rows=[...rows,{from:id,to:target.id,accepted:false}];}}
    else if(value.action==='accept'){if(!found||found.to!==id)throw new ApiError(403,'Only the recipient can accept this request.');rows=rows.map(f=>f===found?{...f,accepted:true}:f);}
    else if(value.action==='remove')rows=rows.filter(f=>f!==found);else throw new ApiError(400,'Unknown friend action.');await this.save({...d,friendships:rows});});return this.friends(id);}
  async setEmail(id:string,value:unknown){
    const email=this.email(value);return this.serial(async()=>{const data=await this.load();if(!data.accounts.some(a=>a.id===id))throw new ApiError(404,'Account not found.');
      if(data.accounts.some(a=>a.id!==id&&a.email?.toLowerCase()===email))throw new ApiError(409,'That email address is already linked to an account.');
      await this.save({...data,accounts:data.accounts.map(a=>a.id===id?{...a,email,emailVerifiedAt:undefined}:a),emailChallenges:(data.emailChallenges??[]).filter(c=>c.accountId!==id)});return this.profile(id);
    });
  }
  async register(name: unknown, password: unknown, emailValue?:unknown) {
    const username = this.username(name), secret = this.password(password);
    const email=emailValue===undefined?undefined:this.email(emailValue);
    const salt = randomBytes(32).toString('hex'), hash = (await this.hash(secret, salt)).toString('hex');
    return this.serial(async () => {
      const data = await this.load();
      if (data.accounts.some(a => a.username.toLowerCase() === username.toLowerCase())) throw new ApiError(409, 'That username is already registered on this server.');
      if(email&&data.accounts.some(a=>a.email?.toLowerCase()===email))throw new ApiError(409,'That email address is already linked to an account.');
      if (data.accounts.length >= 5000) throw new ApiError(503, 'Private server account limit reached.');
      const account: Account = { id: randomUUID(), username, salt, hash, ...(email?{email}:{}), hostApproved:true, createdAt:new Date(this.now()).toISOString() };
      await this.save({ ...data, accounts: [...data.accounts, account] });
      return { id: account.id, username: account.username };
    });
  }
  async login(name: unknown, password: unknown) {
    const username = this.username(name), secret = this.password(password);
    const account = (await this.load()).accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
    const calculated = await this.hash(secret, account?.salt ?? '0'.repeat(64));
    if (!account || !timingSafeEqual(calculated, Buffer.from(account.hash, 'hex'))) throw new ApiError(401, 'Incorrect username or password.');
    if(account.disabled)throw new ApiError(403,'This account is disabled. Contact the server administrator.');
    return { id: account.id, username: account.username };
  }
  async remember(accountId: string) {
    return this.serial(async () => {
      const data = await this.load(), refreshToken = randomBytes(32).toString('hex');
      const remembered = data.remembered.filter(r => r.expires > this.now());
      // Bounded per-account remembered devices.
      const mine = remembered.filter(r => r.accountId === accountId).slice(-4);
      const others = remembered.filter(r => r.accountId !== accountId);
      await this.save({ ...data, remembered: [...others, ...mine, { accountId, hash: this.digest(refreshToken), expires: this.now() + 30 * 86400_000 }] });
      return refreshToken;
    });
  }
  private digest(value: string) { return createHash('sha256').update(value).digest('hex'); }
  async restore(value: unknown) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ApiError(401, 'Saved sign-in expired. Sign in again.');
    const data = await this.load(), remembered = data.remembered.find(r => r.hash === this.digest(value) && r.expires > this.now());
    const account = remembered && data.accounts.find(a => a.id === remembered.accountId);
    if (!account) throw new ApiError(401, 'Saved sign-in expired. Sign in again.');
    if(account.disabled)throw new ApiError(403,'This account is disabled. Contact the server administrator.');
    return { id: account.id, username: account.username };
  }
  async revoke(value: unknown) {
    if (typeof value !== 'string') return;
    await this.serial(async () => { const data = await this.load(); await this.save({ ...data, remembered: data.remembered.filter(r => r.hash !== this.digest(value)) }); });
  }

  async list(){return (await this.load()).accounts.map(a=>({id:a.id,username:a.username,disabled:!!a.disabled,createdAt:a.createdAt??null,hostApproved:a.hostApproved!==false,email:a.email??null,emailVerified:!!a.emailVerifiedAt}));}
  async canHost(id:string){return (await this.load()).accounts.some(a=>a.id===id&&!a.disabled&&a.hostApproved!==false);}
  async approveHost(id:string,approved:boolean){
    if(typeof approved!=='boolean')throw new ApiError(400,'Hosting approval must be true or false.');
    await this.serial(async()=>{const data=await this.load();if(!data.accounts.some(a=>a.id===id))throw new ApiError(404,'Account not found.');await this.save({...data,accounts:data.accounts.map(a=>a.id===id?{...a,hostApproved:approved}:a)});});
  }
  async setDisabled(id:string,disabled:boolean){
    await this.serial(async()=>{
      const data=await this.load();if(!data.accounts.some(a=>a.id===id))throw new ApiError(404,'Account not found.');
      await this.save({...data,accounts:data.accounts.map(a=>a.id===id?{...a,disabled}:a),remembered:data.remembered.filter(r=>r.accountId!==id),emailChallenges:(data.emailChallenges??[]).filter(c=>c.accountId!==id)});
    });
  }
  async revokeAccount(id:string){await this.serial(async()=>{const data=await this.load();await this.save({...data,remembered:data.remembered.filter(r=>r.accountId!==id),emailChallenges:(data.emailChallenges??[]).filter(c=>c.accountId!==id)});});}
  async changePassword(id:string,password:unknown){
    const secret=this.password(password),salt=randomBytes(32).toString('hex'),hash=(await this.hash(secret,salt)).toString('hex');
    await this.serial(async()=>{
      const data=await this.load();if(!data.accounts.some(a=>a.id===id))throw new ApiError(404,'Account not found.');
      await this.save({...data,accounts:data.accounts.map(a=>a.id===id?{...a,salt,hash}:a),remembered:data.remembered.filter(r=>r.accountId!==id),emailChallenges:(data.emailChallenges??[]).filter(c=>c.accountId!==id)});
    });
  }
  async issueEmailChallenge(id:string,purpose:'verify'|'reset'){
    return this.serial(async()=>{const data=await this.load(),a=data.accounts.find(a=>a.id===id&&!a.disabled);
      if(!a?.email)throw new ApiError(400,'Link an email address first.');
      if(purpose==='verify'&&a.emailVerifiedAt)throw new ApiError(409,'Email is already verified.');
      if(purpose==='reset'&&!a.emailVerifiedAt)throw new ApiError(400,'Verify your email before using email recovery.');
      const active=(data.emailChallenges??[]).filter(c=>c.expires>this.now());
      if(active.some(c=>c.accountId===id&&c.purpose===purpose&&this.now()-c.created<60_000))throw new ApiError(429,'Wait one minute before requesting another email.');
      const token=randomBytes(32).toString('hex'),expires=this.now()+(purpose==='verify'?86400_000:30*60_000);
      await this.save({...data,emailChallenges:[...active.filter(c=>c.accountId!==id||c.purpose!==purpose),{accountId:id,email:a.email,purpose,hash:this.digest(token),created:this.now(),expires}]});
      return {token,email:a.email,username:a.username,expires};
    });
  }
  async recoveryAccount(value:unknown){const email=this.email(value);const a=(await this.load()).accounts.find(a=>a.email===email&&a.emailVerifiedAt&&!a.disabled);return a?.id??null;}
  async cancelEmailChallenge(token:string){await this.serial(async()=>{const data=await this.load();await this.save({...data,emailChallenges:(data.emailChallenges??[]).filter(c=>c.hash!==this.digest(token))});});}
  async verifyEmail(value:unknown){
    if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))throw new ApiError(400,'This verification link is invalid or expired.');
    return this.serial(async()=>{const data=await this.load(),c=(data.emailChallenges??[]).find(c=>c.hash===this.digest(value)&&c.purpose==='verify'&&c.expires>this.now()),a=c&&data.accounts.find(a=>a.id===c.accountId&&a.email===c.email&&!a.disabled);
      if(!c||!a)throw new ApiError(400,'This verification link is invalid or expired.');
      await this.save({...data,accounts:data.accounts.map(x=>x.id===a.id?{...x,emailVerifiedAt:new Date(this.now()).toISOString()}:x),emailChallenges:(data.emailChallenges??[]).filter(x=>x.accountId!==a.id||x.purpose!=='verify')});return {ok:true};
    });
  }
  async resetPassword(value:unknown,password:unknown){
    if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))throw new ApiError(400,'This recovery link is invalid or expired.');
    const secret=this.password(password);
    return this.serial(async()=>{const data=await this.load(),c=(data.emailChallenges??[]).find(c=>c.hash===this.digest(value)&&c.purpose==='reset'&&c.expires>this.now()),a=c&&data.accounts.find(a=>a.id===c.accountId&&a.email===c.email&&a.emailVerifiedAt&&!a.disabled);
      if(!c||!a)throw new ApiError(400,'This recovery link is invalid or expired.');
      const salt=randomBytes(32).toString('hex'),hash=(await this.hash(secret,salt)).toString('hex');
      await this.save({...data,accounts:data.accounts.map(x=>x.id===a.id?{...x,salt,hash}:x),remembered:data.remembered.filter(x=>x.accountId!==a.id),emailChallenges:(data.emailChallenges??[]).filter(x=>x.accountId!==a.id)});return {ok:true,accountId:a.id};
    });
  }
  async backup(){
    if(!this.file)throw new ApiError(409,'This server has no persistent account store to back up.');
    return this.serial(async()=>{
      const data=await this.load(),directory=path.join(path.dirname(this.file!),'backups');
      await mkdir(directory,{recursive:true,mode:0o700});
      const name='accounts-'+new Date(this.now()).toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex')+'.json';
      await writeFile(path.join(directory,name),JSON.stringify(data),{mode:0o600,flag:'wx'});
      const files=(await readdir(directory)).filter(n=>/^accounts-[\w.-]+\.json$/.test(n)).sort();
      for(const n of files.slice(0,Math.max(0,files.length-14)))await unlink(path.join(directory,n));
      return {name,at:new Date(this.now()).toISOString()};
    });
  }
}
