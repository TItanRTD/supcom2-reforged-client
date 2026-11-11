import json
import os
from pathlib import Path
from zipfile import ZipFile
from lupa.lua51 import LuaRuntime

root=Path(__file__).resolve().parent
fixtures=json.loads((root/'build/ai-fixtures.json').read_text())
unit_data=json.loads((root.parent/'ai-handoff/SupCom2-Reforged-Complete-AI-Handoff/studies/10-land-air-decisions/inputs/units.json').read_text())
research=json.loads((root.parent/'ai-handoff/SupCom2-Reforged-Complete-AI-Handoff/studies/10-land-air-decisions/inputs/research.json').read_text())
with ZipFile(root.parent/'orion-base/retail/uncompiled_lua.scd') as archive:
    definitions={name.replace('\\','/').lower().removeprefix('uncompiled'):archive.read(name).decode('cp1252')
                 for name in archive.namelist() if name.lower().endswith(('_proj.bp','_ability.bp'))}

def table(lua,value):
    if isinstance(value,dict):return lua.table_from({k:table(lua,v) for k,v in value.items()})
    if isinstance(value,list):return lua.table_from([table(lua,v) for v in value])
    return value

bootstrap='''
assert(import==nil)
all={Unit=unitData,Mesh={},Weapon={},Projectile={},RawAnim={},Ability={}}
local source
function LOG()end
function Sound(v)return v end
function ModBlueprints()end
function doscript(file,env)
 file=string.gsub(string.lower(file),'\\\\','/')
 if file=='/lua/system/rf026_blueprints_original.lua'or file=='/lua/rf_replay_ai_retail_blueprints.lua'then return end
 local chunk=assert(loadstring(assert(files[string.sub(file,2)],file),'@'..file));setfenv(chunk,env or getfenv(2))
 local previous=source;source=file;local value=chunk();source=previous;return value
end
function UnitBlueprint(bp)all.Unit[bp.BlueprintId]=bp end
function MeshBlueprint(bp)all.Mesh[bp.BlueprintId]=bp end
function WeaponBlueprint(bp)all.Weapon[bp.BlueprintId]=bp end
function ProjectileBlueprint(bp)bp.Source=bp.Source or source;all.Projectile[bp.Source]=bp end
function AbilityBlueprint(bp)
 bp.BlueprintId=bp.BlueprintId or string.match(source,'/([^/]+)_ability.bp$')
 all.Ability[string.lower(bp.BlueprintId)]=bp
end
function RawAnimBlueprint(bp)for id,v in pairs(bp)do all.RawAnim[id]=v end end
for id,bp in pairs(all.Unit)do
 bp.BlueprintId=id
 local faction=string.sub(id,2,2)=='i'and'illuminate'or string.sub(id,2,2)=='c'and'cybran'or'uef'
 bp.Source='/units/'..faction..'/'..id..'/'..id..'_unit.bp'
end
for path,code in pairs(definitionData)do source=path;assert(loadstring(code,'@'..path))()end
for path,code in pairs(files)do if string.match(path,'%.bp$')and(string.match(path,'^projectiles/')or string.match(path,'^abilities/'))then source='/'..path;assert(loadstring(code,'@'..path))()end end
doscript('/lua/system/blueprints.lua',getfenv(1))
ModBlueprints(all)
-- Runtime modules share native globals, but each import has its own namespace.
local cache={}
local clock=0
function GetGameTick()return math.floor(clock*10)end
function GetGameTimeSeconds()return clock end
function SetClock(value)clock=value end
function GetTerrainHeight()return 0 end
function GetSurfaceHeight()return 0 end
function Vector(x,y,z)return{x,y,z}end
function ArmyGetHandicap()return 0 end
function IsAlly(a,b)return a==b end
ScenarioInfo={name='controlled-fixture',size={256,256},Options={UnitCap=1000,RandomSeed=17,Victory='assassination'}}
categories={ALLUNITS='all'}
function EntityCategoryGetUnitList()local out={}for id in pairs(all.Unit)do out[#out+1]=id end;return out end
function GetUnitBlueprintByName(id)return all.Unit[string.lower(id)]end
function import(file)
 file=string.lower(file)
 if cache[file]then return cache[file]end
 if file=='/lua/sim/research.lua'then return{ResearchDefinitions=researchData}end
 if file=='/lua/sim/buff.lua'then return{Buffs={}}end
 if file=='/lua/sim/scenarioutilities.lua'then return{GetMarkers=function()return PublicMarkers or{}end}end
 if file=='/lua/sim/reforged_reclaim.lua'and not useRealReclaim then return{Collect=function()return{},nil,nil,{}end,Visible=function()return false end}end
 local env=setmetatable({}, {__index=_G});cache[file]=env
 local chunk=assert(loadstring(assert(files[string.sub(file,2)],file),'@'..file));setfenv(chunk,env);chunk();return env
end
nativeCalls={clear=0,move=0,attack=0,ability=0,build=0}
function IssueClearCommands(units)nativeCalls.clear=nativeCalls.clear+1;for _,u in ipairs(units)do u.order=nil end end
function IssueMove(units,p)nativeCalls.move=nativeCalls.move+1;for _,u in ipairs(units)do u.order={kind='move',position=p}end end
function IssueAggressiveMove(units,p)IssueMove(units,p)end
function IssueAttack(units,target)nativeCalls.attack=nativeCalls.attack+1;for _,u in ipairs(units)do u.order={kind='attack',target=target}end end
function IssueAbility()nativeCalls.ability=nativeCalls.ability+1 end
function IssueBuildFactory()nativeCalls.build=nativeCalls.build+1 end
function IssueBuildMobile()nativeCalls.build=nativeCalls.build+1 end
function IssueGuard()end
function IssueRepair()end
function IssueTeleport(units,p)IssueMove(units,p)end
function IssueJump(units,p)IssueMove(units,p)end
function IssueReclaim()end
function Brain()
 local brain={units={},researched={},mass=5000,energy=10000,points=100,ReforgedAILevel='reforger',BrainType='AI',AIType='Normal',BuildBonus=0,ResBonus=0,VetBonus=0,IntelType='None',army=1}
 function brain:GetArmyIndex()return self.army end
 function brain:GetFactionIndex()return 1 end
 function brain:GetStartVector3f()return{20,0,20}end
 function brain:GetListOfUnits()return self.units end
 function brain:HasResearched(id)return self.researched[id]==true end
 function brain:GetEconomyStored(kind)return kind=='MASS'and self.mass or kind=='ENERGY'and self.energy or self.points end
 function brain:GetEconomyIncome(kind)return kind=='RESEARCH'and .01 or 2 end
 function brain:GetEconomyRequested()return 1 end
 function brain:GetUnitsAroundPoint()return self.enemies or{}end
 function brain:CanBuildStructureAt()return false end
 function brain:StartResearch()end
 brain.ReforgedAITrace={events={}}
 function brain.ReforgedAITrace:Event(tick,event,fields)self.events[#self.events+1]={event=event,fields=fields}end
 return brain
end
function Unit(id,bp,brain,position)
 local u={id=tostring(id),bp=bp,brain=brain,position=position or{20,0,20},hp=100,maxhp=100,fraction=1,states={},abilities={},legal={}}
 function u:GetEntityId()return self.id end
 function u:GetBlueprint()return self.bp end
 function u:GetArmy()return self.brain.army end
 function u:GetAIBrain()return self.brain end
 function u:IsDead()return self.dead==true end
 function u:GetPosition()return self.position end
 function u:GetHealth()return self.hp end
 function u:GetMaxHealth()return self.maxhp end
 function u:GetFractionComplete()return self.fraction end
 function u:IsIdleState()return self.order==nil end
 function u:GetCurrentLayer()return self.layer or(self.bp.ReforgedAI and self.bp.ReforgedAI.physicalLayer)or'Land'end
 function u:IsUnitState(name)return self.states[name]==true end
 function u:IsUnitAbilityState(name,state)return state=='Activated'and self.abilities[name]==true end
 function u:TestCommandCaps(name)return self.capsDisabled~=true and(self.bp.General.CommandCaps or{})[name]==true end
 function u:GetUnitBeingBuilt()return self.child end
 function u:CanBuild(id)return self.legal[id]==true end
 function u:GetIntelRadius()return 50 end
 function u:GetWeapon()return nil end
 function u:CanPathTo(p)return self.pathBlocked~=true end
 function u:GetTeleportRange()return(self.bp.General or{}).TeleportRange or 70 end
 function u:GetJumpRange()return(self.bp.General or{}).JumpRange or 70 end
 return u
end
'''

