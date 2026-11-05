import {mkdir,readFile,writeFile,rename,stat,mkdtemp,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import path from 'node:path';
import {exportPublicDeployment,publicHostname} from './public-deployment';
import {acquireStoreLease} from '../server/store-lease';
import {PROTOCOL,CLIENT_VERSION} from '../shared/model';
import {stageServerMigration,verifyServerMigration} from '../server/store-migration';
const PROJECT='s2r-reforged-managed',LOCAL='http://127.0.0.1:47821';
export interface PublicSetupStatus{running:boolean;stage:string;message:string;domain:string;localReady:boolean;httpsReady:boolean;canResume:boolean;accountCount:number;log:string[];directory:string}
interface State{schema:1;domain:string;phase:'preparing'|'migrating'|'imported'|'ready';backup?:string;accountCount?:number;firewallDone?:boolean;codeVersion?:string;previousDomain?:string}
export type DockerRunner=(args:string[],cwd:string,timeout:number,onOutput:(s:string)=>void)=>Promise<string>;
interface Options{root:string;accounts:string;dist:string;templates:string;run?:DockerRunner;pause:()=>Promise<{release:()=>Promise<void>;resume:()=>Promise<void>}>;health?:(url:string)=>Promise<unknown>;checkPorts?:()=>Promise<void>;onReady?:(connection:{server:string;accessKey:string})=>Promise<void>;enableStartup?:()=>Promise<void>;firewall?:()=>Promise<void>}
export const runDocker:DockerRunner=(args,cwd,timeout,onOutput)=>new Promise((resolve,reject)=>{
 const child=spawn('docker',args,{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;child.kill();},timeout);timer.unref();
 child.stdout.on('data',b=>{const s=b.toString();stdout=(stdout+s).slice(-32768);onOutput(s);});child.stderr.on('data',b=>{const s=b.toString();stderr=(stderr+s).slice(-4096);onOutput(s);});
 child.once('error',e=>{clearTimeout(timer);reject(new Error((e as NodeJS.ErrnoException).code==='ENOENT'?'Docker was not found. Open Docker Desktop once, then reopen Reforged.':e.message));});child.once('exit',code=>{clearTimeout(timer);if(code===0)resolve(stdout.trim());else reject(new Error(timedOut?'Docker took too long. Check Docker Desktop, then retry.':stderr.trim()||'Docker command failed. Check Docker Desktop and retry.'));});
});
async function availablePorts(){for(const port of [80,443,47821]){const server=createServer();try{await new Promise<void>((r,j)=>{server.once('error',j);server.listen({host:port===47821?'127.0.0.1':'0.0.0.0',port,exclusive:true},r);});}catch{throw Error('TCP port '+port+' is already in use. Stop the other web server before setting up Reforged.');}finally{if(server.listening)await new Promise<void>(r=>server.close(()=>r()));}}}
export class PublicServerSetup{
 private s:PublicSetupStatus;private pending:Promise<void>=Promise.resolve();private run:DockerRunner;private directory:string;private stateFile:string;private codeOverlay:string|null=null;
 constructor(private o:Options){this.directory=path.join(o.root,'S2R-Public-Server');this.stateFile=path.join(o.root,'setup-state.json');this.run=o.run??runDocker;this.s={running:false,stage:'idle',message:'Enter your public hostname, then choose Set up server.',domain:'',localReady:false,httpsReady:false,canResume:false,accountCount:0,log:[],directory:this.directory};}
 private note(message:string){this.s.message=message;this.s.log.push(message);this.s.log=this.s.log.slice(-50);}
 private output=(value:string)=>{for(const line of value.replace(/\u001b\[[0-9;]*m/g,'').split(/[\r\n]+/).filter(Boolean)){this.s.log.push(line.slice(0,300));this.s.log=this.s.log.slice(-50);}};
 private async load():Promise<State|null>{try{const raw=await readFile(this.stateFile,'utf8');if(raw.length>4096)throw Error();const s=JSON.parse(raw);if(s.schema!==1||publicHostname(s.domain)!==s.domain||s.previousDomain!==undefined&&(publicHostname(s.previousDomain)!==s.previousDomain||s.previousDomain===s.domain)||!['preparing','migrating','imported','ready'].includes(s.phase)||s.backup!==undefined&&!/^\d{13}-[a-f0-9]{16}$/.test(s.backup))throw Error();return s;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('Saved public server setup is invalid. Existing data was left unchanged.');}}
 private async save(state:State){await mkdir(this.o.root,{recursive:true,mode:0o700});const temp=this.stateFile+'.tmp-'+randomBytes(6).toString('hex');await writeFile(temp,JSON.stringify(state,null,2),{flag:'wx',mode:0o600});await rename(temp,this.stateFile);this.s.canResume=true;}
 async status(){if(!this.s.running&&!this.s.canResume){const state=await this.load();if(state){this.s.domain=state.domain;this.s.canResume=true;this.s.accountCount=state.accountCount??0;this.s.message='Saved public server setup found. Choose Resume setup to check Docker and start it.';}}return {...this.s,log:[...this.s.log]};}
 async configured(){return this.load();}
 async start(value:unknown,changeDomain=false){if(this.s.running)throw Error('Public server setup is already running.');const domain=publicHostname(value),existing=await this.load();if(existing&&existing.domain!==domain&&(!changeDomain||!['imported','ready'].includes(existing.phase)||existing.previousDomain))throw Error('Use Change domain for an established local server. Finish any pending hostname change first.');
 this.s={...this.s,running:true,domain,stage:'checking',localReady:false,httpsReady:false,log:[]};this.note('Checking Docker Desktop. Your existing account server stays available during preparation.');
 this.pending=this.lockedWork(domain,changeDomain).catch(e=>{this.s.stage='error';this.note((e as Error).message);}).finally(()=>{this.s.running=false;});return this.status();}
 async whenIdle(){await this.pending;return this.status();}
 private docker(args:string[],timeout=120_000){return this.run(args,this.o.root,timeout,this.output);}
 private compose(args:string[],timeout=120_000){return this.docker(['compose','--project-name',PROJECT,'--project-directory',this.directory,'-f',path.join(this.directory,'compose.yaml'),...(this.codeOverlay?['-f',this.codeOverlay]:[]),...args],timeout);}
 private async health(url:string){if(this.o.health)return this.o.health(url);const r=await fetch(url+'/health',{signal:AbortSignal.timeout(5000),redirect:'error'});if(!r.ok)throw Error('Health check failed.');return r.json();}
 private validHealth(value:unknown,domain:string){const h=value as {ok:boolean;protocol:number;origin:string;version:string};return !!h&&h.ok===true&&h.protocol===PROTOCOL&&h.version===CLIENT_VERSION&&h.origin==='https://'+domain;}
 private async lockedWork(domain:string,changeDomain:boolean){let release:()=>Promise<void>;try{release=await acquireStoreLease(this.stateFile);}catch{throw Error('Another public server setup is already running for this PC. Wait for it to finish, then retry.');}try{let state=await this.load();if(state&&state.domain!==domain){if(!changeDomain||!['imported','ready'].includes(state.phase)||state.previousDomain)throw Error('A different hostname is already configured.');const env=await readFile(path.join(this.directory,'.env'),'utf8');if(!env.split(/\r?\n/).includes('S2R_DOMAIN='+state.domain))throw Error('The managed DNS configuration differs from its saved hostname. It was not overwritten.');const backup=path.join(this.o.root,'domain-backups',Date.now()+'-'+randomBytes(8).toString('hex'));await mkdir(backup,{recursive:true,mode:0o700});await writeFile(path.join(backup,'setup-state.json'),JSON.stringify(state,null,2),{flag:'wx',mode:0o600});await writeFile(path.join(backup,'.env'),env,{flag:'wx',mode:0o600});state={...state,domain,previousDomain:state.domain};await this.save(state);}await this.work(domain,state);}finally{await release();}}
 private async work(domain:string,existing:State|null){
  await mkdir(this.o.root,{recursive:true,mode:0o700});
  const overridden=process.env.DOCKER_HOST;if(overridden&&!/^(npipe:\/\/|unix:\/\/)/.test(overridden))throw Error('Automation requires your local Docker Desktop engine. Remote Docker hosts are not supported.');
  const context=overridden??JSON.parse(await this.docker(['context','inspect','--format','{{json .Endpoints.docker.Host}}'],15_000));if(typeof context!=='string'||!/^(npipe:\/\/|unix:\/\/)/.test(context))throw Error('Choose the local Docker Desktop context before setup. No account data was sent.');
  let os='';try{os=await this.docker(['version','--format','{{.Server.Os}}'],15_000);}catch{this.note('Starting Docker Desktop. This may take a minute.');await this.docker(['desktop','start','--timeout','90'],100_000);os=await this.docker(['version','--format','{{.Server.Os}}'],15_000);}if(os.trim()!=='linux')throw Error('Switch Docker Desktop to Linux containers, then retry.');
  await this.docker(['compose','version','--short'],15_000);
  let state=existing;
  if(!state){
   try{await stat(this.directory);throw Error('The managed setup folder already exists without its setup record. It was not overwritten.');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   state={schema:1,domain,phase:'preparing'};await this.save(state);
  }
  // Stage a complete export before publishing its fixed folder. A crash can safely resume.
  try{await stat(this.directory);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;if(state.phase!=='preparing')throw Error('The managed deployment is missing. Account backups were preserved.');const staging=await mkdtemp(path.join(this.o.root,'prepare-'));try{await exportPublicDeployment(domain,staging,this.o.dist,this.o.templates);await rename(path.join(staging,'S2R-Public-Server'),this.directory);}finally{await rm(staging,{recursive:true,force:true});}}
  const changingDomain=!!state.previousDomain;
  if(changingDomain){
   this.s.stage='changing-domain';this.note('Updating the public hostname. Existing account, email, release and certificate volumes stay in use.');
   const file=path.join(this.directory,'.env'),env=await readFile(file,'utf8'),lines=env.split(/\r?\n/),records=lines.filter(x=>x.startsWith('S2R_DOMAIN='));
   if(records.length!==1||!['S2R_DOMAIN='+state.previousDomain,'S2R_DOMAIN='+domain].includes(records[0]))throw Error('The managed hostname configuration changed unexpectedly. Existing data was preserved.');
   const temp=file+'.tmp-'+randomBytes(6).toString('hex');await writeFile(temp,lines.map(x=>x.startsWith('S2R_DOMAIN=')?'S2R_DOMAIN='+domain:x).join('\n'),{flag:'wx',mode:0o600});await rename(temp,file);
   const invite=path.join(this.directory,'S2R-Server-Connection.json'),pending=invite+'.tmp-'+randomBytes(6).toString('hex');await writeFile(pending,JSON.stringify({format:'s2r-server-connection-v1',server:'https://'+domain,accessKey:''},null,2),{flag:'wx',mode:0o600});await rename(pending,invite);
  }
  const imported=state.phase==='imported'||state.phase==='ready';
  const overlay=path.join(this.o.root,'compose.reforged-code.yaml');
  try{await stat(overlay);this.codeOverlay=overlay;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const upgrading=imported&&state.codeVersion!==CLIENT_VERSION;
  if(upgrading){
   this.s.stage='upgrading';this.note('Preparing the updated Reforged room server. Existing Docker account and certificate volumes stay in use.');
   const parent=path.join(this.o.root,'server-builds',CLIENT_VERSION);await mkdir(parent,{recursive:true});
   const destination=path.join(parent,'S2R-Public-Server');
   // Publish a complete code-only bundle by directory rename. No account files are copied.
   const staging=await mkdtemp(path.join(this.o.root,'update-'));
   try{await exportPublicDeployment(domain,staging,this.o.dist,this.o.templates);
    try{await stat(destination);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;await rename(path.join(staging,'S2R-Public-Server'),destination);}
   }finally{await rm(staging,{recursive:true,force:true});}
   const temp=overlay+'.tmp-'+randomBytes(6).toString('hex');
   await writeFile(temp,'services:\n  server:\n    build:\n      context: '+JSON.stringify(destination)+'\n',{flag:'wx'});await rename(temp,overlay);this.codeOverlay=overlay;
  }
  if(!imported)await (this.o.checkPorts??availablePorts)();
  this.s.stage='building';this.note('Preparing the Reforged server and HTTPS proxy. This first build can take several minutes.');
  await this.compose(['config','--quiet'],15_000);if(!imported||upgrading)await this.compose(['build','server'],10*60_000);if(!imported)await this.compose(['pull','https'],5*60_000);
  if(this.o.firewall&&!state.firewallDone&&!imported){this.note('Allowing the Reforged web ports in Windows Firewall. Windows may ask for permission.');await this.o.firewall();state={...state,firewallDone:true};await this.save(state);}
  let paused:Awaited<ReturnType<Options['pause']>>|null=null,migrationStarted=state.phase==='migrating';
  try{
   if(!imported){
    this.s.stage='migrating';this.note('Pausing the old account server and backing up accounts, administrator setup, research drafts and uploaded maps.');paused=await this.o.pause();
    let backup=state.backup;
    if(!migrationStarted){
     backup=Date.now()+'-'+randomBytes(8).toString('hex');const folder=path.join(this.o.root,'backups',backup),accountCount=await stageServerMigration(this.o.accounts,folder);
     state={...state,phase:'migrating',backup,accountCount};await this.save(state);migrationStarted=true;
    }
    if(!backup)throw Error('The saved migration has no backup record.');const folder=path.join(this.o.root,'backups',backup);await verifyServerMigration(folder,this.o.accounts);
    // Pass the volume as one argument; no shell parses spaces or metacharacters in the profile path.
    const mount=folder+':/migration:ro';
    await this.compose(['run','--rm','--no-deps','--volume',mount,'server','node','import-accounts.cjs'],120_000);
    state={...state,phase:'imported'};await this.save(state);this.s.accountCount=state.accountCount??0;
   }
  }catch(e){if(paused&&!migrationStarted){await paused.release();await paused.resume();}throw e;}finally{await paused?.release();}
  this.s.stage='starting';this.note('Starting the account server and HTTPS proxy in Docker. Your old account files remain backed up.');
  await this.compose(['up','-d','--wait','--wait-timeout','120',...(upgrading||changingDomain?['--force-recreate']:[])],150_000);
  if(!this.validHealth(await this.health(LOCAL),domain))throw Error('The local public-server health check did not match this setup. Accounts were preserved; retry setup.');
  this.s.localReady=true;this.s.accountCount=state.accountCount??0;state={...state,phase:'ready',codeVersion:CLIENT_VERSION};delete state.previousDomain;await this.save(state);
  await this.o.enableStartup?.();await this.o.onReady?.({server:LOCAL,accessKey:''});
  this.note('Account server ready on this PC. Checking the public HTTPS address.');let https=false;try{https=this.validHealth(await this.health('https://'+domain),domain);}catch{/* Forwarding or DNS may still be pending; do not claim public connectivity. */}
  this.s.httpsReady=https;this.s.stage=https?'ready':'awaiting-network';this.note(https?'Server ready. HTTPS answered correctly from this PC. Players can use the generated connection file; an outside-network check is still useful.':'Local server ready. Public HTTPS is awaiting DNS and/or TCP 80/443 forwarding. Complete those, then choose Recheck HTTPS.');
 }
 async recheck(){const state=await this.load();if(!state||state.phase!=='ready')throw Error('Finish local setup first.');if(this.s.running)throw Error('Setup is still running.');const local=this.validHealth(await this.health(LOCAL),state.domain);let https=false;try{https=this.validHealth(await this.health('https://'+state.domain),state.domain);}catch{}this.s.localReady=local;this.s.httpsReady=https;this.s.stage=https?'ready':'awaiting-network';this.note(!local?'Local server is stopped. Choose Resume setup.':https?'HTTPS answered correctly from this PC. Confirm access from another network before inviting everyone.':'Local server is ready; public HTTPS is still awaiting DNS or TCP 80/443 forwarding.');return this.status();}
}
