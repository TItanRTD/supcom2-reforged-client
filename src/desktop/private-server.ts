import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { makeServer } from '../server/http';
import type { PrivateServerStatus } from '../shared/model';
import {MatchHistory,ReplayVault} from '../server/community';
import { Accounts } from '../server/accounts';
import { AdminGate } from '../server/admin';
import path from 'node:path';
import {ServerSettingsStore} from './server-settings';
import {acquireStoreLease} from '../server/store-lease';
export function localServerInterfaces(): string[] {
  const addresses=new Set(['127.0.0.1']);
  try{for(const entries of Object.values(networkInterfaces()))for(const entry of entries??[])if(entry.family==='IPv4')addresses.add(entry.address);}catch{/* Loopback remains available when interface enumeration is restricted. */}
  return [...addresses];
}
export class DesktopRoomServer {
  private server: ReturnType<typeof makeServer> | null=null;
  private starting=false;
  private stopping:Promise<void>|null=null;
  private releaseStore:(()=>Promise<void>)|null=null;
  private current: PrivateServerStatus={running:false,address:null,accessKey:null};
  private admin:AdminGate|null=null;
  async importAdmin(value:unknown){if(!this.server||!this.admin)throw new Error("Start this PC’s room server before importing administrator setup.");await this.admin.initialize(value);this.current.adminConfigured=true;}
  constructor(private readonly interfaces=localServerInterfaces,private readonly port=47820,private readonly accountFile?:()=>string){}
  status():PrivateServerStatus{return {...this.current};}
  async start(address:unknown,savedKey?:string):Promise<PrivateServerStatus>{
    if(typeof address!=='string'||!this.interfaces().includes(address))throw new Error('Choose an address assigned to this PC.');
    if(this.server||this.starting||this.stopping)throw new Error('This client is already hosting or stopping a room server.');
    this.starting=true;try{
    const accountFile=this.accountFile?.();if(accountFile)this.releaseStore=await acquireStoreLease(accountFile);this.admin=new AdminGate(accountFile?path.join(path.dirname(accountFile),'admin.json'):undefined);
    const adminConfigured=await this.admin.configured();
    if(savedKey!==undefined&&!/^[a-f0-9]{48}$/.test(savedKey))throw new Error('Invalid saved server key.');
    const store=accountFile&&savedKey===undefined?new ServerSettingsStore(path.join(path.dirname(accountFile),'server-settings.json')):null,settings=store?await store.load():null;
    const accessKey=savedKey??settings?.accessKey??randomBytes(24).toString('hex');const server=makeServer({requireHostApproval:true,requireEmail:true,host:address,port:this.port,accessKey,accounts:new Accounts(accountFile),history:new MatchHistory(accountFile?path.join(path.dirname(accountFile),'matches.json'):undefined),replays:new ReplayVault(accountFile?path.join(path.dirname(accountFile),'replays'):undefined),admin:this.admin});this.server=server;
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.port,address,resolve);});}
    catch{this.server=null;throw new Error('Could not start the private room server. Close the old server terminal or choose the PC already hosting it.');}
    const port=(server.address() as {port:number}).port;
    if(store&&settings){try{await store.save({...settings,address});}catch(e){await this.stop();throw e;}}
    this.current={running:true,address:`http://${address}:${port}`,accessKey,adminConfigured};return this.status();
    }catch(e){await this.releaseStore?.();this.releaseStore=null;throw e;}finally{this.starting=false;}
  }
  async stop():Promise<void>{
    if(this.stopping)return this.stopping;
    const work=this.finishStop();this.stopping=work;
    try{await work;}finally{if(this.stopping===work)this.stopping=null;}
  }
  private async finishStop():Promise<void>{
    const server=this.server;this.server=null;this.current={running:false,address:null,accessKey:null};
    if(server){await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});await server.whenIdle();}
    await this.releaseStore?.();this.releaseStore=null;
  }
}
