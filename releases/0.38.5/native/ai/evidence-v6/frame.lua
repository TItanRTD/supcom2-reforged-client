-- Native simulation adapter. Enemy source properties are read only AFTER the
-- executable's per-army current-vision test. Observer Sync is never an input.
local effective=import('/lua/sim/reforged_ai_effective.lua')
local ownSet,ownCache,ownBrain={},{},nil
local function point(p)return{p[1],p[2],p[3]}end
function Distance(a,b)return math.sqrt((a[1]-b[1])^2+(a[3]-b[3])^2)end
function Catalog()
    local out={}
    for _,id in pairs(EntityCategoryGetUnitList(categories.ALLUNITS)or{})do
        local bp=GetUnitBlueprintByName(id)
        local description=bp and bp.ReforgedAI
        if description then assert(description.revision=='evidence-ai-6','Stale AI capability metadata')end
        if description then
            local d={};for k,v in pairs(description)do d[k]=v end
            d.roles={};for role,value in pairs(description.roles)do d.roles[role]=value end
            -- The stock fact cache stays immutable. These are public registered
            -- blueprint capabilities, never live opponent information.
            d.roles.reclaimer=d.flags.RECLAIMER==true
            d.roles.fieldEngineer=d.flags.FIELDENGINEER==true
            if d.roles.fieldEngineer then d.roles.mainline=false;d.roles.raider=false;d.roles.siege=false;d.roles.support=true end
            if d.flags.SNEAKOTRON then d.roles.support=true end
            if d.roles.reclaimer then
                for _,role in ipairs({'engineer','commander','mainline','aa','siege','raider','support'})do d.roles[role]=false end
            end
            local e=bp.Economy or{}
            d.buildTime=e.BuildTime;d.buildRate=e.BuildRate
            d.massProduction=e.ProductionPerSecondMass
            d.motionType=(bp.Physics or{}).MotionType
            d.navigationRadius=(bp.Navigation or{}).Radius
            if type(e.MassValue)=='number'and e.MassValue>=0 then d.mass=e.MassValue end
            if type(e.EnergyValue)=='number'and e.EnergyValue>=0 then d.energy=e.EnergyValue end
            out[string.lower(id)]=d
        end
    end
    return out
end
-- Native entity IDs are decimal text. Keep all 32 bits exact in LuaPlus,
-- whose numeric value can lose precision above 2^24.
function EntityKey(id)
    if type(id)=='number'then
        if id~=id or id<0 or id>16777215 or id~=math.floor(id)then return end
        id=string.format('%.0f',id)
    elseif type(id)~='string'or #id>10 or not string.match(id,'^%d+$')then return end
    id=string.gsub(id,'^0+','');if id==''then id='0'end
    if #id>10 or #id==10 and id>'4294967294'then return end
    return id
