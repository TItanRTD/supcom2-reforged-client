-- Public selected-patch capability data. Never consumes enemy handles.
Revision='evidence-ai-6'
local function number(v)return type(v)=='number'and v==v and v>=0 and v<math.huge end
local function flags(list)
 local out={}for k,v in pairs(list or{})do if type(v)=='string'then out[v]=true elseif type(k)=='string'and v==true then out[k]=true end end;return out
end
local function tokens(value)local out={}for token in string.gmatch(value or'','[%w_]+')do out[token]=true end;return out end
local converters={uub0704=true,ucb0704=true,uib0704=true}
function Describe(bp,weapons,projectiles,abilities)
 if type(bp)~='table'or type(bp.BlueprintId)~='string'then return nil,'invalid-blueprint'end
 local c=flags(bp.Categories);local e=bp.Economy or{}
 if not number(e.MassValue)or not number(e.EnergyValue)then return nil,'missing-cost'end
 local mobile,structure=c.MOBILE==true,c.STRUCTURE==true
 local physical=c.AIR and mobile and'Air'or c.NAVAL and'Water'or'Land'
 local production={};local buildable=e.BuildableCategory or{}
 if type(buildable)=='string'then buildable={buildable}end
 for _,rule in ipairs(buildable)do for domain in string.gmatch(rule,'[%w_]+')do if domain=='AIR'then production.air=true elseif domain=='LAND'then production.land=true elseif domain=='NAVAL'then production.naval=true end end end
 local command=c.COMMAND==true or c.COMMANDER==true
 local engineer=c.ENGINEER==true and not command
 local producer=c.FACTORY==true and #buildable>0 and not command and not engineer
 local productionLayer=production.air and not production.land and not production.naval and'air'or production.naval and not production.land and'naval'or c.AIR and'air'or'land'
 local caps,airRange,groundRange={},0,0
 local tacticalLaunch,tacticalIntercept,strategicLaunch,strategicIntercept,redirection=0,0,0,0,0
 local otherWeapons=false
 for index,entry in ipairs(bp.Weapons or{})do
  local w=type(entry)=='table'and entry or(weapons or{})[entry]
  if type(w)=='table'and number(w.MaxRadius)and w.WeaponCategory~='Death'and w.Label~='DeathWeapon'then
   local projectile=w.TargetType=='RULEWTT_Projectile'
   local restriction=tokens(w.TargetRestrictOnlyAllow)
   local p=w.ProjectileId and(projectiles or{})[string.lower(w.ProjectileId)]
   local pc=flags(p and p.Categories)
   if projectile then
    if w.Flare then redirection=math.max(redirection,w.MaxRadius)
    elseif restriction.STRATEGIC then strategicIntercept=math.max(strategicIntercept,w.MaxRadius)
    elseif restriction.TACTICAL then tacticalIntercept=math.max(tacticalIntercept,w.MaxRadius)end
   elseif number(w.Damage)and w.Damage>0 and not w.DummyWeapon then
    local cap={index=index,label=w.Label,blueprint=w.BlueprintId,targetType=w.TargetType,requires={},layers={},airRange=0,groundRange=0,
     minRange=w.MinRadius or 0,maxRange=w.MaxRadius,damage=w.Damage,radius=w.DamageRadius or 0,rate=w.RateOfFire or 0,
     initiallyDisabled=w.InitiallyDisabled==true,unpacks=w.WeaponUnpacks==true,needPrep=w.NeedPrep==true,
     salvoSize=w.MuzzleSalvoSize or 1,salvoDelay=w.MuzzleSalvoDelay or 0,rackSalvoSize=w.RackSalvoSize or 1,
     reload=w.RackSalvoReloadTime or 0,projectilesPerFire=w.ProjectilesPerOnFire or 1,
     only=w.TargetRestrictOnlyAllow,disallow=w.TargetRestrictDisallow,aboveWaterOnly=w.AboveWaterTargetsOnly==true}
    for tech,upgrade in pairs(bp.ResearchUpgrades or{})do if type(upgrade)=='table'and(upgrade.Weapons or{})[w.Label]==true then cap.requires[#cap.requires+1]=tech end end
    table.sort(cap.requires)
    for layer,value in pairs(w.FireTargetLayerCaps or{})do cap.layers[layer]=tokens(value)
     for target in pairs(cap.layers[layer])do
      if target=='Air'then cap.airRange=math.max(cap.airRange,w.MaxRadius)elseif target=='Land'or target=='Water'or target=='Seabed'or target=='Sub'then cap.groundRange=math.max(cap.groundRange,w.MaxRadius)end
     end
    end
    if pc.TACTICAL or w.Label=='TacticalMissile01'then cap.tactical=true;tacticalLaunch=math.max(tacticalLaunch,w.MaxRadius)
    elseif pc.STRATEGIC or w.NukeWeapon then cap.strategic=true;strategicLaunch=math.max(strategicLaunch,w.MaxRadius)
    else otherWeapons=true end
    airRange=math.max(airRange,cap.airRange);groundRange=math.max(groundRange,cap.groundRange);caps[#caps+1]=cap
   end
  end
 end
 local speed=physical=='Air'and(bp.Air or{}).MaxAirspeed or(bp.Physics or{}).MaxSpeed or 0;if not number(speed)then speed=0 end
 local intel=bp.Intel or{};local general=bp.General or{};local commandCaps=general.CommandCaps or{}
 local roles={scout=c.SCOUT==true or mobile and not command and not engineer and not commandCaps.RULEUCC_Attack and math.max(intel.RadarRadius or 0,intel.VisionRadius or 0)>=50,
  commander=command,engineer=engineer,producer=producer,factory=producer and structure,fixedFactory=producer and structure,
  defense=structure and c.DEFENSE==true,expansionDefense=structure and c.LIGHTPD==true,converter=converters[bp.BlueprintId]==true,
  economy=structure and(c.ECONOMIC==true or c.MASSEXTRACTION==true or c.MASSPRODUCTION==true or c.ENERGYPRODUCTION==true),
  reclaimer=c.RECLAIMER==true,fieldEngineer=c.FIELDENGINEER==true}
 local scripted
 if bp.BlueprintId=='uix0102'then scripted='pods';roles.support=true
 elseif bp.BlueprintId=='ucx0103'then scripted='charged-blast';roles.support=true
 elseif bp.BlueprintId=='uix0115'then scripted='vortex';roles.support=true
 elseif bp.BlueprintId=='uux0113d1'then scripted='deploy-cannon'end
 local scriptedRange
 if scripted=='pods'or scripted=='vortex'then
  for _,entry in ipairs(bp.Weapons or{})do local w=type(entry)=='table'and entry or(weapons or{})[entry]
   if w and(w.Label=='BodyAim'or w.Label=='DummyRange01'or w.DummyWeapon)and number(w.MaxRadius)then scriptedRange=math.max(scriptedRange or 0,w.MaxRadius)end
  end
 elseif scripted=='charged-blast'then scriptedRange=20 end -- native blast script's fixed radius
 local controlled=c.SELECTABLE==true and bp.BlueprintId~='uix0116'
 local combat=mobile and controlled and not(roles.scout or engineer or command or roles.reclaimer)
 roles.aa=combat and airRange>0;roles.siege=combat and groundRange>0 and(c.INDIRECTFIRE==true or scripted=='deploy-cannon')
 roles.mainline=combat and groundRange>0 and not roles.siege;roles.raider=roles.mainline and speed>=3 and physical~='Air'
 local shield=(bp.Defense or{}).Shield
 roles.support=roles.support or combat and(c.SHIELD==true or c.ANTIMISSILE==true or c.RADARJAMMER==true or c.DEFENSE and type(shield)=='table'and(shield.ShieldMaxHealth or 0)>0)
 roles.module=c.UPGRADEMODULE==true;roles.shield=type(shield)=='table'and(shield.ShieldMaxHealth or 0)>0
 roles.generator=structure and c.ENERGYPRODUCTION==true and not roles.converter
 roles.radar=(intel.RadarRadius or 0)>0;roles.gantry=structure and(c.EXPERIMENTALFACTORY==true or c.LANDGANTRYBUILDER==true or c.GANTRY==true)
 roles.research=structure and(c.RESEARCH==true or c.RESEARCHPRODUCTION==true or(e.ProductionPerSecondResearch or 0)>0)
 local abilityRules={}
 for _,entry in ipairs(bp.Abilities or{})do
  local id=type(entry)=='table'and entry.Blueprint or entry
  if type(id)=='string'then
   local rule=(abilities or{})[string.lower(id)]
   if rule then local resource=type(entry)=='table'and entry.Resource or rule.Resource
    abilityRules[id]={cooldown=rule.Cooldown or 0,duration=rule.Duration or 0,retrigger=rule.ActivationRetriggerDelay or 0,initiallyEnabled=rule.InitiallyEnabled~=false,
     activate=resource and resource.OnActivate,toggle=rule.CommandType=='EACT_Toggle'}
   end
  end
 end
 local layer=c.AIR and'air'or c.NAVAL and'naval'or'land'
 return{id=string.lower(bp.BlueprintId),revision=Revision,faction=c.UEF and'UEF'or c.CYBRAN and'CYBRAN'or c.ILLUMINATE and'ILLUMINATE'or'UNKNOWN',
  roles=roles,flags=c,mass=e.MassValue,energy=e.EnergyValue,weapons=caps,airRange=airRange,groundRange=groundRange,speed=speed,mobile=mobile,structure=structure,
  scriptManaged=bp.BlueprintId=='uix0116',scriptedRange=scriptedRange,physicalLayer=physical,layer=layer,productionLayer=productionLayer,outputs=production,buildable=buildable,controlled=controlled,scripted=scripted,
  motionType=(bp.Physics or{}).MotionType,commandCaps=commandCaps,abilities=bp.Abilities or{},abilityRules=abilityRules,researchUpgrades=bp.ResearchUpgrades or{},
  footprintX=(bp.Footprint or{}).SizeX or(bp.Physics or{}).SizeX or 2,footprintZ=(bp.Footprint or{}).SizeZ or(bp.Physics or{}).SizeZ or 2,
  buildRange=e.MaxBuildDistance or 10,radarRadius=intel.RadarRadius or 0,visionRadius=intel.VisionRadius or 0,
  tacticalLaunchRange=tacticalLaunch,tacticalInterceptRange=tacticalIntercept,strategicLaunchRange=strategicLaunch,strategicInterceptRange=strategicIntercept,redirectionRange=redirection,
  tacticalOnly=tacticalLaunch>0 and not otherWeapons,passiveConverterEnergy=bp.ReforgedPassiveConverter and e.MaintenanceConsumptionPerSecondEnergy or nil}
end
local function offers(producer,target)
 for _,rule in ipairs(producer.buildable or{})do
  local good=true;local positive=false
  for token in string.gmatch(rule,'%S+')do local minus=string.sub(token,1,1)=='-';local key=minus and string.sub(token,2)or token;local found=target.flags[key]or string.lower(key)==target.id
   if minus and found or not minus and not found then good=false end;if not minus then positive=true end
  end
  if good and positive then return true end
 end
 return false
end
function Build(all)
 local result={};for id,bp in pairs(all.Unit or{})do local d=Describe(bp,all.Weapon,all.Projectile,all.Ability);if d then result[string.lower(id)]=d end end
 for _,d in pairs(result)do if d.roles.producer then
  d.outputs={}
  for _,target in pairs(result)do if target.mobile and not(target.roles.engineer or target.roles.commander)and offers(d,target)then d.outputs[target.layer]=true end end
  local layer,count=nil,0;for name in pairs(d.outputs)do count=count+1;layer=name end
  d.productionLayer=count==1 and layer or count>1 and'mixed'or d.productionLayer
 end end
 return result
end
