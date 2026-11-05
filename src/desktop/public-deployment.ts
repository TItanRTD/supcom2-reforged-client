import {mkdir,readFile,writeFile,rm,readdir,rename} from 'node:fs/promises';
import path from 'node:path';
// Use the basic ASAR-aware reads rather than depending on the platform's cp internals.
async function copyTree(source:string,target:string){
 await mkdir(target,{recursive:true});
 for(const entry of await readdir(source,{withFileTypes:true})){
  const from=path.join(source,entry.name),to=path.join(target,entry.name);
  if(entry.isSymbolicLink())throw new Error('Deployment source must not contain links.');
  if(entry.isDirectory())await copyTree(from,to);else if(entry.isFile())await writeFile(to,await readFile(from),{flag:'wx'});
 }
}
export function publicHostname(value:unknown){
 if(typeof value!=='string')throw new Error('Enter your public server hostname.');
 const name=value.trim().toLowerCase();
 if(name.length>253||!name.includes('.')||!name.split('.').every(n=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(n))||/^\d+(\.\d+){3}$/.test(name)||name.endsWith('.local')||name.endsWith('.localhost')||name.endsWith('.invalid')||name.endsWith('.example')||name==='example.com'||name.endsWith('.example.com'))throw new Error('Enter a real DNS hostname you control, such as play.your-domain.com. Do not include https://, a port or a path.');
 return name;
}
export async function exportPublicDeployment(value:unknown,parent:string,dist:string,templates:string){
 const hostname=publicHostname(value),destination=path.join(parent,'S2R-Public-Server');
 await mkdir(destination,{mode:0o700});
 try{
  await copyTree(templates,destination);
  await rename(path.join(destination,'vendor'),path.join(destination,'node_modules'));
  for(const name of ['server','shared'])await copyTree(path.join(dist,'node',name),path.join(destination,'dist/node',name));
  await copyTree(path.join(dist,'web'),path.join(destination,'dist/web'));
  await writeFile(path.join(destination,'.env'),'S2R_DOMAIN='+hostname+'\n',{mode:0o600});
  await writeFile(path.join(destination,'S2R-Server-Connection.json'),JSON.stringify({format:'s2r-server-connection-v1',server:'https://'+hostname,accessKey:''},null,2));
  return {message:'Public server setup exported to '+destination+'. Follow START-PUBLIC-SERVER.md on the server machine; exporting has not made it live.'};
 }catch(e){await rm(destination,{recursive:true,force:true});throw e;}
}
