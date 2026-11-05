export {};
interface State{service:{running:boolean;address:string|null;accessKey:string|null;adminConfigured?:boolean};address:string;autoStart:boolean;interfaces:string[];problem:string}
interface Manager{status():Promise<State>;start(a:string):Promise<State>;stop():Promise<State>;auto(v:boolean):Promise<State>;importSetup():Promise<State>;copyConnection():Promise<void>;exportConnection():Promise<void>;files():Promise<void>;quit():Promise<void>}
const manager=(window as unknown as {serverManager:Manager}).serverManager;
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById('manager-'+id) as T;
let busy=false,current:State|null=null,initialized=false;
function render(s:State){current=s;const address=el<HTMLSelectElement>('address');const choices=s.interfaces.includes(s.address)?s.interfaces:[s.address,...s.interfaces];
 if(Array.from(address.options).map(o=>o.value).join('|')!==choices.join('|'))address.replaceChildren(...choices.map(a=>new Option(a+(s.interfaces.includes(a)?'':' (not connected)'),a)));
 if(!initialized||s.service.running||!address.value)address.value=s.address;initialized=true;
 address.disabled=s.service.running;el<HTMLButtonElement>('start').disabled=s.service.running;el<HTMLButtonElement>('stop').disabled=!s.service.running;
 document.getElementById('service-state')!.textContent=s.service.running?'Server running':'Server stopped';el<HTMLInputElement>('url').value=s.service.address??'http://'+s.address+':47820';el<HTMLInputElement>('key').value=s.service.accessKey??'';el<HTMLInputElement>('auto').checked=s.autoStart;
 el('admin').textContent=s.service.adminConfigured?'Administrator PIN configured. Existing accounts and approvals are retained.':'Start the server, then import your existing private administrator setup file once.';
 el<HTMLButtonElement>('import').disabled=!s.service.running||!!s.service.adminConfigured;el<HTMLButtonElement>('copy').disabled=!s.service.running;el<HTMLButtonElement>('export').disabled=!s.service.running;if(s.problem)el('message').textContent=s.problem;
}
async function run(work:()=>Promise<State|void>){if(busy)return;busy=true;try{const s=await work();if(s)render(s);el('message').classList.remove('error');if(!s?.problem)el('message').textContent='Saved.';}catch(e){el('message').textContent=(e as Error).message;el('message').classList.add('error');if(current)render(current);}finally{busy=false;}}
el('start').addEventListener('click',()=>void run(()=>manager.start(el<HTMLSelectElement>('address').value)));el('stop').addEventListener('click',()=>void run(()=>manager.stop()));el('import').addEventListener('click',()=>void run(()=>manager.importSetup()));el('auto').addEventListener('change',()=>void run(()=>manager.auto(el<HTMLInputElement>('auto').checked)));el('files').addEventListener('click',()=>void run(()=>manager.files()));el('quit').addEventListener('click',()=>void run(()=>manager.quit()));el('copy').addEventListener('click',()=>void run(()=>manager.copyConnection()));el('export').addEventListener('click',()=>void run(()=>manager.exportConnection()));
void run(()=>manager.status());setInterval(()=>{if(!busy)void manager.status().then(render).catch(()=>{});},2000);