cache={}
lifecycle_results=[]
suite=os.environ.get('AI_SUITE','contracts')
cases=[(f'{p}/{m}',f,1,'normal',False)for p,f in fixtures.items()for m in ['lua51','native-string-api']] if suite=='contracts' else [(f'{p}/native-string-api/{faction}/{scenario}',f,faction,scenario,False)for p,f in fixtures.items()if p!='edited' for faction in [1,2,3]for scenario in ['normal','water-gap','missing-starts','deferred-route']]+[(f'plus/native-string-api/old/{faction}',fixtures['plus'],faction,'normal',True)for faction in [1,2,3]]
for case,fixture,faction,scenario,old in cases:
    profile,mode=case.split('/')[:2]
    lua=LuaRuntime();case_files=dict(fixture['files'])
    if old:case_files['lua/sim/reforged_ai_controller.lua']=(root.parent/'work-0385/payload/resources/native/ai/evidence-v5/controller.lua').read_text()
    lua.globals().files=table(lua,case_files);lua.globals().unitData=table(lua,unit_data)
    lua.globals().researchData=table(lua,research);lua.globals().definitionData=table(lua,definitions)
    if mode=='native-string-api':lua.execute('debug.setmetatable("",nil)')
    lua.execute(bootstrap)
    active=fixture['files'].get('mods/dlc1/shadow/lua/sim/research.lua') or fixture['files'].get('lua/sim/research.lua')
    if active:
        lua.globals().activeResearch=active
        lua.execute("local env=setmetatable({}, {__index=_G});local f=assert(loadstring(activeResearch));setfenv(f,env);f();researchData=env.ResearchDefinitions")
    lua.execute("for id,bp in pairs(all.Unit)do if bp.Economy and bp.Economy.MassValue and bp.Economy.EnergyValue then assert(bp.ReforgedAI and bp.ReforgedAI.revision=='evidence-ai-6',id)end end")
    lua.globals().useRealReclaim=suite=='opening'
    lua.globals().fixtureFaction=faction;lua.globals().fixtureScenario=scenario;lua.globals().expectOld=old
    lua.execute((root/('ai-contracts.lua' if suite=='contracts' else 'ai-opening-sim.lua')).read_text())
    if suite=='opening':
        lifecycle=dict(lua.globals().lifecycle.items());lifecycle_results.append({'case':case,**lifecycle});print(case,lifecycle,flush=True)
    print(case,'registered capabilities and',lua.globals().passed,'AI contract checks passed.')
    catalog=lua.eval('function()local out={}for id,bp in pairs(all.Unit)do if bp.ReforgedAI then out[id]=bp.ReforgedAI end end;return out end')()
    def plain(value):
        if hasattr(value,'items'):
            values=dict(value.items())
            if values and all(isinstance(k,int) for k in values) and set(values)==set(range(1,len(values)+1)):
                return [plain(values[i]) for i in range(1,len(values)+1)]
            return {str(k):plain(v) for k,v in values.items()}
        return value
    cache[profile]=plain(catalog)
if suite=='contracts':
    (root/'build/ai-public-capabilities.json').write_text(json.dumps({'revision':'evidence-ai-6','profiles':cache},separators=(',',':')))
else:
    (root/'opening-results.json').write_text(json.dumps({'type':'controlled-native-api-fixture','durationSeconds':180,'oldAI5Controls':3,'correctedAI6Cases':36,'cases':lifecycle_results},indent=2)+'\n')
