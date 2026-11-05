export interface ClientRelease {schema:1;version:string;protocol:number;sha256:string;size:number;path:string;publishedAt:string;notes:string}
export interface SignedRelease {release:ClientRelease;signature:string;publicKey:string}
export function versionParts(value:unknown):number[]{if(typeof value!=='string'||! /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value))throw Error('Use a release version such as 0.14.0.');return value.split('.').map(Number);}
export function newer(a:string,b:string){const x=versionParts(a),y=versionParts(b);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;}
export function releaseBytes(r:ClientRelease){return JSON.stringify([r.schema,r.version,r.protocol,r.sha256,r.size,r.path,r.publishedAt,r.notes]);}
