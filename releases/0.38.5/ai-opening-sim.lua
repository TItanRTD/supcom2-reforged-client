-- Controlled lifecycle feedback: paid builds, construction, income and production.
-- Terrain/path/command adapters are fixtures, not a native match or replay engine.
passed=0
local function check(v,msg)assert(v,msg);passed=passed+1 end
ArmyBrains={}
function Rect(x0,z0,x1,z1)return{x0,z0,x1,z1}end
function GetReclaimablesInRect()return{}end
local controller=import('/lua/sim/reforged_ai_controller.lua')
local frame=import('/lua/sim/reforged_ai_frame.lua')
local factions={{prefix='uu',name='UEF',tank='uul0101'},{prefix='uc',name='CYBRAN',tank='ucl0103'},{prefix='ui',name='ILLUMINATE',tank='uil0101'}}
local faction=factions[fixtureFaction];local brain=Brain();brain.factionIndex=fixtureFaction;brain.mass=1500;brain.energy=4000;brain.points=0;brain.home={40,0,40};ArmyBrains[1]=brain
function brain:GetFactionIndex()return self.factionIndex end
function brain:GetStartVector3f()return self.home end
ScenarioInfo={name='opening-lifecycle-'..fixtureScenario,size={256,256},Options={UnitCap=1000,RandomSeed=17,Victory='assassination'}}
PublicMarkers={}
if fixtureScenario~='missing-starts'then PublicMarkers.ARMY_1={type='Blank Marker',position={40,0,40}};PublicMarkers.ARMY_2={type='Blank Marker',position={216,0,216}}end
for i=1,8 do PublicMarkers['mass'..i]={type='Mass',position={20+(i%4)*18,0,74+math.floor(i/4)*20}}end
if fixtureScenario=='water-gap'then
 function GetTerrainHeight(x,z)return x>100 and x<155 and-5 or 0 end
 function GetSurfaceHeight()return 0 end
