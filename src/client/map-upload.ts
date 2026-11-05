/** Send the File directly; never copy a large map pack into a JS ArrayBuffer. */
export function sendMapPackage(url:string,token:string,file:File,signal:AbortSignal,progress:(sent:number,total:number)=>void):Promise<{ok:boolean;result:{error?:string;duplicate?:boolean;package?:{scan?:{status:string}}}}> {
 return new Promise((resolve,reject)=>{
  const xhr=new XMLHttpRequest();
  const abort=()=>xhr.abort(),cleanup=()=>signal.removeEventListener('abort',abort);
  xhr.open('POST',url);xhr.timeout=15*60_000;xhr.setRequestHeader('Authorization','Bearer '+token);xhr.setRequestHeader('Content-Type','application/octet-stream');
  xhr.upload.onprogress=e=>progress(e.loaded,e.lengthComputable?e.total:file.size);
  xhr.onload=()=>{cleanup();try{resolve({ok:xhr.status>=200&&xhr.status<300,result:JSON.parse(xhr.responseText)});}catch{reject(Error('The server returned an unreadable map upload response.'));}};
  xhr.onerror=()=>{cleanup();reject(Error('Map upload connection failed.'));};
  xhr.ontimeout=()=>{cleanup();reject(Error('Map upload timed out.'));};
  xhr.onabort=()=>{cleanup();reject(Error('Map upload stopped.'));};
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted){cleanup();reject(Error('Map upload stopped.'));return;}
  xhr.send(file);
 });
}
