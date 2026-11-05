import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import nodemailer from 'nodemailer';
import {ApiError} from './lobby';
export interface SmtpSettings {host:string;port:number;secure:boolean;user:string;password:string;from:string}
type Sender=(settings:SmtpSettings,message:{from:string;to:string;subject:string;text:string})=>Promise<unknown>;
export class MailService {
 constructor(private file?:string,private sender:Sender=async(c,m)=>nodemailer.createTransport({host:c.host,port:c.port,secure:c.secure,requireTLS:!c.secure,auth:c.user?{user:c.user,pass:c.password}:undefined,tls:{minVersion:'TLSv1.2'},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000}).sendMail(m)){}
 private memory:SmtpSettings|null=null;
 private async load(){if(this.memory)return this.memory;if(!this.file)return null;try{this.memory=JSON.parse(await readFile(this.file,'utf8'));return this.memory;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
 async status(){const c=await this.load();return {configured:!!c,host:c?.host??'',port:c?.port??587,secure:c?.secure??false,user:c?.user??'',from:c?.from??''};}
 async configure(value:unknown){
  const c=value as Partial<SmtpSettings>;if(!c||typeof c.host!=='string'||!/^[a-z0-9.-]{1,253}$/i.test(c.host)||!Number.isInteger(c.port)||!c.port||c.port<1||c.port>65535||typeof c.secure!=='boolean'||typeof c.user!=='string'||c.user.length>254||/[\r\n\0]/.test(c.user)||typeof c.from!=='string'||!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(c.from)||c.from.length>254)throw new ApiError(400,'Enter valid SMTP host, port, TLS mode, username and sender email.');
  const old=await this.load(),password=c.password===undefined||c.password===''?old?.password??'':c.password;if(typeof password!=='string'||password.length>1024||c.user&&!password)throw new ApiError(400,'Enter the SMTP password.');
  const next={host:c.host,port:c.port,secure:c.secure,user:c.user,password,from:c.from};
  if(this.file){await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});const tmp=this.file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(next),{mode:0o600,flag:'wx'});await rename(tmp,this.file);}this.memory=next;return this.status();
 }
 async send(to:string,subject:string,text:string){const c=await this.load();if(!c)throw new ApiError(503,'Email delivery is not configured. Ask your server administrator.');try{await this.sender(c,{from:c.from,to,subject,text});}catch{throw new ApiError(503,'The email could not be delivered. Check the server SMTP settings and retry.');}}
}