end
local serial=100;local jobs={};local paid={};local militaryMoves=0;local firstFactory,firstCombat;local spentMass,spentEnergy=0,0;local receivedMass,receivedEnergy=0,0
local function add(id,position)
 serial=serial+1;local bp=assert(all.Unit[id],id);local u=Unit(serial,bp,brain,position);local d=bp.ReforgedAI;u.legal={}
 if d.roles.commander or d.roles.engineer then
  for _,suffix in ipairs({'b0001','b0002','b0701','b0702','b0301'})do local target=faction.prefix..suffix;if all.Unit[target]then u.legal[target]=true end end
 elseif d.roles.factory then
  if d.outputs and d.outputs.land then u.legal[faction.tank]=true;u.legal[faction.prefix..'l0002']=true end
  if d.outputs and d.outputs.air then
   local fighter,bomber
   for uid,blueprint in pairs(all.Unit)do local x=blueprint.ReforgedAI
    if x and x.faction==faction.name and x.mobile and x.physicalLayer=='Air'and x.controlled and not x.flags.EXPERIMENTAL and x.mass>0 then
     if x.airRange>0 and(not fighter or x.mass<all.Unit[fighter].ReforgedAI.mass)then fighter=uid end
     if x.groundRange>0 and(not bomber or x.mass<all.Unit[bomber].ReforgedAI.mass)then bomber=uid end
    end
   end
   if fighter then u.legal[fighter]=true end;if bomber then u.legal[bomber]=true end;u.legal[faction.prefix..'l0002']=true
  end
 end
 function u:CanPathTo(p)
  local motion=(self.bp.Physics or{}).MotionType
  if fixtureScenario=='water-gap'and motion=='RULEUMT_Land'and(self.position[1]<100 and p[1]>155 or self.position[1]>155 and p[1]<100)then return false end
  return true
 end
 brain.units[#brain.units+1]=u;return u
end
add(faction.prefix..'l0001',{40,0,40});add(faction.prefix..'l0002',{36,0,40});add(faction.prefix..'l0002',{44,0,40})
function brain:GetEconomyIncome(kind)
 local amount=0
 for _,u in ipairs(self.units)do if not u:IsDead()and u.fraction>=1 then local e=u.bp.Economy or{}
  amount=amount+(kind=='MASS'and(e.ProductionPerSecondMass or 0)or kind=='ENERGY'and(e.ProductionPerSecondEnergy or 0)or(e.ProductionPerSecondResearch or 0))
 end end
 return amount/10
end
function brain:GetEconomyRequested()return .05 end
function brain:CanBuildStructureAt(id,p)
 return p[1]>=4 and p[3]>=4 and p[1]<=252 and p[3]<=252 and GetTerrainHeight(p[1],p[3])>=-.5
end
local function issue(units,p,id,kind)
 nativeCalls.build=nativeCalls.build+1
 local actor=units[1];local bp=assert(all.Unit[id],id);local e=bp.Economy;local now=GetGameTimeSeconds()
 if not actor:CanBuild(id)or brain.mass<e.MassValue or brain.energy<e.EnergyValue then return end
 brain.mass=brain.mass-e.MassValue;brain.energy=brain.energy-e.EnergyValue;spentMass=spentMass+e.MassValue;spentEnergy=spentEnergy+e.EnergyValue
 local position=p or{actor.position[1]+4,0,actor.position[3]+4};local child=add(id,position);child.fraction=.001;actor.child=child;actor.order={kind=kind,child=child}
 local duration=math.max(1,(e.BuildTime or 20)/((actor.bp.Economy or{}).BuildRate or 1))
 jobs[#jobs+1]={actor=actor,child=child,start=now,duration=duration};paid[#paid+1]={id=id,kind=kind,at=now,mass=e.MassValue,energy=e.EnergyValue}
 if bp.ReforgedAI.roles.factory and not firstFactory then firstFactory=now end
 if bp.ReforgedAI.mobile and(bp.ReforgedAI.groundRange>0 or bp.ReforgedAI.airRange>0) and not(bp.ReforgedAI.roles.commander or bp.ReforgedAI.roles.engineer)and not firstCombat then firstCombat=now end
end
function IssueBuildMobile(units,p,id)issue(units,p,id,'build')end
function IssueBuildFactory(units,id)issue(units,nil,id,'produce')end
function IssueGuard(units,target)for _,u in ipairs(units)do u.order={kind='guard',target=target}end end
function IssueRepair(units,target)for _,u in ipairs(units)do u.order={kind='repair',target=target}end end
function IssueReclaim()end
local nativeMove=IssueMove
function IssueMove(units,p)
 for _,u in ipairs(units)do local d=u.bp.ReforgedAI;if d.mobile and(d.groundRange>0 or d.airRange>0)and not(d.roles.commander or d.roles.engineer)then militaryMoves=militaryMoves+1 end end
 return nativeMove(units,p)
end
function brain:StartResearch(id)
 local d=researchData[id];if not d or self.researched[id]or self.points<(d.COST or 0)or self.mass<(d.MASS or 0)or self.energy<(d.ENERGY or 0)then return end
 self.points=self.points-(d.COST or 0);self.mass=self.mass-(d.MASS or 0);self.energy=self.energy-(d.ENERGY or 0);self.researched[id]=true
 spentMass=spentMass+(d.MASS or 0);spentEnergy=spentEnergy+(d.ENERGY or 0)
end
local state=controller.Create(brain)
if fixtureScenario=='deferred-route'then
 local route=state.topology.Route
 state.topology.Route=function(self,a,b,layer)if GetGameTimeSeconds()<12 and layer~='air'then return nil,'route-budget'end;return route(self,a,b,layer)end
end
local function feedback(now,dt)
 for _,job in ipairs(jobs)do
  if job.actor.order and job.actor.order.child==job.child then
   job.child.fraction=math.min(1,(now-job.start)/job.duration)
   if job.child.fraction>=1 then job.actor.child=nil;job.actor.order=nil end
  end
 end
 local m,e=brain:GetEconomyIncome('MASS')*10*dt,brain:GetEconomyIncome('ENERGY')*10*dt
 brain.mass=brain.mass+m;brain.energy=brain.energy+e;brain.points=brain.points+brain:GetEconomyIncome('RESEARCH')*10*dt;receivedMass=receivedMass+m;receivedEnergy=receivedEnergy+e
 for _,u in ipairs(brain.units)do
  if u.order and u.order.kind=='move'then local p=u.order.position;local dx,dz=p[1]-u.position[1],p[3]-u.position[3];local distance=math.sqrt(dx*dx+dz*dz);local step=math.min(distance,(u.bp.ReforgedAI.speed or 1)*dt)
   if distance>0 then u.position={u.position[1]+dx/distance*step,0,u.position[3]+dz/distance*step}end
   if distance<=1 then u.order=nil end
  end
 end
end
for i=1,360 do local now=i*.5;SetClock(now);feedback(now,.5);state:Step();check(state.orders<=6,'Native-call allowance exceeded during opening lifecycle')end
local factories,combat=0,0
for _,u in ipairs(brain.units)do local d=u.bp.ReforgedAI
 if u.fraction>=1 and d.roles.factory then factories=factories+1 end
 if u.fraction>=1 and d.mobile and(d.groundRange>0 or d.airRange>0) and not(d.roles.commander or d.roles.engineer)then combat=combat+1 end
end
if expectOld then
 check(not firstFactory and factories==0,'Old AI5 should reproduce the permanent opening stall')
 check(not state.opening,'Old opening unexpectedly recovered')
else
 check(firstFactory and firstFactory<=20,'No paid first factory within the opening window: '..tostring(firstFactory))
 check(factories>0 and firstCombat and firstCombat<=100 and combat>0,'Factory failed to produce a paid combat unit: '..tostring(firstCombat))
 check(state.opening~=nil,'No selected or temporary legal opening')
 if fixtureScenario=='normal'or fixtureScenario=='deferred-route'then check(not state.opening.bootstrap,'Temporary opening did not return to the public map analysis');check(militaryMoves>0,'Paid army never received an operational movement order')end
 if fixtureScenario=='water-gap'then
  check(state.map.candidateStarts[1].commander.reachable and not state.map.candidateStarts[1].land.reachable,'Amphibious commander incorrectly certified the ground route')
 end
 check(spentMass>240 and spentEnergy>=600 and brain.mass<=1500+receivedMass and brain.energy<=4000+receivedEnergy,'Construction/production bypassed modeled native payment')
end
lifecycle={old=expectOld,faction=faction.name,scenario=fixtureScenario,firstFactory=firstFactory,firstCombat=firstCombat,completedFactories=factories,completedCombat=combat,militaryMoves=militaryMoves,spentMass=spentMass,spentEnergy=spentEnergy}
