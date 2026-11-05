import {randomBytes,createHash} from 'node:crypto';
import {ApiError} from './lobby';
interface Ticket {accountId:string;session:string;hash:string;expires:number}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
/** One-use browser download handoff. No account bearer token goes in a URL. */
export class DownloadTickets {
 private tickets=new Map<string,Ticket>();
 constructor(private now=()=>Date.now()){}
 issue(accountId:string,session:string,hash:string){
  for(const [key,t]of this.tickets)if(t.expires<=this.now()||t.accountId===accountId)this.tickets.delete(key);
  if(this.tickets.size>=1000)throw new ApiError(503,'Downloads are busy. Try again shortly.');
  const token=randomBytes(32).toString('hex');this.tickets.set(digest(token),{accountId,session,hash,expires:this.now()+60_000});
  return token;
 }
 take(token:string|null,hash:string){
  if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
  const key=digest(token),t=this.tickets.get(key);this.tickets.delete(key);
  return t&&t.expires>this.now()&&t.hash===hash?t:null;
 }
}
