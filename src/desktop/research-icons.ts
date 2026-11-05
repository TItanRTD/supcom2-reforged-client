import path from 'node:path';
import {indexArchive,readEntry,decodeMapPreview} from '../server/map-assets';
/** Three stock DLC previews not present in the supplied reference art. Read
 * only those textures from the already-selected local game, without uploading. */
const wanted:Record<string,string>={IBA_SACRIFICE:'360_hd_structuresacrifice_u.dds',IBP_BUILDONWATER:'360_hd_buildonwater_u.dds',ULA_SPEED:'360_hd_speedoverdrive_u.dds'};
export async function stockResearchIcons(executable:string):Promise<Record<string,string>>{
 if(!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!=='supremecommander2.exe'||path.basename(path.dirname(executable)).toLowerCase()!=='bin')throw Error('Choose a Supreme Commander 2 installation in your profile.');
 const result:Record<string,string>={},directory=path.join(path.dirname(path.dirname(executable)),'gamedata');
 for(const name of ['textures.scd','z_textures_dlc1.scd','z_textures.scd']){
  if(Object.keys(result).length===3)break;
  try{const archive=await indexArchive(path.join(directory,name));
   for(const [id,file]of Object.entries(wanted)){if(result[id])continue;const suffix='textures/ui/common/icons/orders/'+file,entry=archive.entries.find(e=>{const key=e.name.toLowerCase().replace(/\.win\.dds$/,'.dds');return key===suffix||key.endsWith('/'+suffix);});if(!entry)continue;const preview=decodeMapPreview(await readEntry(archive,entry));if(preview)result[id]=preview;}
  }catch{/* Optional art never blocks research editing or game launch. */}
 }
 return result;
}
export async function boundedStockResearchIcons(executable:string){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([stockResearchIcons(executable),new Promise<Record<string,string>>(resolve=>{timer=setTimeout(()=>resolve({}),5000);})]);}finally{if(timer)clearTimeout(timer);}}
