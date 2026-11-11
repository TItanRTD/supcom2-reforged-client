'use strict';
// Current presentation over the selected recording's simulation. The six
// instrumented classes delegate exact selected bytes, with read-only telemetry.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const norm=e=>e.name.replaceAll('\\','/').toLowerCase();
function isUI(name){return name.startsWith('ui/')||/^(?:mods\/dlc1\/shadow\/)?textures\/ui\//.test(name)||/^lua\/rf0350_strategic_layout_[01]\.lua$/.test(name)||name.startsWith('lua/ui/')||name==='lua/keymap/keyactions.lua'||name==='mods/dlc1/shadow/lua/ui/game/reforged_construction_costs.lua'||name==='lua/usersync.lua'||/^lua\/rf_orders_(graph|waypoint|mode|buttons|usersync)_original\.lua$/.test(name)||/^lua\/rf\d+_(?:usersync|pc)_original\.lua$/.test(name);}
function compose(current,selected,originalEntries,{legacy=false,revision='current'}={}){
 const viewerData=e=>/\/reforged_(?:research_data|construction_costs)\.lua$/.test(norm(e));
 const selectedScripts=legacy?[]:selected.scripts.filter(e=>!isUI(norm(e))&&!viewerData(e)).map(e=>{
  if(norm(e)==='lua/system/reforged_unit_handoff_03711.lua')return {...e,data:require('./blueprint-startup.cjs').fixUnitBindingStartup(e.data)};
  // Recorded 0.35.x rules use their original AI, units and balance.
  // Only the blueprint loader environment changes when those rules are replayed.
  if(!['0350','0351'].includes(revision)||norm(e)!=='lua/system/blueprints.lua')return e;
  return {...e,data:require('./blueprint-startup.cjs').fixBlueprintStartup(e.data)};
 });
 const scripts=current.scripts.filter(e=>isUI(norm(e))&&!viewerData(e)).map(e=>legacy&&norm(e)==='lua/ui/game/gamemain_pc.lua'?{...e,data:Buffer.concat([Buffer.from('_G.ReforgedLegacyReplay = true\n'),e.data])}:e);
 // The current presentation is built with the same published rules as the selected simulation.
 const research=legacy?require('./research.cjs').viewerAssets(originalEntries):current.scripts.filter(viewerData);
 scripts.push(...selectedScripts,...research);
 // Models, projectiles and faction texture overrides follow the recording too.
 const overrides=[...current.overrides.filter(e=>norm(e).startsWith('textures/ui/')),...(legacy?[]:selected.overrides.filter(e=>!norm(e).startsWith('textures/ui/')))];
 const originals=new Map(originalEntries.map(e=>[norm(e),e]));
 const stockOrders=!legacy&&selected.manifest.stockOrders===true;
 const audit=stockOrders?selected.manifest.delegatedClasses.map(e=>({...e})):[];
 if(!stockOrders){
 for(const prefix of ['lua/','mods/dlc1/shadow/lua/'])for(const [suffix,kind]of [['sim/unit.lua','unit'],['sim/aibrain.lua','brain'],['sim/shield.lua','shield']]){
  const name=prefix+suffix,source=selectedScripts.find(e=>norm(e)===name)||originals.get(name);assert.ok(source,'Missing selected replay class '+name);
  const saved='lua/rf0312_replay_'+(prefix.startsWith('mods')?'dlc_':'')+kind+'_original.lua';
  const existing=scripts.findIndex(e=>norm(e)===name);if(existing>=0)scripts.splice(existing,1);
  const action=kind==='brain'?"SyncScores=telemetry.WrapSync(SyncScores)\ntelemetry.InstallResearch(AIBrain)":kind==='unit'?"telemetry.InstallDamage(Unit,'TakeDamage',false)\ntelemetry.InstallKills(Unit)":"telemetry.InstallDamage(Shield,'OnDamage',true)";
  scripts.push({name:saved,data:source.data},{name,data:Buffer.from("doscript('/"+saved+"',getfenv(1))\nlocal telemetry=import('/lua/sim/reforged_replaystats.lua')\n"+action+'\n')});
  audit.push({path:name,delegatedPath:saved,sha256:hash(source.data)});
 }
 scripts.push({name:'lua/sim/reforged_replaystats.lua',data:fs.readFileSync(path.join(__dirname,'reforged_replaystats.lua'))});
 }
 if(!scripts.some(e=>norm(e)==='lua/sim/reforged_research_tracking.lua'))scripts.push({name:'lua/sim/reforged_research_tracking.lua',data:fs.readFileSync(path.join(__dirname,'reforged_research_tracking.lua'))});
 assert.equal(new Set(scripts.map(norm)).size,scripts.length,'Duplicate replay script path');
 // Every selected non-instrumented simulation/resource entry remains exact.
 for(const source of selectedScripts){if(audit.some(a=>a.path===norm(source)))continue;const same=scripts.find(e=>norm(e)===norm(source));assert.ok(same&&same.data.equals(source.data),'Selected replay content changed: '+source.name);}
 return {...current,scripts,overrides,manifest:{...current.manifest,mode:'replay-presentation-0383',simulationRevision:revision,originalSimulation:legacy,stockOrders,...(stockOrders?{stockControlRevision:selected.manifest.stockControlRevision,originalBalance:true}:{}),...(selected.manifest.gameplay?{gameplay:selected.manifest.gameplay}:{}),gameplayOverrides:false,telemetryOnly:true,delegatedClasses:audit,scope:'Current replay controls/minimap with selected simulation rules preserved; replay-only statistics wrappers write private counters and UI Sync, never orders, economy, blueprints, RNG or AI behavior.'}};
}
module.exports={compose,isUI};
