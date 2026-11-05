import {MatchHistory,ReplayVault} from './community';
import {MailService} from './mail';
import {ReleaseStore} from './releases';
import {CLIENT_VERSION} from '../shared/model';
import {acquireStoreLease} from './store-lease';
import { AdminGate } from './admin';
import { makeServer } from './http';
import { Accounts } from './accounts';
import { homedir } from 'node:os';
import path from 'node:path';
const host = process.env.SC2_HOST ?? '127.0.0.1';
const port = Number(process.env.SC2_PORT ?? 47820);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SC2_PORT must be 1–65535.');
const accountFile=process.env.S2R_ACCOUNT_FILE??path.join(homedir(),'.s2r-server','accounts.json');
async function main(){
const release=await acquireStoreLease(accountFile);
let server;try{server=makeServer({history:new MatchHistory(path.join(path.dirname(accountFile),'matches.json')),replays:new ReplayVault(path.join(path.dirname(accountFile),'replays')),requireHostApproval:true,requireEmail:true,host,port,mail:new MailService(path.join(path.dirname(accountFile),'mail.json')),releases:new ReleaseStore(path.join(path.dirname(accountFile),'updates')),accessKey:process.env.SC2_ACCESS_KEY,accounts:new Accounts(accountFile),admin:new AdminGate(process.env.S2R_ADMIN_FILE??path.join(path.dirname(accountFile),'admin.json')),publicOrigin:process.env.S2R_PUBLIC_ORIGIN});}catch(e){await release();throw e;}
server.on('error', error => { console.error(error.message);void release();process.exitCode=1; });
server.listen(port, host, () => {
  console.log(`SupCom 2: Reforged community server listening on http://${host}:${port}`);
  console.log(`S2R ${CLIENT_VERSION} accounts, rooms, email and client updates. Game networking uses a separate transport.`);
});
server.once('close',()=>void release());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());

}
void main().catch(e=>{console.error(e.message);process.exitCode=1;});
