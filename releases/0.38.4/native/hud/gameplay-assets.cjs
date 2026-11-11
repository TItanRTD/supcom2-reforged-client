'use strict';
const crypto=require('node:crypto'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {compose,isUI}=require('./replay-presentation.cjs');
const norm=e=>e.name.replaceAll('\\','/').toLowerCase();
function simulationHash(bundle){const hash=crypto.createHash('sha256');const entries=[...bundle.scripts.filter(e=>!isUI(norm(e))),...bundle.overrides.filter(e=>!norm(e).startsWith('textures/ui/'))].sort((a,b)=>norm(a).localeCompare(norm(b)));for(const e of entries){hash.update(norm(e)+'\0'+e.data.length+'\0');hash.update(e.data);}return hash.digest('hex');}
function keepPalette(result,current){for(const e of current.scripts.filter(e=>['lua/common/gamecolors.lua','lua/common/rf026_colors_original.lua'].includes(norm(e))||/^textures\/ui\/common\/pc\/frontend\/rf26_/.test(norm(e))))if(!result.scripts.some(x=>norm(x)===norm(e)))result.scripts.push(e);return result;}
function apply(current,originalEntries,gameplay={profileId:'vanilla-plus'}){
 const id=gameplay.profileId;assert(['vanilla-plus','vanilla-1.260-iwbp','reforged-balance'].includes(id),'Unknown gameplay profile');
 let result=current;
 if(id==='vanilla-1.260-iwbp'){
  assert(!gameplay.research,'Retail gameplay cannot load custom research');
  result=compose(current,current,originalEntries,{legacy:true,revision:'retail'});
  // Shared player colours are cosmetic. Keep the same palette and swatches
  // advertised by the client; never restore the combined blueprint loader.
  keepPalette(result,current);
  result.scripts=result.scripts.map(e=>norm(e)==='lua/ui/lobby/aitypes.lua'?{...e,data:Buffer.from(e.data.toString().replace('AI: Reforger','AI: Cheat'))}:e);
  result.scripts=result.scripts.map(e=>norm(e)==='lua/ui/game/gamemain_pc.lua'?{...e,data:Buffer.from(e.data.toString().replace('_G.ReforgedLegacyReplay = true\n','_G.ReforgedRetailGameplay = true\n'))}:e);
  // Add only the shared order dispatch and read-only reclaim display. Never
  // restore the full Reforged callback (which also enables passive conversion).
  const required=['lua/rf027_simcallbacks_original.lua','lua/sim/reforged_commands.lua','lua/sim/reforged_reclaim.lua'];
  for(const name of required){const entry=current.scripts.find(e=>norm(e)===name);assert(entry,'Missing stock order dependency '+name);result.scripts.push({...entry});}
  const original=originalEntries.find(e=>norm(e)==='lua/sim/simcallbacks.lua');
  assert(original&&result.scripts.find(e=>norm(e)==='lua/rf027_simcallbacks_original.lua').data.equals(original.data),'Stock callbacks must delegate the exact retail bytes');
  for(const [name,file]of [['lua/sim/simcallbacks.lua','reforged_stock_callbacks.lua'],['lua/sim/reforged_stock_orders.lua','reforged_stock_orders.lua']])result.scripts.push({name,data:fs.readFileSync(path.join(__dirname,file))});
  result.scripts=result.scripts.map(e=>/^(?:mods\/dlc1\/shadow\/)?lua\/sim\/aibrain\.lua$/.test(norm(e))?{...e,data:Buffer.concat([e.data,Buffer.from("\nSyncScores=import('/lua/sim/reforged_stock_orders.lua').WrapSync(SyncScores)\n")])}:e);
  assert(!result.scripts.some(e=>/^(?:units|projectiles|abilities)\//.test(norm(e))||norm(e)==='lua/system/blueprints.lua'||/^lua\/(?:ai\/|sim\/reforged_(?:converters|balance))/.test(norm(e))));
  result.manifest={...result.manifest,stockOrders:true,stockControlRevision:'0373',originalBalance:true,simulationRevision:'current',telemetryOnly:false,scope:'Original retail units, stats, weapons, research, AI and active conversion; Reforged order input and read-only reclaim display only. No balance loaders, extra units or passive conversion.'};
 }
 if(id==='reforged-balance'&&gameplay.compiler==='0379')result=require('./unit-handoff-0379/assets.cjs').apply(result);
 if(id==='reforged-balance'&&['03711','03712','03714','03715','03716','03717','03718','03721','0382'].includes(gameplay.compiler))result=require('./unit-handoff-03711/assets.cjs').apply(result);
 result=require('./unit-handoff-03712/assets.cjs').apply(result,originalEntries,id==='reforged-balance'&&['03712','03714','03715','03716','03717','03718','03721','0382'].includes(gameplay.compiler));
 if(id==='reforged-balance'&&['03714','03715','03716','03717','03718','03721','0382'].includes(gameplay.compiler))result=require('./unit-handoff-03714/assets.cjs').apply(result);
 if(id==='reforged-balance'&&gameplay.compiler==='03715')result=require('./unit-handoff-03715/assets.cjs').apply(result);
 if(id==='reforged-balance'&&['03716','03717','03718','03721','0382'].includes(gameplay.compiler))result=require('./unit-handoff-03716/assets.cjs').apply(result);
 if(id==='reforged-balance'&&['03717','03718','03721','0382'].includes(gameplay.compiler))result=require('./unit-handoff-03717/assets.cjs').apply(result);
 if(id==='reforged-balance'&&['03718','03721','0382'].includes(gameplay.compiler))result=require('./unit-handoff-03718/assets.cjs').apply(result);
 if(id==='reforged-balance'&&['03721','0382'].includes(gameplay.compiler))result=require('./unit-handoff-03721/assets.cjs').apply(result);
 if(result.manifest.unitHandoff)result=require('./unit-build-icons-03713/assets.cjs').apply(result);
 if(gameplay.aiRevision){const adapter=gameplay.aiRevision==='evidence-ai-5'?'../ai/evidence-v5/assets.cjs':gameplay.aiRevision==='evidence-ai-4'?'../ai/evidence-v4/assets.cjs':'../ai/replay-ai-v2/assets.cjs';result=require(adapter).apply(result,current,originalEntries,gameplay);}
 const game={profileId:id,patchId:gameplay.id,version:gameplay.version,...(gameplay.aiRevision?{aiRevision:gameplay.aiRevision}:{}),simulationHash:simulationHash(result),retail:id==='vanilla-1.260-iwbp'};
 return {...result,manifest:{...result.manifest,mode:'s2r-live-gameplay-0370',gameplay:game,originalSimulation:game.retail&&!result.manifest.stockOrders,originalBalance:game.retail}};
}
module.exports={apply,simulationHash,keepPalette};
