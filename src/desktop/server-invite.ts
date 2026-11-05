export interface ServerInvite{format:'s2r-server-connection-v1';server:string;accessKey:string}
export function validateServerInvite(v:unknown):ServerInvite{
 const p=v as ServerInvite;if(!p||p.format!=='s2r-server-connection-v1'||typeof p.server!=='string'||p.server.length>300||typeof p.accessKey!=='string'||!(p.accessKey===''||/^[a-f0-9]{48}$/.test(p.accessKey)))throw new Error('Choose a Reforged server connection file.');
 let u:URL;try{u=new URL(p.server);}catch{throw new Error('Invalid server address.');}
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.origin!==p.server||(p.accessKey===''&&u.protocol!=='https:'))throw new Error('Invalid server address.');return {format:p.format,server:p.server,accessKey:p.accessKey};
}