end
function IdLess(a,b)if #a~=#b then return #a<#b end return a<b end
function Own(brain)
    local out,ids,seen={},{},{}
    for _,u in pairs(brain:GetListOfUnits(categories.ALLUNITS,false)or{})do
        local ok,id=pcall(function()if u and not u:IsDead()and u:GetArmy()==brain:GetArmyIndex()then return EntityKey(u:GetEntityId())end end)
        if ok and id and not seen[id]then out[#out+1]=u;ids[u]=id;seen[id]=true end
    end
    table.sort(out,function(a,b)return IdLess(ids[a],ids[b])end)
    return out
end
function PrepareOwn(own,brain)
    ownSet={};ownCache={};ownBrain=brain
    for _,unit in ipairs(own)do ownSet[unit]=true end
end
function Describe(unit,catalog)
    local description=catalog[string.lower(unit:GetBlueprint().BlueprintId or'')]
    if description and ownSet[unit]then
        local cached=ownCache[unit]
        if not cached or cached.source~=description then cached={source=description,value=effective.Owned(description,unit,ownBrain)};ownCache[unit]=cached end
        return cached.value
    end
    return description
end
-- Per-engagement evidence, with a fresh native vision gate before every source
-- read. A shared cache lives for one controller step, never across samples.
-- Health loss shows activity at the target; it does not attribute damage to an
-- individual attacker. Losing vision is not evidence that the target died.
function CombatObserver(army,target,id,cacheProvider,actor,range)
    local previous
    local function sample()
        local cache=cacheProvider()
        if cache[id]then return cache[id]end
        local ok,result=pcall(function()
            local blip=target:GetBlip(army)
            if not blip or not blip:IsSeenNow(army)then return{visible=false}end
            if target:IsDead()then return{visible=true,dead=true}end
            local owner=target:GetArmy()
            if owner==army or type(IsAlly)=='function'and IsAlly(army,owner)then return{visible=true,friendly=true}end
            local health=target:GetHealth()
            if type(health)~='number'or health~=health or math.abs(health)==math.huge then return{visible=true}end
            return{visible=true,health=health,position=point(target:GetPosition())}
        end)
        result=ok and result or{visible=false}
        cache[id]=result;return result
    end
    previous=sample().health
    return function()
        local s=sample()
        if not s.visible then return'lost',{target=id,cause='target-not-in-current-vision'}end
        if s.dead then return'completed',{target=id,cause='visible-target-destroyed'}end
        if s.friendly then return'released',{target=id,cause='visible-target-no-longer-hostile'}end
        if s.health then
            local delta=previous and previous-s.health or 0;previous=s.health
            if delta>.01 and type(range)=='number'and range>0 and Distance(actor:GetPosition(),s.position)<=range+3 then
                return'progress',{target=id,cause='visible-target-health-decreased',healthRemaining=s.health,healthLost=delta}
            end
        end
        return'visible'
    end
end
function ResearchedCatalog(brain,catalog)
    local definitions=import('/lua/sim/Research.lua').ResearchDefinitions
    local ok,buffs=pcall(function()return Buffs or import('/lua/sim/Buff.lua').Buffs end)
    local result={}
    for id,d in pairs(catalog)do
        local r=effective.Researched(d,brain,definitions,ok and buffs or{})
        r.baseWeapons=d.weapons;r.baseSpeed=d.speed
        local combat=r.mobile and r.controlled and not(r.roles.scout or r.roles.engineer or r.roles.commander or r.roles.reclaimer)
        r.roles.aa=combat and r.airRange>0;r.roles.mainline=combat and r.groundRange>0 and not r.roles.siege
        r.roles.raider=r.roles.raider and r.roles.mainline
        result[id]=r
    end
    return result
end
function Observe(brain,own,memory,catalog,now,cursor,previousTargets,priorityTargets)
    local seen,targets={},{}
    local function observe(enemy)
        pcall(function()
                -- DO NOT reorder these reads. GetBlip is the only source-unit
                -- call permitted before current vision has been established.
                local alive,blip=pcall(function()return enemy:GetBlip(brain:GetArmyIndex())end)
                if not alive then return end
                if blip and blip:IsSeenNow(brain:GetArmyIndex())then
                    local id=tostring(enemy:GetEntityId())
                    if not seen[id]then
                        seen[id]=true
                        if enemy:IsDead()then memory:Observe({id=id,channel='vision',event='destroyed'},now)
                        else
                            -- Previously observed handles can change army, or
                            -- diplomacy can change between sensor samples.
                            -- Check only AFTER vision, before position/HP/BP.
                            local army=brain:GetArmyIndex();local owner=enemy:GetArmy()
                            if owner==army or type(IsAlly)=='function'and IsAlly(army,owner)then
                                memory:Observe({id=id,channel='vision',event='no-longer-hostile'},now)
                                return
                            end
                            local bp=enemy:GetBlueprint();local d=catalog[string.lower(bp.BlueprintId or'')]
                            local role=d and(d.roles.commander and'commander'or d.roles.engineer and'engineer'or d.structure and'structure'or d.layer)or'unknown'
                            memory:Observe({id=id,channel='vision',blueprint=string.lower(bp.BlueprintId or''),position=point(enemy:GetPosition()),
                                health=math.min(1,math.max(0,enemy:GetHealth()/math.max(1,enemy:GetMaxHealth()))),role=role,stationary=d and d.structure==true,layer=type(enemy.GetCurrentLayer)=='function'and enemy:GetCurrentLayer()or nil},now)
                            if type(blip.GetEntityId)=='function'then memory:Associate(id,'radar-'..tostring(blip:GetEntityId()),now)end
                            targets[id]=enemy
                        end
                    end
                elseif blip and type(blip.IsOnRadar)=='function'and blip:IsOnRadar(brain:GetArmyIndex())
                    and type(blip.GetPosition)=='function'and type(blip.GetEntityId)=='function'then
                    -- Read only the recon entity's reported position/identity.
                    -- A radar-only source unit's blueprint/HP are never queried.
                    local id='radar-'..tostring(blip:GetEntityId())
                    local canonical=memory:Resolve(id,now)
                    if not seen[canonical]then seen[canonical]=true;memory:Observe({id=id,channel='radar',position=point(blip:GetPosition())},now)end
                end
        end)
    end
    -- Known engagement handles are rechecked through THIS army's visual blip
    -- before any fresh position/health/classification read. Rotation of the
    -- spatial sensor budget must not itself make a visible target disappear.
    local ids={};for id in pairs(previousTargets or{})do ids[#ids+1]=id end;table.sort(ids)
    local checked={};local count=0
    for _,id in ipairs(priorityTargets or{})do if previousTargets and previousTargets[id]and not checked[id]and count<8 then observe(previousTargets[id]);checked[id]=true;count=count+1 end end
    for i=1,math.min(16,#ids)do local id=ids[(math.floor(now)*16+i-1)%#ids+1]
     if not checked[id]and count<16 then observe(previousTargets[id]);checked[id]=true;count=count+1 end
    end
    -- Cover home and a rotating sample of OWN sensor carriers. This caps native
    -- spatial queries; hidden entities never consume the visible contact cap.
    local sources={};local n=#own
    for i=1,math.min(4,n)do sources[#sources+1]=own[(cursor+i-1)%n+1]end
    for _,u in ipairs(own)do local d=Describe(u,catalog);if d and d.roles.commander then sources[#sources+1]=u;break end end
    for _,sensor in ipairs(sources)do
        local radius=math.max(sensor:GetIntelRadius('Vision')or 0,sensor:GetIntelRadius('Radar')or 0)
        if radius>0 and sensor:GetFractionComplete()>=1 then
            local candidates=brain:GetUnitsAroundPoint(categories.ALLUNITS,sensor:GetPosition(),radius+2,'Enemy')or{}
            for _,enemy in pairs(candidates)do
                observe(enemy)
            end
        end
    end
    -- Unsampled or no-longer-visible contacts remain memory, never fresh targets.
    for _,old in ipairs(memory:Snapshot(now)or{})do if not seen[old.id]then memory:Observe({id=old.id,channel='lost'},now)end end
    local snapshot=memory:Snapshot(now);local retained={}
    for _,c in ipairs(snapshot)do retained[c.id]=true end
    for id,handle in pairs(previousTargets or{})do if retained[id]and not seen[id]then targets[id]=handle end end
    return snapshot,targets,(cursor+4)%math.max(1,n)
end
function PublicMap(brain)
    local size=ScenarioInfo.size or{512,512};local width,height=size[1],size[2]
    local own=point(brain:GetStartVector3f());local starts,mass={},{}
    local markers=import('/lua/sim/ScenarioUtilities.lua').GetMarkers()or{}
    for name,marker in pairs(markers)do
        local p=marker.position
        if p and p[1]>=0 and p[1]<=width and p[3]>=0 and p[3]<=height then
            if marker.type=='Mass'then mass[#mass+1]={id=tostring(name),position=point(p)}
            elseif string.match(tostring(name),'^ARMY_%d+$')and Distance(p,own)>2 then starts[#starts+1]={id=tostring(name),position=point(p)}end
        end
    end
    table.sort(starts,function(a,b)return a.id<b.id end)
    table.sort(mass,function(a,b)local da,db=Distance(a.position,own),Distance(b.position,own);return da<db or da==db and a.id<b.id end)
    while #starts>8 do table.remove(starts)end;while #mass>256 do table.remove(mass)end
    return{key=tostring(ScenarioInfo.name or ScenarioInfo.map or'public-map'),width=width,height=height,ownStart=own,candidateStarts=starts,massSites=mass}
end
-- Conservative public base prices. The supplied retail Lua construct model
-- returns zero currency costs; no zero is treated as a free purchase here.
-- Research discounts can make this budget conservative; native Issue* still
-- performs the real legality/payment checks, with task acknowledgement below.
function Quote(builder,d)
    if d and builder:CanBuild(d.id)then return{legal=true,canBuild=true,mass=d.mass,energy=d.energy,source='public-base-conservative'}end
end
function Ready(unit)local ok,stunned=pcall(function()return unit:IsUnitState('Stunned')end);return not unit:IsDead()and unit:GetFractionComplete()>=1 and not(ok and stunned)and unit:IsIdleState()end
function Point(x,z)return Vector(x,GetTerrainHeight(x,z),z)end
