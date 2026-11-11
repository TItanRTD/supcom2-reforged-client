-- Synchronized Reforged skirmish controller. All money, research, construction,
-- movement and damage come from ordinary engine rules. No enemy brain reads.
local effective=import('/lua/sim/reforged_ai_effective.lua')
local operations=import('/lua/sim/reforged_ai_operations.lua')
local policy=import('/lua/sim/reforged_ai_policy.lua')
local frame=import('/lua/sim/reforged_ai_frame.lua')
local strategy=import('/lua/sim/reforged_ai_strategy.lua')
local openings=import('/lua/sim/reforged_ai_openings.lua')
local knowledge=import('/lua/sim/reforged_ai_knowledge.lua')
local taskModule=import('/lua/sim/reforged_ai_tasks.lua')
local tactics=import('/lua/sim/reforged_ai_tactics.lua')
local planning=import('/lua/sim/reforged_ai_planning.lua')
local logistics=import('/lua/sim/reforged_ai_logistics.lua')
local traceModule=import('/lua/sim/reforged_ai_trace.lua')
local director=import('/lua/sim/reforged_ai_director.lua')
local campaign=import('/lua/sim/reforged_ai_campaign.lua')
local expansion=import('/lua/sim/reforged_ai_expansion.lua')
local ruleset=import('/lua/sim/reforged_ai_ruleset.lua')
-- Retail simInit.lua implements WaitSeconds(n) as WaitTicks(n * 10).
-- GetSimTicksPerSecond is registered in the UI state, not the simulation.
local SIM_TICKS_PER_SECOND=10
local levels={Easy='easy',Normal='normal',Hard='hard',Reforger='reforger',Cheat='reforger'}
function Level(key)return levels[key]end
local function finite(n)return type(n)=='number'and n==n and n>=0 and n<math.huge end
local function safe(fn,...)local ok,v=pcall(fn,...);if ok then return v end end
local function log(self,event,fields)
    self.trace:Event(GetGameTick(),event,fields)
end
local function trace(brain)
    if not brain.ReforgedAITrace then brain.ReforgedAITrace=traceModule.Create(brain:GetArmyIndex(),traceModule.NativeLog,SIM_TICKS_PER_SECOND)end
    return brain.ReforgedAITrace
end
function Validate(brain)
    local reporter=trace(brain)
    local handicap=safe(function()return ArmyGetHandicap(brain:GetArmyIndex())end)
    local percent=brain.ReforgedResourcePercent or 100
    local ok=brain.BrainType=='AI'and brain.AIType=='Normal'and brain.BuildBonus==0 and brain.ResBonus==0
        and brain.VetBonus==0 and brain.IntelType=='None'and not brain.CheatBuffs and type(handicap)=='number'
        and math.abs(handicap-(percent/100-1))<.0001 and not brain.SkirmishAISystem
    reporter:Event(GetGameTick(),ok and'fairness-passed'or'fairness-failed',
        {level=brain.ReforgedAILevel,buildBonus=brain.BuildBonus,resourceBonus=brain.ResBonus,veterancyBonus=brain.VetBonus,
        intel=brain.IntelType,handicap=handicap,incomePercent=percent,neutralResources=percent==100,cheatBuff=brain.CheatBuffs~=nil,stockManager=brain.SkirmishAISystem~=nil,evidence='readback'})
    return ok
end
local function count(self,role)
    local n=0;for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog);if d and d.roles[role]then n=n+1 end end
    for id,d in pairs(self.catalog)do if d.roles[role]then n=n+self.tasks:Pending(id)end end
    -- Pending excludes a child already observed in own; commitments count once.
    return n
end
local function canSpend(self,q,power)
    return q and q.mass<=self.mass+(power and(self.powerMass or 0)or 0)
        and q.energy<=self.energy+(power and(self.powerEnergy or 0)or 0)
end
local function submit(self,actor,kind,id,p,reason,call,observe)
    if self.orders>=self.profile.ordersPerSecond*self.profile.decisionSeconds then return false end
    local d=(kind=='build'or kind=='produce')and id and self.catalog[id]
    if self.tasks:Submit(actor,kind,id,p,reason,self.now,call,observe,d and{mass=d.mass,energy=d.energy})then return true end
    return false
end
local function buildable(self,actor,predicate)
    local choice,quote
    for _,id in ipairs(self.catalogIds)do
        local d=self.catalog[id]
        if predicate(d)then
            local q=frame.Quote(actor,d)
            if q and(not choice or q.mass<quote.mass or q.mass==quote.mass and id<choice.id)then choice=d;quote=q end
        end
    end
    return choice,quote
end
local function path(self,actor,p)
    local description=frame.Describe(actor,self.catalog)
    if not description then return false end
    if description.layer=='air'then return true end
    local origin=actor:GetPosition();local key=math.floor(origin[1]/16)..':'..math.floor(origin[3]/16)..':'..math.floor(p[1])..':'..math.floor(p[3])..':'..actor:GetBlueprint().BlueprintId..':'..tostring(actor:GetCurrentLayer())..':'..tostring(self.brain:HasResearched('CSP_LANDWALKING'))
    local q=self.pathCache[key]
    if q and self.now-q.at<15 then return q.ok end
    if self.pathQueries>=math.max(1,math.floor(4*self.profile.decisionSeconds))then return nil end
    self.pathQueries=self.pathQueries+1
    -- SupCom 2 registers CanPathTo on Unit. Navigator.lua's replicated native
    -- method comment mentions CanPathToGoal, but the executable omits it.
    local ok=actor:CanPathTo(p)
    if type(ok)~='boolean'then error('Native unit path query did not return a reachability boolean')end
    self.pathCache[key]={ok=ok,at=self.now};return ok
end
local function threat(self,p,radius,layer,ignoreTactical)
    local amount=0;local targetLayer=layer=='air'and'Air'or'Land'
    local contacts=self.contactGrid and effective.Query(self.contactGrid,p,math.min(400,radius+250),128)or self.contacts
    for _,c in ipairs(contacts)do local d=self.catalog[c.blueprint]
        if not d and c.channel=='radar'and frame.Distance(c.position,p)<=radius+20 then amount=amount+80*c.confidence end
        if d and not d.scriptManaged then
            local range,min=effective.WeaponRange(d,targetLayer,c.currentLayer or d.physicalLayer)
            if not layer then range=math.max(range,effective.WeaponRange(d,'Air',c.currentLayer or d.physicalLayer))end
            range=math.max(range,targetLayer~='Air'and(d.scriptedRange or 0)or 0)
            if ignoreTactical and d.tacticalOnly then range=0 end
            local distance=frame.Distance(c.position,p)
            if range>0 and distance<=radius+range and distance+radius>=min then amount=amount+math.max(20,d.mass)*c.confidence end
        end
    end
    return amount
end
local function buildSiteLegal(self,d,p)
    if #self.own+self.tasks:PendingCount()>=(tonumber(ScenarioInfo.Options.UnitCap)or 1000)then return false end
    if not self.brain:CanBuildStructureAt(d.id,p)then return false end
    local function overlaps(other,position)
        return math.abs(position[1]-p[1])<((other.footprintX or 2)+(d.footprintX or 2))*.5+1
            and math.abs(position[3]-p[3])<((other.footprintZ or 2)+(d.footprintZ or 2))*.5+1
    end
    -- Reserve every public deposit's footprint before any ordinary structure
    -- occupies it. A vacant core mex is future infrastructure, not free space.
    if not d.flags.MASSEXTRACTION then
        local mex
        for _,id in ipairs(self.catalogIds)do local c=self.catalog[id];if c.faction==self.faction and c.flags.MASSEXTRACTION then mex=c;break end end
        for _,site in ipairs(self.map.massSites)do if overlaps(mex or{footprintX=6,footprintZ=6},site.position)then return false end end
    end
    for _,site in ipairs(self.tasks:Sites())do local other=self.catalog[site.blueprint]
        if other and overlaps(other,site.position)then return false end
    end
    for _,unit in ipairs(self.own)do local other=frame.Describe(unit,self.catalog)
        if other and other.structure and overlaps(other,unit:GetPosition())then return false end
    end
    return true
end
local function build(self,actor,d,p,reason)
    local q=frame.Quote(actor,d)
    local power=d.roles.generator==true or d.flags.ENERGYPRODUCTION==true and not d.roles.converter
    if not canSpend(self,q,power)or not buildSiteLegal(self,d,p)then return false end
    if submit(self,actor,'build',d.id,p,reason,function()IssueBuildMobile({actor},p,d.id,{})end)then
        if power then
            self.mass=self.mass+(self.powerMass or 0);self.energy=self.energy+(self.powerEnergy or 0)
            self.powerMass=0;self.powerEnergy=0;self.powerPlan=nil;self.pendingPower=(self.pendingPower or 0)+1
        end
        self.mass=self.mass-q.mass;self.energy=self.energy-q.energy;return true
    end
    return false
end
local function placement(self,actor,d,center,maxTravel,requirePath,tacticalCoverage)
    for ring=1,4 do for direction=0,7 do
        local angle=direction*math.pi/4+self.brain:GetArmyIndex()*.7
        local p=frame.Point(center[1]+math.cos(angle)*(6+ring*5),center[3]+math.sin(angle)*(6+ring*5))
        if p[1]>2 and p[1]<self.map.width-2 and p[3]>2 and p[3]<self.map.height-2
            and (not tacticalCoverage or frame.Distance(center,p)<=tacticalCoverage)
            and frame.Distance(actor:GetPosition(),p)<=(maxTravel or 90)and threat(self,p,8,nil,tacticalCoverage~=nil)==0
            and buildSiteLegal(self,d,p)
            and(not requirePath or frame.Distance(actor:GetPosition(),p)<=(frame.Describe(actor,self.catalog).buildRange or 10)or path(self,actor,p)==true)then return p end
    end end
end
local function place(self,actor,d,center,reason,maxTravel,requirePath)
    if not canSpend(self,frame.Quote(actor,d),d.roles.generator==true)then return false end
    local p=placement(self,actor,d,center,maxTravel,requirePath)
    return p and build(self,actor,d,p,reason)or false
end
local function expansionDefense(self,actor)
    if self.mass<200 or count(self,'factory')<1 or self.now<75 then return false end
    for _,mex in ipairs(self.own)do local md=frame.Describe(mex,self.catalog)
        if md and md.flags.MASSEXTRACTION and mex:GetFractionComplete()>=1
            and frame.Distance(mex:GetPosition(),self.map.ownStart)>35 and frame.Distance(actor:GetPosition(),mex:GetPosition())<25 then
            local defenses=0
            for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
                if d and d.roles.expansionDefense and frame.Distance(mex:GetPosition(),u:GetPosition())<30 then defenses=defenses+1 end
            end
            if defenses<1 then
                local pd,q=buildable(self,actor,function(d)return d.roles.expansionDefense end)
                if canSpend(self,q)and q.mass<=math.max(65,self.massIncome*15)then return place(self,actor,pd,mex:GetPosition(),'bounded-light-pd-cover-for-owned-expansion')end
            end
        end
    end
    return false
end
local function economy(self)
    self.rawMass=self.brain:GetEconomyStored('MASS');self.rawEnergy=self.brain:GetEconomyStored('ENERGY')
    self.mass=self.rawMass;self.energy=self.rawEnergy
    self.massIncome=self.brain:GetEconomyIncome('MASS')*self.tps
    self.energyIncome=self.brain:GetEconomyIncome('ENERGY')*self.tps
    self.energyRequested=self.brain:GetEconomyRequested('ENERGY')*self.tps
    self.energySpare=(self.brain:GetEconomyIncome('ENERGY')-self.brain:GetEconomyRequested('ENERGY'))*self.tps
    assert(finite(self.mass)and finite(self.energy),'Invalid native economy readback')
    local reservedMass,reservedEnergy=self.tasks:Reserved();self.taskMass=reservedMass;self.taskEnergy=reservedEnergy
    -- Conservative outstanding research commitment until native confirmation.
    local abilityMass,abilityEnergy=self:AbilityReserved();reservedMass=reservedMass+abilityMass;reservedEnergy=reservedEnergy+abilityEnergy
    local research=self.researchTask
    if research and not self.brain:HasResearched(research.id)then
        reservedMass=reservedMass+(research.mass or 0);reservedEnergy=reservedEnergy+(research.energy or 0)
    end
    self.mass=math.max(0,self.mass-reservedMass);self.energy=math.max(0,self.energy-reservedEnergy)
end
-- Hold one generator's cost only when a real available constructor has a
-- safe, native-legal reachable site. Pending/unfinished power counts once and
-- prevents every idle builder buying another generator during construction.
local function planPower(self)
    self.powerMass=0;self.powerEnergy=0;self.powerPlan=nil;self.pendingPower=0;self.futurePower=0
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
        if d and d.roles.generator and u:GetFractionComplete()<1 then
            self.pendingPower=self.pendingPower+1
            self.futurePower=self.futurePower+((u:GetBlueprint().Economy or{}).ProductionPerSecondEnergy or 0)
        end
    end
    for _,id in ipairs(self.catalogIds)do local d=self.catalog[id]
        if d.roles.generator then local n=self.tasks:Pending(id);local bp=GetUnitBlueprintByName(id)
            self.pendingPower=self.pendingPower+n;self.futurePower=self.futurePower+n*((bp and bp.Economy or{}).ProductionPerSecondEnergy or 0)end
    end
    if self.pendingPower>0 then self.powerWait='observing-pending-power';return end
    local factories=count(self,'factory')
    -- Do not delay the starting factory with premature power. Thereafter keep
    -- enough bank for paid production, rather than waiting below the gen price.
    self.powerIncomeTarget=math.max(self.massIncome*2,self.energyRequested+factories*6)
    local abilityReserve=0
    for _,unit in ipairs(self.own)do local d=frame.Describe(unit,self.productionCatalog or self.catalog)
        if d and d.ready and d.controlled then
            local general=unit:GetBlueprint().General or{}
            if type(general.MoveEnergyCost)=='number'and self.brain:HasResearched(self.faction=='CYBRAN'and'CLA_JUMPJETS'or'ILA_TELEPORT')then abilityReserve=abilityReserve+general.MoveEnergyCost end
            for _,rule in pairs(d.abilityRules or{})do local resource=rule.activate or{};if string.upper(resource.SourceType or'')=='ENERGY'then abilityReserve=math.max(abilityReserve,tonumber(resource.SourceAmount)or 0)end end
        end
    end
    self.powerBankTarget=math.max(250,math.min(6000,abilityReserve+(self.taskEnergy or 0)+math.max(0,-self.energySpare)*10))
    if self.researchGoal=='ILA_TELEPORT'or self.researchGoal=='CLA_JUMPJETS'then self.powerIncomeTarget=self.powerIncomeTarget+8;self.powerBankTarget=math.max(self.powerBankTarget,abilityReserve+150) end
    if self.researchGoal=='CLU_MEGALITHII'or count(self,'gantry')>0 then self.powerIncomeTarget=math.max(self.powerIncomeTarget,self.massIncome*3);self.powerBankTarget=math.max(self.powerBankTarget,self.deployment and self.deployment.unit.energy or 0) end
    local generators=count(self,'generator')
    if not(self.energySpare<0 or factories>0 and(self.energy<self.powerBankTarget or generators<factories or self.energyIncome<self.powerIncomeTarget))then self.powerWait='power-bank-and-income-sufficient';return end
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
        if d and(d.roles.commander or d.roles.engineer)and(frame.Ready(u)or(self.tasks:Current(u)or{}).kind=='guard')and(not self.tasks:Busy(u,self.now)or(self.tasks:Current(u)or{}).kind=='guard')and not self:BuilderInCombat(u)then
            local gen,q=buildable(self,u,function(x)return x.roles.generator==true end)
            local p=gen and placement(self,u,gen,u:GetPosition(),45,true)
            if p then
                self.powerMass=math.min(self.mass,q.mass);self.powerEnergy=math.min(self.energy,q.energy);self.powerPlan={actor=u,description=gen,position=p}
                self.mass=self.mass-self.powerMass;self.energy=self.energy-self.powerEnergy
                self.powerWait=canSpend(self,q,true)and'funded-generator-reserved'or'saving-generator-cost'
                return
            end
        end
    end
    self.powerWait='no-available-safe-power-builder'
end
local function analyze(self,commander)
    if self.opening then return end
    local map=self.map
    for _,s in ipairs(map.candidateStarts)do
        if not s.land then
            local reachable=path(self,commander,s.position);if reachable==nil then return end
            local distance=frame.Distance(map.ownStart,s.position)
            s.commander={validated=true,reachable=reachable,motionType=(commander:GetBlueprint().Physics or{}).MotionType}
            local ground=self.topology and self.topology:Route(map.ownStart,s.position,'land')
            s.land={validated=ground~=nil,reachable=ground~=nil,seconds=ground and ground.length/3 or math.max(1,distance/3),provenance='public-land-grid-not-amphibious-commander'}
            s.air={validated=true,reachable=true,seconds=math.max(1,distance/8)}
            -- Naval openings stay unavailable until an actual owned naval
            -- navigator and validated build site exist; never infer connectivity.
            s.naval={validated=true,reachable=false}
        end
    end
    -- Analyze the nearest sixteen sites first; do not delay the opening for
    -- hundreds of distant mass markers. The remaining sites are checked on use.
    local openingMass={}
    for i=1,math.min(16,#map.massSites)do
        local m=map.massSites[i];openingMass[#openingMass+1]=m
        if not m.engineer then
            local reachable=path(self,commander,m.position);if reachable==nil then return end
            m.engineer={validated=true,reachable=reachable,seconds=math.max(1,frame.Distance(map.ownStart,m.position)/3)}
        end
    end
    local wet,total=0,0
    for x=1,8 do for z=1,8 do
        local px,pz=map.width*x/9,map.height*z/9;total=total+1
        if GetSurfaceHeight(px,pz)>GetTerrainHeight(px,pz)+.5 then wet=wet+1 end
    end end
    local sampled=self.topology and self.topology:Summary(map,3)
    map.terrain={validated=true,chokes=sampled and sampled.chokes or 0,flanks=sampled and sampled.flanks or 0,waterFraction=wet/total,navalBuildSiteValidated=false}
    if sampled then for _,s in ipairs(map.candidateStarts)do
        if s.land and s.land.reachable then local r=self.topology:Route(map.ownStart,s.position,'land');if r then s.land.seconds=r.length/3 end end
    end end
    local land,lq=buildable(self,commander,function(d)return d.roles.factory and d.layer=='land'end)
    local air,aq=buildable(self,commander,function(d)return d.roles.factory and d.layer=='air'end)
    local plans={}
    for _,row in ipairs({{'land_pressure',land,lq},{'expansion',land,lq},{'air_control',air,aq},{'defensive',land,lq}})do
        local style,d,q=row[1],row[2],row[3]
        if d and canSpend(self,q)then plans[#plans+1]={id=style..'-'..self.faction,style=style,faction=self.faction,legal=true,economyValidated=true,
            initialMass=q.mass,initialEnergy=q.energy,weight=1,steps={{kind='build',target=d.id,count=1}}}end
    end
    local analyzed={};for k,v in pairs(map)do analyzed[k]=v end;analyzed.massSites=openingMass
    local result,why=openings.ChooseOpening({map=analyzed,faction=self.faction,personality=self.personality or'Balanced',seed=self.seed,epoch=0,armyKey=tostring(self.army),
        rulesKey=ruleset.ProfileId..':'..ruleset.PatchId,massBudget=self.mass,energyBudget=self.energy,plans=plans})
    if result then self.opening=result;log(self,'opening-selected',{style=result.style,template=result.templateId,seed=result.choiceSeed,map=map.key,
        landReach=openings.AnalyzeOpeningMap(analyzed).landReach,waterFraction=wet/total,quoteSource='public-base-conservative'})
    elseif self.now-(self.lastOpeningReport or-100)>=30 then self.lastOpeningReport=self.now;log(self,'planning-wait',{reason=why})end
end
local function occupied(self,p)
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
        if d and d.structure and frame.Distance(u:GetPosition(),p)<4 then return true end
    end
    return false
end
local function fieldWork(self,actor,coreOnly)return self:Expand(actor,coreOnly)end
local function builders(self)
    self.builderWait='normal-priorities'
    local factories=count(self,'factory');local constructors={};local commander
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
        if d and(d.roles.commander or d.roles.engineer)then constructors[#constructors+1]=u;if d.roles.commander then commander=u end end
    end
    self.engineerCount=0
    for _,unit in ipairs(constructors)do if frame.Describe(unit,self.catalog).roles.engineer then self.engineerCount=self.engineerCount+1 end end
    table.sort(constructors,function(a,b)
        local ac=frame.Describe(a,self.catalog).roles.commander;local bc=frame.Describe(b,self.catalog).roles.commander
        if ac~=bc then return ac==true end
        return a:GetEntityId()<b:GetEntityId()
    end)
    if commander then analyze(self,commander)end
    for id,lease in pairs(self.siteLeases)do
        local ok,t=pcall(self.tasks.Current,self.tasks,lease.actor)
        if not ok or not t or t.kind~='build'then self.siteLeases[id]=nil end
    end
    for _,u in ipairs(constructors)do
        factories=count(self,'factory')
        local d=frame.Describe(u,self.catalog);local health=u:GetHealth()/math.max(1,u:GetMaxHealth())
        local fighting=self:BuilderInCombat(u)
        local current=self.tasks:Current(u)
        if current and current.kind=='build'and current.position and self.catalog[current.blueprint]
            and self.catalog[current.blueprint].flags.MASSEXTRACTION
            and(threat(self,current.position,35)>0 or not self:ExpansionRouteSafe(u,current.position))then
            self.tasks:Cancel(u,self.now,'expansion-became-contested')
            for id,lease in pairs(self.siteLeases)do if lease.actor==u then self.siteLeases[id]=nil;self.siteRetry[id]=self.now+20 end end
            current=nil
        end
        local fundedPower=self.powerPlan and self.powerPlan.actor==u and canSpend(self,frame.Quote(u,self.powerPlan.description),true)
        local expansionReady=current and current.kind=='guard'and d.roles.engineer and not fighting and self.now-current.started>=3 and self:Expand(u,false,true)
        if current and current.kind=='guard'and(fundedPower or fighting or expansionReady)then self.tasks:Cancel(u,self.now,'builder-work-review')end
        if fighting then
            local task=self.tasks:Current(u);local work=task and self.catalog[task.blueprint]
            if task and(task.kind=='build'or task.kind=='repair'or task.kind=='reclaim')
                and not(work and work.roles.defense and work.groundRange>0)then
                self.tasks:Cancel(u,self.now,'combat-interrupted-routine-construction')
            end
        end
        if d.roles.commander and health<.45 and fighting then
            if not self.retreating then self.tasks:Cancel(u,self.now,'commander-survival');self.retreating=true end
            if not self.tasks:Busy(u,self.now)then self:BuilderWithdraw(u,'commander-survival')end
        elseif fighting then
            self.builderWait='combat-no-routine-construction'
            if frame.Ready(u)and not self.tasks:Busy(u,self.now)then
                if d.roles.engineer then self:BuilderWithdraw(u,'engineer-withdraws-from-observed-danger')
                elseif not self:CombatDefense(u)and not self:CommanderCombat(u,true)then self:BuilderWithdraw(u,'commander-disengages-from-overwhelming-defense')end
            end
        elseif d.roles.commander and #constructors>1 and factories<1 and not self.opening and self.now<15 then
            -- Keep the faster starting ACU available for the first factory
            -- while the incremental map analysis finishes. Engineers may mex.
            self.expansionWait='commander-reserved-for-first-factory-analysis'
        elseif d.roles.commander and self.nanobotSupport and self.brain:HasResearched('CCP_NANOBOTWEAPON')and health>.65
            and frame.Ready(u)and not self.tasks:Busy(u,self.now)and frame.Distance(u:GetPosition(),self.nanobotSupport)>15 then
            if path(self,u,self.nanobotSupport)==true then submit(self,u,'move',nil,self.nanobotSupport,'nanobot-commander-supports-owned-deathball',function()IssueMove({u},self.nanobotSupport)end)end
        elseif frame.Ready(u)and not self.tasks:Busy(u,self.now)then
            self.retreating=false
            local power=self.powerPlan
            if power and power.actor==u and build(self,u,power.description,power.position,'maintain-funded-energy-production')then
            elseif d.roles.engineer and fieldWork(self,u)then
            elseif self:DeploymentBuild(u)then
            elseif d.roles.commander and self:Assist(u,true)then
            elseif factories>=1 and fieldWork(self,u,true)then
            elseif self:TacticalDefense(u)then
            elseif self:Infrastructure(u)then
            elseif self:Repair(u)then
            elseif self:ExperimentalBuild(u)then
            elseif d.roles.commander and self:CommanderCombat(u)then
            elseif self:Radar(u)then
            elseif self:SiegeBuild(u)then
            elseif expansionDefense(self,u)then
            elseif self:Reclaim(u)then
            elseif fieldWork(self,u)then
            elseif factories>=1 and self.opening then
                local converter,cq=buildable(self,u,function(x)
                    return x.roles.converter and finite(x.passiveConverterEnergy)and x.passiveConverterEnergy>0
                        and self.energySpare>=x.passiveConverterEnergy+2
                end)
                if converter and count(self,'converter')<math.min(6,math.floor(self.massIncome/2))and canSpend(self,cq)then
                    place(self,u,converter,self.map.ownStart,'convert-genuine-energy-surplus')
                end
                if not self.tasks:Busy(u,self.now)and not self:Assist(u)then
                    if not self:FactoryAssist(u)then self:EngineerIntel(u)end
                end
            end
        end
    end
end
local function produce(self)
    local roles={mainline=0,aa=0,siege=0,support=0,raider=0};local scouts={land=0,air=0,naval=0};local armyMass=0;local groundAA,airAA=0,0
    local layerRoles={land={},air={},naval={}};local layerMass={land=0,air=0,naval=0}
    local function commit(d,ready)
        if d.roles.scout then scouts[d.layer]=scouts[d.layer]+1;return end
        -- Queued/unfinished units count toward purchases already committed,
        -- but cannot provide interception cover for a bomber purchase yet.
        if d.roles.aa then if d.layer=='air'then
            if ready then airAA=airAA+d.mass end
        else groundAA=groundAA+d.mass end end
        local fighting=false
        for _,role in ipairs({'support','siege','aa','mainline','raider'})do
            if d.roles[role]then roles[role]=roles[role]+d.mass;layerRoles[d.layer][role]=(layerRoles[d.layer][role]or 0)+d.mass;fighting=true end
        end
        -- Multi-role units meet each real capability demand; total army mass
        -- is counted once. An Adaptor must not leave the AA deficit unchanged.
        if fighting then armyMass=armyMass+d.mass;layerMass[d.layer]=layerMass[d.layer]+d.mass end
    end
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog);if d then commit(d,u:GetFractionComplete()>=1)end end
    for id,d in pairs(self.productionCatalog)do for i=1,self.tasks:Pending(id)do commit(d)end end
    local cap=tonumber(ScenarioInfo.Options.UnitCap)or 1000
    local used=#self.own+self.tasks:PendingCount()
    local airFactory=false
    for _,unit in ipairs(self.own)do
        local d=frame.Describe(unit,self.catalog)
        if d and d.roles.factory and not d.roles.gantry and d.layer=='air' then airFactory=true;break end
    end
    if not airFactory then
        for _,id in ipairs(self.catalogIds)do local d=self.catalog[id]
            if d.roles.factory and not d.roles.gantry and d.layer=='air'and self.tasks:Pending(id)>0 then airFactory=true;break end
        end
    end
    for _,factory in ipairs(self.own)do
        local fd=frame.Describe(factory,self.catalog)
        if fd and fd.roles.producer and frame.Ready(factory)and not self.tasks:Busy(factory,self.now)and used<cap then
            local deployed,deployedUnit=self:DeploymentProduction(factory)
            if deployed then commit(deployedUnit);used=used+1 end
            local addon=deployed or self:FactoryAddon(factory)
            local quotes={}
            for _,id in ipairs(self.catalogIds)do local d=self.catalog[id]
                if d.mobile and not d.scriptManaged then local q=frame.Quote(factory,d);if q then quotes[id]=q end end
            end
            -- Interceptors on the far side of the map cannot cover this launch.
            local localCover=self:FighterCover(factory:GetPosition(),15)
            local pendingCover=0
            for _,other in ipairs(self.own)do local task=self.tasks:Current(other);local d=task and task.kind=='produce'and self.productionCatalog[task.blueprint]
                if d and d.layer=='air'and d.airRange>0 and frame.Distance(other:GetPosition(),factory:GetPosition())<=45 then pendingCover=pendingCover+d.mass end
            end
            local intent,productionWait=strategy.ChooseProduction({roleWeights=self.plan and self.plan.mix,groundAACommitted=groundAA,friendlyFighterMass=localCover,friendlyFighterCommitted=localCover+pendingCover,productionLayer=(fd.productionLayer=='mixed'and(self.plan and self.plan.factoryLayer or'land')or fd.productionLayer or fd.layer),capRemaining=cap-used,armyTargetMass=math.max(500,layerMass[fd.productionLayer~='mixed'and fd.productionLayer or fd.layer]+math.max(400,self.mass*.6)),
                massBudget=self.mass,energyBudget=self.energy,quotes=quotes,contacts=self.contacts,committedRoleMass=layerRoles[fd.productionLayer~='mixed'and fd.productionLayer or fd.layer],
                scoutNeeded=not fd.roles.gantry and (fd.layer=='air' or fd.layer=='land'and not airFactory
                    and (layerRoles.land.mainline or 0)>0 and not(self.plan and self.plan.emergency)),
                scoutsCommitted=scouts[fd.layer],scoutsWanted=fd.layer=='air'and self.profile.scoutsWanted or 1},self.productionCatalog,self.catalog)
            if not addon then
                local worker,workerWait=self:WorkerProduction(factory,quotes,cap-used)
                if worker then intent=worker end
                self.workerWait=workerWait or(worker and worker.reason)or'no-workload'
            end
            if intent and not addon then local d=self.catalog[intent.blueprint];local q=quotes[d.id]
                if submit(self,factory,'produce',d.id,nil,intent.reason,function()IssueBuildFactory({factory},d.id,1)end)then
                    self.mass=self.mass-q.mass;self.energy=self.energy-q.energy;commit(self.productionCatalog[d.id]);used=used+1
                end
            end
            if not intent and self.now-(self.productionWaitAt[factory]or-100)>=10 then
                self.productionWaitAt[factory]=self.now;log(self,'production-wait',{actor=tostring(factory:GetEntityId()),reason=productionWait or'no-affordable-unit',mass=self.mass,energy=self.energy,readyFighterMass=airAA})
            end
        end
    end
end
local function contestedField(self,armyMass,combat)
    if armyMass<200 then return end
    local records={}
    for _,r in pairs(self.reclaimMemory)do if self.now-r.lastSeen<=20 then records[#records+1]=r end end
    table.sort(records,function(a,b)return tostring(a.id)<tostring(b.id)end)
    local fields={}
    for _,r in ipairs(records)do
        local group
        for _,f in ipairs(fields)do if frame.Distance(r.position,f.position)<=24 then group=f;break end end
        if group then group.mass=group.mass+r.mass
        else fields[#fields+1]={id=tostring(r.id),position=r.position,mass=r.mass}end
    end
    local choice,best
    for _,f in ipairs(fields)do
        local danger=threat(self,f.position,25)
        local nearby=0
        if f.mass>=150 and danger>0 then
            for _,u in ipairs(combat)do if frame.Distance(u:GetPosition(),f.position)<=120 then nearby=nearby+frame.Describe(u,self.productionCatalog).mass end end
        end
        if nearby>=200 and danger<=nearby*.65 then
            local value=f.mass*2/(1+frame.Distance(f.position,self.map.ownStart))
            if not best or value>best or value==best and f.id<choice.id then choice=f;best=value end
        end
    end
    return choice,best
end
local function forces(self)
    local scouts,combat,escorts={},{},{};local mass=0
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
        if d and u:GetFractionComplete()>=1 and not(self.teamAssigned and self.teamAssigned[tostring(u:GetEntityId())])and not(self.cicadaHeld and self.cicadaHeld[u])then
            if d.roles.scout then scouts[#scouts+1]=u
            elseif d.mobile and not d.roles.commander and not d.roles.engineer and not d.roles.reclaimer then
                if d.groundRange>0 then combat[#combat+1]=u;mass=mass+d.mass
                elseif d.roles.aa or d.roles.support then escorts[#escorts+1]=u end
            end
        end
    end
    local assigned={}
    local function siteKey(position)return position[1]..':'..position[3]end
    for _,scout in ipairs(scouts)do
        local task=self.tasks:Current(scout)
        if task and task.position then assigned[siteKey(task.position)]=true end
    end
    for _,scout in ipairs(scouts)do
        if not self.tasks:Busy(scout,self.now)then
            local layer=frame.Describe(scout,self.productionCatalog).layer
            local sites={};for _,site in ipairs(self.map.candidateStarts)do sites[#sites+1]=site end
            for _,site in ipairs(self.map.massSites)do sites[#sites+1]=site end
            table.sort(sites,function(a,b)local aa,bb=self.scouted[a.id]or-100,self.scouted[b.id]or-100;return aa<bb or aa==bb and a.id<b.id end)
            for _,site in ipairs(sites)do
                if frame.Distance(scout:GetPosition(),site.position)<12 then self.scouted[site.id]=self.now
                elseif not assigned[siteKey(site.position)]and threat(self,site.position,10,layer)==0 and path(self,scout,site.position)==true then
                    if submit(self,scout,'move',nil,site.position,'refresh-public-starts-expansions-and-flanks',function()IssueMove({scout},site.position)end)then
                        assigned[siteKey(site.position)]=true
                        break
                    end
                end
            end
        end
    end
    local pressureMass=(({easy=350,normal=260,hard=200,reforger=150})[self.profile.level]or 300)*(self.plan and self.plan.pressureMultiplier or 1)
    local target,score,defend,raidTarget,raidScore
    for _,c in ipairs(self.contacts)do local d=self.catalog[c.blueprint]
        if d and c.confidence>.3 then
            local home=frame.Distance(c.position,self.map.ownStart)<65
            local value=(home and 100000 or d.roles.commander and mass>400 and c.current and 50000 or d.roles.economy and 2000 or d.roles.factory and 1500 or 500)
                *c.confidence/(1+frame.Distance(c.position,self.map.ownStart))
            if not score or value>score then target=c;score=value;defend=home end
            if(d.roles.economy or d.roles.engineer)and threat(self,c.position,15)<mass*.15 then
                local raidValue=math.max(20,d.mass)*c.confidence/(1+frame.Distance(c.position,self.map.ownStart))
                if not raidScore or raidValue>raidScore then raidTarget=c;raidScore=raidValue end
            end
        end
    end
    local field,fieldScore=contestedField(self,mass,combat)
    if defend or fieldScore and score and fieldScore<=score then field=nil end
    if field then
        local nearest,near
        for _,c in ipairs(self.contacts)do local d=self.catalog[c.blueprint]
            local distance=frame.Distance(c.position,field.position)
            if d and c.current and distance<=35+math.max(d.groundRange,d.airRange)
                and(not near or distance<near or distance==near and c.id<nearest.id)then nearest=c;near=distance end
        end
        field.defender=nearest
    end
    if(field and field.id or'')~=(self.wreckObjective and self.wreckObjective.id or'')then
        log(self,'field-objective',{field=field and field.id or'none',mass=field and field.mass or 0,
            reason=field and'contest-valuable-known-wreckfield-before-engineers'or'field-unavailable-or-higher-priority-objective'})
    end
    self.wreckObjective=field
    local raidCommitted=0
    for _,u in ipairs(combat)do local id=tostring(u:GetEntityId())
        if self.raids[id]and self.tasks:Busy(u,self.now)then raidCommitted=raidCommitted+frame.Describe(u,self.productionCatalog).mass else self.raids[id]=nil end
    end
    for _,u in ipairs(combat)do
        if not self.tasks:Busy(u,self.now)and not self.microHeld[u]then
            local d=frame.Describe(u,self.productionCatalog);local destination,reason,chosen
            local localTarget,localDefend=target,defend
            -- Reaching a remembered location fulfills that movement objective;
            -- it is not evidence that its unseen unit died. Choose a different
            -- known objective instead of parking on the old target forever.
            if localTarget and not localTarget.current and frame.Distance(u:GetPosition(),localTarget.position)<=12 then
                localTarget=nil;local best
                for _,c in ipairs(self.contacts)do local cd=self.catalog[c.blueprint]
                    if cd and c.confidence>.3 and(c.current or frame.Distance(u:GetPosition(),c.position)>12)then
                        local value=(cd.roles.economy and 2000 or cd.roles.factory and 1500 or 500)*c.confidence/(1+frame.Distance(u:GetPosition(),c.position))
                        if not best or value>best then localTarget=c;best=value;localDefend=frame.Distance(c.position,self.map.ownStart)<65 end
                    end
                end
            end
            if field and not(self.plan and self.plan.emergency)then
                chosen=field.defender;destination=chosen and chosen.position or field.position;reason='secure-known-wreckfield-before-engineers'
            elseif self.profile.raidExpansions and raidTarget and not defend and d.roles.raider and raidCommitted+d.mass<=mass*(self.plan and self.plan.raidFraction or .25)then
                destination=raidTarget.position;reason='bounded-raid-on-scouted-expansion';chosen=raidTarget;raidCommitted=raidCommitted+d.mass
            end
            local hold=self.plan and(self.plan.emergency or self.plan.style=='defensive'or self.plan.style=='research'or self.plan.style=='expansion')
            if not destination and localTarget and(localDefend or not hold and mass>=math.max(pressureMass,threat(self,localTarget.position,25)*1.4))then destination=localTarget.position;reason=localDefend and'defend-owned-economy'or'pressure-scouted-target';chosen=localTarget
            elseif not destination and not hold and #self.map.candidateStarts>0 and mass>=pressureMass then
                local site,at
                for _,s in ipairs(self.map.candidateStarts)do
                    if frame.Distance(u:GetPosition(),s.position)<10 then self.scouted[s.id]=self.now end
                    local time=self.scouted[s.id]or-100
                    if not at or time<at then site=s;at=time end
                end
                destination=site.position;reason='reconnaissance-in-force-at-public-start'
            end
            if not destination and hold then destination=self.map.ownStart;reason='defend-strategic-reserve'end
            if destination and frame.Distance(u:GetPosition(),destination)>6 and path(self,u,destination)==true then
                local p=frame.Point(destination[1],destination[3])
                local origin=u:GetPosition();local routes={{id='direct',reachable=true,points={origin,p}}};local points={}
                local dx,dz=p[1]-origin[1],p[3]-origin[3]
                for _,side in ipairs(self.profile.compareFlanks and{1,-1}or{})do
                    local mid=frame.Point((origin[1]+p[1])/2-dz*.3*side,(origin[3]+p[3])/2+dx*.3*side)
                    if mid[1]>2 and mid[1]<self.map.width-2 and mid[3]>2 and mid[3]<self.map.height-2 and path(self,u,mid)==true then
                        local id=side==1 and'left'or'right';routes[#routes+1]={id=id,reachable=true,points={origin,mid,p}};points[id]=mid
                    end
                end
                -- Sample actual terrain corridors for threat scoring. Native
                -- endpoint/waypoint queries still own reachability authority.
                local grid=self.topology and self.topology:Route(origin,p,d.layer)
                if grid then
                    routes[1].points=grid.points
                    local valid=true
                    for i=2,#grid.points-1 do if path(self,u,grid.points[i])~=true then valid=false;break end end
                    if valid then points.direct=grid.points end
                end
                local route=strategy.ChooseRoute(routes,self.contacts,self.catalog,d.layer,defend and 1000000000 or mass*.7)
                local live=chosen and self.targets[chosen.id]
                local targetDescription=chosen and self.catalog[chosen.blueprint]
                local range=targetDescription and targetDescription.layer=='air'and d.airRange or d.groundRange
                local observe=live and frame.CombatObserver(self.army,live,chosen.id,function()return self.combatReads end,u,range)
                if route and submit(self,u,live and'attack'or'advance',nil,p,reason..'-'..route.id,function()
                    if points[route.id]then
                        if route.id=='direct'then for i=2,#points.direct-1 do IssueMove({u},points.direct[i])end
                        else IssueMove({u},points[route.id])end
                    end
                    if live then IssueAttack({u},live)else IssueAggressiveMove({u},p)end
                end,observe)then
                    if string.find(reason,'bounded-raid',1,true)then self.raids[tostring(u:GetEntityId())]=true end
                end
            end
        end
    end
    if #combat>0 then
        local x,z=0,0;for _,u in ipairs(combat)do local p=u:GetPosition();x=x+p[1];z=z+p[3]end
        local center=frame.Point(x/#combat,z/#combat)
        for _,u in ipairs(escorts)do
            if not self.tasks:Busy(u,self.now)and frame.Distance(u:GetPosition(),center)>15 and path(self,u,center)==true then
                submit(self,u,'move',nil,center,'escort-owned-ground-force',function()IssueMove({u},center)end)
            end
        end
    end
end
local function research(self)
    if self.researchTask then
        local t=self.researchTask
        if self.brain:HasResearched(t.id)then self.researchSpent=(self.researchSpent or 0)+(t.points or 0);self:ResearchPurchased(t.doctrineKind,t.points or 0);log(self,'task-completed',{task=t.task,evidence='observed',research=t.id});self.researchTask=nil
        elseif self.now-t.at>30 then log(self,'task-stalled',{task=t.task,cause='research-not-observed',research=t.id});self.researchRetry[t.id]=self.now+60;self.researchTask=nil end
        return
    end
    if self.now-(self.lastResearch or-100)<5 then return end;self.lastResearch=self.now
    local definitions=import('/lua/sim/Research.lua').ResearchDefinitions
    local goal,reason,c,why=self:SelectResearch(definitions)
    if self.researchGoal~=goal then
        self.researchGoal=goal;log(self,'research-plan',{goal=goal or'none',reason=reason})
    end
    if c and self:ReserveCalls(1)then
        local id='r-'..self.army..'-'..math.floor(self.now*self.tps)
        log(self,'task-planned',{task=id,kind='research',research=c,goal=goal,reason=reason})
        self.brain:StartResearch(c,1)
        local definition=definitions[c]
        self.researchTask={id=c,task=id,at=self.now,mass=definition.MASS or 0,energy=definition.ENERGY or 0,points=definition.COST or 0,doctrineKind=self.doctrineResearchKind}
        self.mass=math.max(0,self.mass-self.researchTask.mass);self.energy=math.max(0,self.energy-self.researchTask.energy)
        log(self,'order-issued',{task=id,kind='research',research=c,evidence='submitted'})
    elseif self.now-(self.lastResearchWait or-100)>=20 then
        self.lastResearchWait=self.now;log(self,'research-wait',{goal=goal or'none',reason=why})
    end
end
local State={}
function State:BuilderWithdraw(actor,reason)
    local origin=actor:GetPosition();local current=threat(self,origin,6)
    local candidates={self.map.ownStart}
    -- The home point can itself be covered by the opponent's forward PDs.
    -- Search bounded reachable ground using only observed threat memory.
    for _,radius in ipairs({32,64})do for direction=0,7 do
        local angle=direction*math.pi/4
        candidates[#candidates+1]=frame.Point(origin[1]+math.cos(angle)*radius,origin[3]+math.sin(angle)*radius)
    end end
    local best,score
    for _,p in ipairs(candidates)do
        local distance=frame.Distance(origin,p)
        if p[1]>2 and p[3]>2 and p[1]<self.map.width-2 and p[3]<self.map.height-2 and distance>8 then
            local danger=threat(self,p,6)
            local value=danger*1000+distance
            if(danger<current or current==0 and p==self.map.ownStart and danger==0)and(not score or value<score)and path(self,actor,p)==true then best=p;score=value end
        end
    end
    if not best then return false end
    return submit(self,actor,'move',nil,best,reason,function()IssueMove({actor},best)end)
end
function State:BuilderInCombat(actor)
    self.builderCombat=self.builderCombat or{}
    local record=self.builderCombat[actor]
    if record and record.at==self.now then return record.fighting end
    local health=actor:GetHealth();local untilTime=record and record.untilTime or-100
    if record and health<record.health-.1 then untilTime=self.now+8 end
    local fighting=self.now<untilTime;local position=actor:GetPosition()
    for _,contact in ipairs(self.contacts)do local enemy=self.catalog[contact.blueprint]
        if enemy and contact.current and contact.channel=='vision'and contact.age<=2
            and enemy.groundRange>0 and frame.Distance(position,contact.position)<=enemy.groundRange+6 then fighting=true;break end
    end
    self.builderCombat[actor]={health=health,at=self.now,untilTime=untilTime,fighting=fighting}
    return fighting
end
function State:CombatDefense(actor)
    if actor:GetHealth()/math.max(1,actor:GetMaxHealth())<.55 or self.mass<65
        or self.now-(self.lastCombatDefense or-100)<60 then return false end
    local description=frame.Describe(actor,self.catalog);local position=actor:GetPosition()
    for _,unit in ipairs(self.own)do local d=frame.Describe(unit,self.catalog)
        if d and d.structure and d.roles.defense and d.groundRange>0 and frame.Distance(position,unit:GetPosition())<28 then return false end
    end
    for _,site in ipairs(self.tasks:Sites())do local d=self.catalog[site.blueprint]
        if d and d.roles.defense and d.groundRange>0 and frame.Distance(position,site.position)<28 then return false end
    end
    local pd,q=buildable(self,actor,function(d)return d.roles.defense and d.groundRange>0 and not d.roles.factory end)
    if not canSpend(self,q)or q.mass>120 then return false end
    local enemy
    for _,contact in ipairs(self.contacts)do local d=self.catalog[contact.blueprint]
        if d and d.layer~='air'and d.groundRange>0 and contact.current and contact.channel=='vision'and contact.age<=2
            and frame.Distance(position,contact.position)<=pd.groundRange+(description.buildRange or 10)then enemy=contact;break end
    end
    if not enemy then return false end
    local reach=(actor:GetBlueprint().Economy or{}).MaxBuildDistance or description.buildRange or 10
    for ring=1,2 do for direction=0,7 do
        local angle=direction*math.pi/4;local radius=math.max(3,reach-1)*(ring/2)
        local p=frame.Point(position[1]+math.cos(angle)*radius,position[3]+math.sin(angle)*radius)
        if p[1]>2 and p[3]>2 and p[1]<self.map.width-2 and p[3]<self.map.height-2
            and frame.Distance(p,enemy.position)<=pd.groundRange
            and build(self,actor,pd,p,'local-emergency-pd-during-combat')then self.lastCombatDefense=self.now;return true end
    end end
    return false
end
function State:TacticalDefense(actor)
    local origin=actor:GetPosition()
    local d
    for _,u in ipairs(self.own)do
        local anchor=frame.Describe(u,self.catalog)
        local p=u:GetPosition()
        if anchor and (anchor.flags.MASSEXTRACTION or anchor.roles.factory)
            and frame.Distance(origin,p)<=65 and strategy.TacticalThreat(p,self.contacts,self.catalog)then
            local covered=false
            for _,unit in ipairs(self.own)do
                local defender=frame.Describe(unit,self.catalog)
                local range=defender and defender.tacticalInterceptRange or 0
                if range>0 and frame.Distance(unit:GetPosition(),p)<=range*.7 then covered=true;break end
            end
            if not covered then
                for _,site in ipairs(self.tasks:Sites())do
                    local defender=self.catalog[site.blueprint]
                    local range=defender and defender.tacticalInterceptRange or 0
                    if range>0 and frame.Distance(site.position,p)<=range*.7 then covered=true;break end
                end
            end
            if not covered then
                if not d then
                    local q
                    d,q=buildable(self,actor,function(candidate)
                        return candidate.structure and (candidate.tacticalInterceptRange or 0)>0
                    end)
                    if not q or self.mass<q.mass+60 or self.energy<q.energy+100 then return false end
                end
                local site=placement(self,actor,d,p,65,true,d.tacticalInterceptRange*.7)
                if site and build(self,actor,d,site,'cover-owned-economy-from-observed-tactical-missiles')then return true end
            end
        end
    end
    return false
end
function State:OpeningLandFollowup(actor,center)
    if not self.plan or not self.plan.allowInvestment or self.now<25 or self.now>150 then return false end
    local air,land=0,0
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
        if d and d.roles.factory and not d.roles.gantry then
            if d.layer=='air'and u:GetFractionComplete()>=1 then air=air+1 end
            if d.layer=='land'then land=land+1 end
        end
    end
    for _,id in ipairs(self.catalogIds)do local d=self.catalog[id]
        if d.roles.factory and not d.roles.gantry and d.layer=='land'then land=land+self.tasks:Pending(id)end
    end
    if air<1 or land>0 then return false end
    local landReach=false
    for _,start in ipairs(self.map.candidateStarts)do
        if start.land and start.land.reachable then landReach=true;break end
    end
    local reason=strategy.OpeningLandFollowup({now=self.now,airFactories=air,landFactories=land,
        landReach=landReach,allowInvestment=self.plan.allowInvestment},self.contacts,self.catalog)
    if not reason then return false end
    local factory,q=buildable(self,actor,function(d)return d.roles.factory and not d.roles.gantry and d.layer=='land'end)
    -- Protect a follow-up unit purchase and any generator reservation before
    -- committing the extra factory. Keep this below the general capacity cap.
    if not q or self.mass<q.mass+80 or self.energy<q.energy+200 then return false end
    local builder=frame.Describe(actor,self.catalog)
    local p=placement(self,actor,factory,center,40,true)
    if not p then return false end
    local eta=(factory.buildTime or 0)/math.max(.1,builder.buildRate or 1)
        +frame.Distance(actor:GetPosition(),p)/math.max(.1,builder.speed or 1)+20
    if eta>self.plan.deadline then return false end
    return build(self,actor,factory,p,reason)
end
function State:Infrastructure(actor)
    if self:NavalBootstrap(actor)then return true end
    if not self.opening then self.capacityWait='map-analysis-incomplete';return false end
    local center=self.map.ownStart
    if frame.Distance(actor:GetPosition(),center)>40 then
        local best,distance
        for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
            if d and(d.roles.factory or d.flags.MASSEXTRACTION)and u:GetFractionComplete()>=1 then
                local near=frame.Distance(actor:GetPosition(),u:GetPosition())
                if near<=60 and threat(self,u:GetPosition(),25)==0 and(not distance or near<distance)then best=u:GetPosition();distance=near end
            end
        end
        if not best then
            self.capacityWait='no-owned-safe-construction-anchor'
            if self.mass>=700 and threat(self,self.map.ownStart,35)==0 and frame.Distance(actor:GetPosition(),self.map.ownStart)>45 and path(self,actor,self.map.ownStart)==true then
                return submit(self,actor,'move',nil,self.map.ownStart,'return-builder-to-safe-production-anchor',function()IssueMove({actor},self.map.ownStart)end)
            end
            return false
        end;center=best
    end
    local factories=count(self,'factory');local completed=0;local air=0;local airReady,landCommitted=0,0
    for _,unit in ipairs(self.own)do local d=frame.Describe(unit,self.catalog)
        if d and d.roles.factory then
            if unit:GetFractionComplete()>=1 then completed=completed+1 end
            if d.layer=='air'then
                air=air+1
                if not d.roles.gantry and unit:GetFractionComplete()>=1 then airReady=airReady+1 end
            elseif d.layer=='land'and not d.roles.gantry then landCommitted=landCommitted+1 end
        end
    end
    if factories<1 then
        local mexes=0
        for _,unit in ipairs(self.own)do local d=frame.Describe(unit,self.catalog);if d and d.flags.MASSEXTRACTION then mexes=mexes+1 end end
        for id,d in pairs(self.catalog)do if d.flags.MASSEXTRACTION then mexes=mexes+self.tasks:Pending(id)end end
        if self.opening.style=='expansion'and(self.engineerCount or 0)<1 and mexes<2 then return false end
        local d=self.catalog[self.opening.steps[1].target]
        return d and place(self,actor,d,self.map.ownStart,'execute-map-selected-opening',40,true)or false
    end
    if completed<1 then return false end
    local airCover=false
    if airReady>0 and self.teamRole=='air_cover'and self.now<=150 then
        for _,id in ipairs(self.catalogIds)do local d=self.catalog[id]
            if d.roles.factory and not d.roles.gantry and d.layer=='land'then landCommitted=landCommitted+self.tasks:Pending(id)end
        end
        airCover=strategy.OpeningAirCover({now=self.now,teamRole=self.teamRole,
            allowInvestment=self.plan and self.plan.allowInvestment,airReady=airReady,landCommitted=landCommitted,
            reviewAge=self.now-(self.lastStrategy or self.now)},self.allies or{},function(home)
            local route=self.topology:Route(home,self.map.ownStart,'land')
            return route and route.length
        end)
    end
    if not airCover and self:OpeningLandFollowup(actor,center)then self.capacityWait='submitted-opening-land-followup';return true end
    local recover=self.now>=60 and self.mass>=math.max(700,self.massIncome*30)and self.energy>=600 and threat(self,center,35)==0
    if self.plan and not self.plan.allowInvestment and not recover then self.capacityWait='strategic-survival-or-short-deadline';return false end
    -- One funded reserve-capacity slot prevents a floating 3.7 M/s economy
    -- from being locked forever to one factory by floor(income / 4).
    local cap=math.min(20,math.max(1+math.floor(self.massIncome/4),factories+(self.now>=60 and self.mass>=700 and 1 or 0)));self.capacityTarget=cap;self.capacityWait='capacity-target-or-funding-limit'
    if factories<cap and self.mass>=400 and(self.massIncome>=4 or self.now>=60 and self.mass>=700)then
        local enemyAir=0
        for _,c in ipairs(self.contacts)do local d=self.catalog[c.blueprint];if d and d.layer=='air'and not d.roles.scout and c.confidence>.3 then enemyAir=enemyAir+d.mass*c.confidence end end
        local layer='land'
        if self.opening.style=='air_control'and air<math.max(1,math.floor(factories/2))or enemyAir>200 and air<1 or factories>=2 and air==0 and self.now>=120 and self.massIncome>=5 then layer='air'end
        if self.plan and self.plan.factoryLayer=='air'and air<math.max(1,math.ceil(factories/2))then layer='air'end
        if airCover then layer='air'end
        if self.plan and self.plan.factoryLayer=='naval'then layer='naval'end
        local d,q=buildable(self,actor,function(x)return x.roles.factory and not x.roles.gantry and x.layer==layer end)
        local reason=airCover and layer=='air'and'funded-team-air-cover-capacity'
            or frame.Distance(center,self.map.ownStart)>40 and'funded-forward-or-flank-production-capacity'
            or'funded-production-capacity-prefer-available-acu'
        local ad=frame.Describe(actor,self.catalog)
        local buildSeconds=d and(d.buildTime or 0)/math.max(.1,ad.buildRate or 1)or 0
        if d and self.plan and (airCover or not recover or buildSeconds>90)and buildSeconds+20>self.plan.deadline then self.capacityWait='new-capacity-misses-threat-deadline';return false end
        if not canSpend(self,q)then self.capacityWait='factory-quote-exceeds-spendable-budget'
        elseif self.mass<q.mass+160 then self.capacityWait='retain-army-production-budget'
        elseif place(self,actor,d,center,reason,90,true)then self.capacityWait='submitted-new-capacity';return true
        else self.capacityWait='no-legal-site-or-path-budget'end
    end
    if self.plan and not self.plan.allowInvestment then return false end
    local labs=math.min(3,math.max(self.massIncome>=3 and 1 or 0,math.floor(self.massIncome/8)))
    local researchTime=({land_pressure=80,air_control=90,expansion=55,defensive=60})[self.opening.style]or 80
    if self.now>=researchTime and count(self,'research')<labs then
        local d,q=buildable(self,actor,function(x)return x.roles.research end)
        if canSpend(self,q)and self.mass>=q.mass+100 and self.energy>=q.energy+150 then
            return place(self,actor,d,center,'funded-research-capacity-prefer-available-acu',90,true)
        end
    end
    return false
end

function State:ExperimentalBuild(actor)return self:DeploymentBuild(actor)end
function State:FactoryAddon(factory)
    local fd=frame.Describe(factory,self.catalog)
    if not fd or fd.layer~='land'or not self.siegePosition or frame.Distance(factory:GetPosition(),self.siegePosition.position)>65 or self.mass<350 then return false end
    local prefix=({UEF='uum',CYBRAN='ucm',ILLUMINATE='uim'})[self.faction]
    for _,suffix in ipairs({'0211','0111'})do local id=prefix..suffix;local d=self.catalog[id]
        if d then
            local have=false
            for _,unit in ipairs(self.own)do
                if string.lower(unit:GetBlueprint().BlueprintId or'')==id and frame.Distance(unit:GetPosition(),factory:GetPosition())<10 then have=true end
            end
            local q=frame.Quote(factory,d)
            if not have and canSpend(self,q)and submit(self,factory,'produce',id,nil,suffix=='0211'and'paid-forward-factory-shield'or'paid-forward-factory-tactical-missiles',function()IssueBuildFactory({factory},id,1)end)then
                self.mass=self.mass-q.mass;self.energy=self.energy-q.energy;return true
            end
        end
    end
    return false
end

function State:RepairAssigned(target)
    local key=tostring(target:GetEntityId());local lease=self.repairs[key]
    if not lease then return false end
    local present=false;for _,u in ipairs(self.own)do if u==lease.actor then present=true;break end end
    local current=present and safe(function()return self.tasks:Current(lease.actor)end)
    if lease.target==target and current and current.id==lease.task and current.kind=='repair'then return true end
    self.repairs[key]=nil;return false
end
function State:LeaseRepair(target,actor)
    local task=self.tasks:Current(actor)
    if task then self.repairs[tostring(target:GetEntityId())]={target=target,actor=actor,task=task.id}end
end
function State:Assist(actor,coreOnly)
    local best,score
    for _,target in ipairs(self.own)do local d=frame.Describe(target,self.catalog)
        local distance=frame.Distance(actor:GetPosition(),target:GetPosition())
        if target~=actor and d and d.structure and(not coreOnly or d.roles.factory or d.roles.research)and distance<(coreOnly and 40 or 60) and threat(self,target:GetPosition(),20)==0
            and(target:GetFractionComplete()<1 or target:GetHealth()<target:GetMaxHealth()*.85)then
            if not self:RepairAssigned(target)then
                local value=(d.roles.factory and 200 or 50)/(distance+10)
                if not score or value>score then best=target;score=value end
            end
        end
    end
    if not best then return false end
    local previous=best:GetHealth()+best:GetFractionComplete()*100000;local key=tostring(best:GetEntityId())
    local function observe()
        if best:IsDead()or best:GetArmy()~=self.army then return'failed',{cause='assist-target-lost'}end
        local f=best:GetFractionComplete();local health=best:GetHealth()
        if f>=1 and health>=best:GetMaxHealth()*.99 then return'completed',{entity=key,cause='owned-structure-restored'}end
        local value=health+f*100000
        if value>previous+.01 then previous=value;return'progress',{entity=key,fraction=f}end
    end
    if submit(self,actor,'repair',nil,best:GetPosition(),'idle-builder-assist-or-repair',function()IssueRepair({actor},best)end,observe)then
        self:LeaseRepair(best,actor);return true
    end
    return false
end
function State:FactoryAssist(actor)
    if type(IssueGuard)~='function'then return false end
    self.assistRetry=self.assistRetry or setmetatable({},{__mode='k'})
    local function activeChild(factory)
        return safe(function()
            if factory:IsDead()or factory:GetArmy()~=self.army then return end
            local child=factory:GetUnitBeingBuilt()
            if child and not child:IsDead()and child:GetArmy()==self.army and child:GetFractionComplete()<1 then return child end
        end)
    end
    local best,bestChild,score
    for _,factory in ipairs(self.own)do local d=frame.Describe(factory,self.catalog)
        local child=d and d.roles.factory and factory:GetFractionComplete()>=1 and activeChild(factory)
        local retry=self.assistRetry[factory]
        if retry and(self.now>=retry.untilTime or child~=retry.child or child and child:GetFractionComplete()>retry.fraction+.001)then
            self.assistRetry[factory]=nil;retry=nil
        end
        if child and not retry and threat(self,factory:GetPosition(),20)==0 then
            local distance=frame.Distance(actor:GetPosition(),factory:GetPosition());local helpers=0
            for _,u in ipairs(self.own)do local t=self.tasks:Current(u);if t and t.kind=='guard'and t.position and frame.Distance(t.position,factory:GetPosition())<1 then helpers=helpers+1 end end
            if distance<=120 and helpers<2 and(not score or distance+helpers*35<score)then best=factory;bestChild=child;score=distance+helpers*35 end
        end
    end
    if not best or path(self,actor,best:GetPosition())~=true then return false end
    local previousChild,previousFraction=bestChild,bestChild:GetFractionComplete()
    local previousDistance=frame.Distance(actor:GetPosition(),best:GetPosition());local usefulAt=self.now
    return submit(self,actor,'guard',nil,best:GetPosition(),'idle-builder-assists-active-factory',function()IssueGuard({actor},best)end,
        function()
            local child=activeChild(best)
            if not child then return'released',{cause='assist-no-active-factory-child'}end
            local fraction=child:GetFractionComplete()
            local output=child==previousChild and fraction>previousFraction+.001 and actor:GetUnitBeingBuilt()==child
            -- Accumulate small increments across samples; a slow but advancing
            -- build must not time out merely because each tick adds < .001.
            if child~=previousChild or output or actor:GetUnitBeingBuilt()~=child or fraction<previousFraction then previousFraction=fraction end
            previousChild=child
            local distance=frame.Distance(actor:GetPosition(),best:GetPosition())
            if distance<previousDistance-1 then previousDistance=distance;usefulAt=self.now end
            if output then
                usefulAt=self.now;self.assistRetry[best]=nil
                return'progress',{entity=tostring(child:GetEntityId()),fraction=fraction,cause='builder-observed-on-factory-child'}
            elseif self.now-usefulAt>=8 then
                self.assistRetry[best]={child=child,fraction=fraction,untilTime=self.now+20}
                return'released',{cause='no-observed-factory-assist-progress',retryAfter=20}
            end
        end)
end
function State:EngineerIntel(actor)
    local d=frame.Describe(actor,self.catalog)
    if not d or not d.roles.engineer or(actor:GetIntelRadius('Radar')or 0)<=0 then return false end
    self.engineerIntel=self.engineerIntel or{}
    local candidates={}
    for _,unit in ipairs(self.own)do local md=frame.Describe(unit,self.catalog)
        if md and md.flags.MASSEXTRACTION and unit:GetFractionComplete()>=1 then
            local p=unit:GetPosition();local outward=frame.Distance(p,self.map.ownStart)
            if outward>35 then candidates[#candidates+1]={id=tostring(unit:GetEntityId()),position=p,at=self.engineerIntel[tostring(unit:GetEntityId())]or-100}end
        end
    end
    table.sort(candidates,function(a,b)return a.at<b.at or a.at==b.at and a.id<b.id end)
    for _,site in ipairs(candidates)do
        local dx,dz=site.position[1]-self.map.ownStart[1],site.position[3]-self.map.ownStart[3];local length=math.max(1,math.sqrt(dx*dx+dz*dz))
        local p=frame.Point(site.position[1]+dx/length*14,site.position[3]+dz/length*14)
        if self.now-site.at>=20 and frame.Distance(actor:GetPosition(),p)>8 and threat(self,p,30)==0 and path(self,actor,p)==true then
            if submit(self,actor,'move',nil,p,'idle-engineer-frontier-radar-coverage',function()IssueMove({actor},p)end)then self.engineerIntel[site.id]=self.now;return true end
        end
    end
    return false
end
function State:CommanderCombat(actor,fighting)
    local d=frame.Describe(actor,self.productionCatalog or self.catalog)
    if not d or not d.roles.commander or actor:GetHealth()/math.max(1,actor:GetMaxHealth())<.65 or count(self,'factory')<1 then return false end
    local support,mexes=0,0
    for _,u in ipairs(self.own)do local ud=frame.Describe(u,self.productionCatalog or self.catalog)
        if ud and ud.flags.MASSEXTRACTION and u:GetFractionComplete()>=1 then mexes=mexes+1 end
        if ud and ud.mobile and not ud.roles.commander and not ud.roles.engineer and not ud.roles.reclaimer and u:GetFractionComplete()>=1 and ud.groundRange>0 and frame.Distance(u:GetPosition(),actor:GetPosition())<55 then support=support+ud.mass end
    end
    if not fighting and(mexes<2 or self.now<45)then return false end
    local target,score
    for _,c in ipairs(self.contacts)do local enemy=self.catalog[c.blueprint]
        if enemy and enemy.layer~='air'and c.current and c.channel=='vision'and c.age<=2 and self.targets[c.id]
            and frame.Distance(actor:GetPosition(),c.position)<75 and threat(self,c.position,20)<=support+180 then
            local value=frame.Distance(actor:GetPosition(),c.position)-(enemy.roles.economy and 30 or 0)
            if not score or value<score then target=c;score=value end
        end
    end
    if target and path(self,actor,target.position)==true then
        local live=self.targets[target.id];local observe=frame.CombatObserver(self.army,live,target.id,function()return self.combatReads end,actor,d.groundRange)
        return submit(self,actor,'attack',nil,target.position,'commander-pressure-with-support-and-retreat',function()IssueAttack({actor},live)end,observe)
    end
    if not fighting and support>=120 and self.now<180 then
        local x,z,mass=0,0,0
        for _,u in ipairs(self.own)do local ud=frame.Describe(u,self.productionCatalog or self.catalog)
            if ud and ud.mobile and not ud.roles.commander and not ud.roles.engineer and not ud.roles.reclaimer and u:GetFractionComplete()>=1 and ud.groundRange>0 then
                local p=u:GetPosition();local distance=frame.Distance(p,self.map.ownStart)
                if distance>25 and distance<120 then x=x+p[1]*ud.mass;z=z+p[3]*ud.mass;mass=mass+ud.mass end
            end
        end
        if mass>=120 then local p=frame.Point(x/mass,z/mass)
            if frame.Distance(actor:GetPosition(),p)>12 and threat(self,p,20)<=mass*.8 and path(self,actor,p)==true then
                return submit(self,actor,'advance',nil,p,'commander-pressure-supports-owned-front',function()IssueAggressiveMove({actor},p)end)
            end
        end
    end
    return false
end
function State:Radar(actor)
    if self.now<60 or count(self,'factory')<1 or self.mass<250 then return false end
    local radar,q=buildable(self,actor,function(d)return d.roles.radar and not d.roles.factory end)
    if not canSpend(self,q)then return false end
    for _,mex in ipairs(self.own)do local d=frame.Describe(mex,self.catalog)
        local p=mex:GetPosition()
        if d and d.flags.MASSEXTRACTION and mex:GetFractionComplete()>=1 and frame.Distance(p,self.map.ownStart)>45
            and frame.Distance(actor:GetPosition(),p)<75 then
            local covered=false
            for _,unit in ipairs(self.own)do local rd=frame.Describe(unit,self.catalog)
                if rd and rd.roles.radar and frame.Distance(unit:GetPosition(),p)<(rd.radarRadius or 60)*.65 then covered=true;break end
            end
            for _,site in ipairs(self.tasks:Sites())do local rd=self.catalog[site.blueprint]
                if rd and rd.roles.radar and frame.Distance(site.position,p)<(rd.radarRadius or 60)*.65 then covered=true end
            end
            if not covered and place(self,actor,radar,p,'radar-cover-owned-frontier-and-approaches')then return true end
        end
    end
    return false
end
function State:SiegeBuild(actor)
    local objective=self.siegePosition
    if not objective or self.now-objective.at>12 or self.mass<600 then return false end
    if frame.Distance(actor:GetPosition(),objective.position)>90 or path(self,actor,objective.position)~=true then return false end
    local nearby=0
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
        if d and d.roles.factory and frame.Distance(u:GetPosition(),objective.position)<55 then nearby=nearby+1 end
    end
    for _,site in ipairs(self.tasks:Sites())do local d=self.catalog[site.blueprint]
        if d and d.roles.factory and frame.Distance(site.position,objective.position)<55 then nearby=nearby+1 end
    end
    if nearby>0 then return false end
    local factory,q=buildable(self,actor,function(d)return d.roles.factory and d.layer=='land'end)
    return canSpend(self,q)and place(self,actor,factory,objective.position,'supported-forward-siege-factory')or false
end
function State:Detonate(actor,d)
    if self.faction~='CYBRAN'or not self.brain:HasResearched(d.structure and'CBA_POWERDETONATE'or'CLA_POWERDETONATE')or d.flags.EXPERIMENTAL
        or actor:GetHealth()/math.max(1,actor:GetMaxHealth())>.2 or type(IssueAbility)~='function'then return false end
    self.detonateAt=self.detonateAt or{}
    if self.now-(self.detonateAt[actor]or-100)<15 then return false end
    local radius=0
    for _,weapon in ipairs(actor:GetBlueprint().Weapons or{})do
        if type(weapon)=='table'and weapon.Label=='PowerDetonate'then radius=weapon.DamageRadius or 0 end
    end
    if radius<=0 then return false end
    local value=0;local p=actor:GetPosition()
    for i=1,math.min(96,#self.contacts)do local c=self.contacts[i];local enemy=self.catalog[c.blueprint]
        if enemy and enemy.layer~='air'and c.current and c.channel=='vision'and c.age<=2 and frame.Distance(c.position,p)<radius*.8 then value=value+enemy.mass end
    end
    local friendly=0
    for _,u in ipairs(self.own)do local ud=frame.Describe(u,self.catalog)
        if u~=actor and ud and ud.layer~='air'and frame.Distance(u:GetPosition(),p)<radius then friendly=friendly+ud.mass end
    end
    if value<math.max(100,d.mass*1.5)+friendly or self.orders>=self.profile.ordersPerSecond*self.profile.decisionSeconds then return false end
    -- Immediate native ability; the engine still validates research/state.
    -- Submission is deliberately not reported as damage or a successful trade.
    IssueAbility({actor},p,'PowerDetonate');self.orders=self.orders+1;self.detonateAt[actor]=self.now
    log(self,'ability-issued',{actor=actor:GetEntityId(),ability='PowerDetonate',evidence='submitted',reason='low-health-close-visible-value-trade'})
    return true
end

function State:Mobility(actor,d,intent)
    if self.faction~='ILLUMINATE'or not self.brain:HasResearched('ILA_TELEPORT')or d.layer~='land'
        or type(IssueTeleport)~='function'or type(actor.TestCommandCaps)~='function'or type(actor.GetTeleportRange)~='function'then return false end
    if not actor:TestCommandCaps('RULEUCC_Teleport')then return false end
    self.mobilityAt=self.mobilityAt or{}
    local general=actor:GetBlueprint().General or{}
    if self.now-(self.mobilityAt[actor]or-100)<math.max(20,general.TeleportCooldown or 20)then return false end
    local cost=general.MoveEnergyCost
    local range=actor:GetTeleportRange()
    if type(cost)~='number'or cost<=0 or type(range)~='number'or range<=0 or self.energy<cost+150 then return false end
    local origin=actor:GetPosition();local p
    if intent and intent.kind=='withdraw'then
        local home=self.map.ownStart;local distance=frame.Distance(origin,home);local step=math.min(range*.85,distance)
        if distance>20 then p=frame.Point(origin[1]+(home[1]-origin[1])/distance*step,origin[3]+(home[3]-origin[3])/distance*step)end
    elseif self.profile.compareFlanks then
        for _,contact in ipairs(self.contacts)do local enemy=self.catalog[contact.blueprint]
            if enemy and contact.current and contact.channel=='vision'and enemy.structure and(enemy.roles.economy or enemy.roles.factory)then
                local distance=frame.Distance(origin,contact.position)
                if distance>25 and distance<range*.9 then
                    local dx,dz=contact.position[1]-origin[1],contact.position[3]-origin[3]
                    local side=self.army%2==0 and 1 or-1
                    local candidate=frame.Point(contact.position[1]-dz/distance*12*side,contact.position[3]+dx/distance*12*side)
                    local cover=0
                    for _,unit in ipairs(self.own)do local ud=frame.Describe(unit,self.productionCatalog)
                        if ud and ud.mobile and ud.groundRange>0 and frame.Distance(unit:GetPosition(),candidate)<50 then cover=cover+ud.mass end
                    end
                    if cover>=math.max(160,threat(self,candidate,25)*1.4)then p=candidate;break end
                end
            end
        end
    end
    if not p or p[1]<2 or p[3]<2 or p[1]>self.map.width-2 or p[3]>self.map.height-2 or frame.Distance(origin,p)>range
        or GetSurfaceHeight(p[1],p[3])>GetTerrainHeight(p[1],p[3])+.5 or threat(self,p,10)>threat(self,origin,10)+80 then return false end
    self.tasks:Cancel(actor,self.now,'teleport-tactical-replan')
    if submit(self,actor,'move',nil,p,intent and intent.kind=='withdraw'and'teleport-withdrawal'or'teleport-scouted-backline-flank',function()IssueTeleport({actor},p)end)then
        self.mobilityAt[actor]=self.now;self.energy=self.energy-cost;return true
    end
    return false
end

function State:Micro()
    self.microHeld={};self.microAt=self.microAt or{};local assigned={};local sampled=0;local mobile={}
    local x,z,total=0,0,0
    for _,unit in ipairs(self.own)do local d=frame.Describe(unit,self.productionCatalog)
        if d and d.mobile and not d.roles.engineer and not d.roles.commander and not d.roles.scout and not d.roles.reclaimer and unit:GetFractionComplete()>=1 then
            mobile[#mobile+1]=unit;local p=unit:GetPosition();x=x+p[1]*d.mass;z=z+p[3]*d.mass;total=total+d.mass
        end
    end
    -- Rotate eight units per decision so large armies stay within work limits.
    self.nanobotSupport=total>=800 and frame.Point(x/total,z/total)or nil
    self.microTargets=self.microTargets or{}
    local n=#mobile;local cursor=self.microCursor or 0
    for i=1,math.min(8,n)do local actor=mobile[(cursor+i-1)%n+1]
        local d=frame.Describe(actor,self.productionCatalog)
        if self.now-(self.microAt[actor]or-100)>=2 then
            -- Own capability uses our earned research. Enemy potential uses the
            -- public catalog; our missing upgrades say nothing about theirs.
            local intent=tactics.Decide({description=d,position=actor:GetPosition(),health=actor:GetHealth()/math.max(1,actor:GetMaxHealth()),home=self.map.ownStart},self.contacts,self.catalog,assigned)
            local detonating=self:Detonate(actor,d)
            local mobility=detonating
            if not detonating and self.orders<self.profile.ordersPerSecond*self.profile.decisionSeconds then mobility=self:Mobility(actor,d,intent)end
            if mobility then self.microHeld[actor]=true;self.microAt[actor]=self.now
            elseif intent then
                self.microHeld[actor]=true
                if self.orders<self.profile.ordersPerSecond*self.profile.decisionSeconds then
                    local prior=self.microTargets[actor]
                    local current=self.tasks:Current(actor)
                    local p=intent.position or intent.target.position
                    local same=intent.kind=='focus'and prior==intent.target.id and current and current.kind=='attack'
                    if current and current.kind=='move'and current.reason==intent.reason and current.position
                        and frame.Distance(current.position,p)<=6 and self.now-current.lastProgress<=15 then same=true end
                    if intent.kind=='focus'and current and current.kind=='attack'and self.now-current.started<4
                        and prior and self.targets[prior]then same=true end
                    local valid=intent.kind=='focus'or p[1]>2 and p[3]>2 and p[1]<self.map.width-2 and p[3]<self.map.height-2 and path(self,actor,p)==true
                    local live=intent.target and self.targets[intent.target.id]
                    if not same and valid and(intent.kind~='focus'or live)then
                        self.tasks:Cancel(actor,self.now,'tactical-replan')
                        local observe=live and frame.CombatObserver(self.army,live,intent.target.id,function()return self.combatReads end,actor,intent.target and self.catalog[intent.target.blueprint].layer=='air'and d.airRange or d.groundRange)
                        if submit(self,actor,live and'attack'or'move',nil,p,intent.reason,function()
                            if live then IssueAttack({actor},live)else IssueMove({actor},p)end
                        end,observe)then self.microAt[actor]=self.now;self.microTargets[actor]=intent.target and intent.target.id or nil end
                    end
                end
            end
        end
    end
    self.microCursor=(cursor+8)%math.max(1,n)
    local liveActors={};for _,unit in ipairs(mobile)do liveActors[unit]=true end
    for actor in pairs(self.microAt)do if not liveActors[actor]then self.microAt[actor]=nil;self.microTargets[actor]=nil;if self.mobilityAt then self.mobilityAt[actor]=nil end;if self.detonateAt then self.detonateAt[actor]=nil end end end
    if total>=600 and self.now-(self.lastSiegePlan or-100)>=10 then
        self.lastSiegePlan=self.now;local center=frame.Point(x/total,z/total);local target
        for _,c in ipairs(self.contacts)do local d=self.catalog[c.blueprint]
            if d and d.structure and c.confidence>.5 and frame.Distance(center,c.position)<120 then target=c;break end
        end
        local prior=self.siegePosition;self.siegePosition=nil
        if target then
            local dx,dz=target.position[1]-center[1],target.position[3]-center[3];local length=math.max(1,math.sqrt(dx*dx+dz*dz))
            local p=frame.Point(target.position[1]-dx/length*60,target.position[3]-dz/length*60)
            local covering=0
            for _,unit in ipairs(mobile)do if frame.Distance(unit:GetPosition(),p)<55 then covering=covering+frame.Describe(unit,self.catalog).mass end end
            if covering>=400 and threat(self,p,35)<covering*.55 then self.siegePosition={position=p,at=self.now}end
        end
        if prior or self.siegePosition then log(self,'siege-plan',{state=self.siegePosition and'funded-covered-position'or'withdraw-investment',evidence='observed-force-and-known-threat'})end
    end
end

function State:Repair(actor)
    for _,target in ipairs(self.own)do local d=frame.Describe(target,self.catalog)
        if d and d.structure and target:GetFractionComplete()<1 and frame.Distance(actor:GetPosition(),target:GetPosition())<35 and threat(self,target:GetPosition(),20)==0 then
            local busy=false
            for _,builder in ipairs(self.own)do local bd=frame.Describe(builder,self.catalog)
                if bd and(bd.roles.commander or bd.roles.engineer)and builder:GetUnitBeingBuilt()==target then busy=true;break end
            end
            local key=tostring(target:GetEntityId())
            if self:RepairAssigned(target)then busy=true end
            if not busy then
                local fraction=target:GetFractionComplete()
                local function observe()
                    if target:IsDead()or target:GetArmy()~=self.army then return'failed',{cause='unfinished-structure-lost'}end
                    local f=target:GetFractionComplete()
                    if f>=1 then return'completed',{entity=key,fraction=f}end
                    if f>fraction+.01 then fraction=f;return'progress',{entity=key,fraction=f}end
                end
                if submit(self,actor,'repair',d.id,target:GetPosition(),'resume-abandoned-owned-construction',function()IssueRepair({actor},target)end,observe)then self:LeaseRepair(target,actor);return true end
            end
        end
    end
    return false
end
function State:OptionalResearch(definitions)
    if self.now<45 or count(self,'factory')<1 then return end
    local reclaimMass=0
    for _,r in ipairs(self.reclaim or{})do
        if not r.remembered and self.now-r.lastSeen<=5 and threat(self,r.position,35)==0
            and frame.Distance(r.position,self.map.ownStart)<120 then reclaimMass=reclaimMass+r.mass end
    end
    local bot=({UEF='rfurb01',CYBRAN='rfcrb01',ILLUMINATE='rfirb01'})[self.faction]
    if bot and self.catalog[bot]and count(self,'reclaimer')==0 and reclaimMass>=200 then
        local node=planning.UnitUnlock(bot,definitions,self.brain,false)
        if node then return node,'paid-reclaimer-unlock-for-observed-wrecks'end
    end
    if self.faction=='UEF'and self.catalog.rfuc01 and self.now>=180 and self.massIncome>=3
        and self.mass>=600 and self.energy>=1500 then
        local node=planning.UnitUnlock('rfuc01',definitions,self.brain,false)
        if node then return node,'paid-centurion-unlock-for-funded-land-pressure'end
    end
end
function State:WorkerProduction(factory,quotes,cap)
    local expansionWorker=self:ExpansionWorker(factory,quotes,cap)
    if expansionWorker then return expansionWorker end
    if self.now<20 or cap<1 then return nil,'opening-or-unit-cap'end
    local factoryData=frame.Describe(factory,self.catalog)
    local reclaim=import('/lua/sim/reforged_reclaim.lua');local coverage=reclaim.Coverage(self.army)
    -- Retain funds for combat/power. Never hire against the same unspent mex
    -- budget repeatedly; each admission immediately submits a paid task.
    local mass=math.max(0,self.mass-200);local energy=math.max(0,self.energy-500)
    local engineer,engineerQuote,bot,botQuote
    for _,id in ipairs(self.catalogIds)do local d=self.catalog[id];local q=quotes[id]
        if q and d.faction==self.faction and q.mass<=mass and q.energy<=energy then
            if d.roles.engineer and(not engineerQuote or q.mass<engineerQuote.mass)then engineer=d;engineerQuote=q end
            if d.roles.reclaimer and(not botQuote or q.mass<botQuote.mass)then bot=d;botQuote=q end
        end
    end
    if not engineer and not bot then return nil,'no-legal-affordable-worker'end
    local workers={};local probe
    for _,actor in ipairs(self.own)do local d=frame.Describe(actor,self.catalog)
        if d and d.roles.engineer then
            local task=self.tasks:Current(actor);local ready=0
            if task then
                if task.kind=='guard'then ready=math.max(0,12-(self.now-task.started))
                else ready=math.max(5,90-(self.now-task.started))end
            end
            workers[#workers+1]={id=tostring(actor:GetEntityId()),state=actor:GetFractionComplete()<1 and'queued'or task and'busy'or'idle',readyInSeconds=ready}
            if not probe and actor:GetFractionComplete()>=1 and threat(self,actor:GetPosition(),20)==0 then probe=actor end
        end
    end
    for _,id in ipairs(self.catalogIds)do if self.catalog[id].roles.engineer and self.tasks:Pending(id)>0 then
        workers[#workers+1]={id='pending-'..id,state='submitted',readyInSeconds=90}
    end end
    -- A first salvage specialist has no identical navigator yet. Admit at most
    -- one against fresh, unclaimed LOCAL demand, without declaring a route.
    -- Subsequent growth requires an actual specialist's routes to factory and
    -- field. Every spawned unit validates its own path before accepting work.
    local pendingBot=false;local botProbe
    for _,actor in ipairs(self.own)do local d=frame.Describe(actor,self.catalog)
        if d and d.roles.reclaimer then
            if actor:GetFractionComplete()<1 or not self.tasks:Current(actor)then pendingBot=true end
            if bot and d.id==bot.id and actor:GetFractionComplete()>=1 and threat(self,actor:GetPosition(),20)==0 then botProbe=actor end
        end
    end
    for _,id in ipairs(self.catalogIds)do if self.catalog[id].roles.reclaimer and self.tasks:Pending(id)>0 then pendingBot=true end end
    local bots=count(self,'reclaimer')
    if bot and not pendingBot and bots<2 and threat(self,factory:GetPosition(),35)==0
        and(bots==0 or botProbe and path(self,botProbe,factory:GetPosition())==true)then
        local useful=0
        for _,r in ipairs(self.reclaim or{})do
            if not r.remembered and self.now>=r.lastSeen and self.now-r.lastSeen<=5 and not self.reclaimLeases[tostring(r.id)]
                and frame.Distance(factory:GetPosition(),r.position)<=(bots==0 and 60 or 120)and threat(self,r.position,35)==0
                and reclaim.Visible(r.position,coverage)and(bots==0 or path(self,botProbe,r.position)==true)then useful=useful+r.mass end
        end
        if useful>=math.max(200,botQuote.mass*5)*(bots+1)then
            return{blueprint=bot.id,role='reclaimer',reason=bots==0 and'paid-first-specialist-for-visible-local-salvage'or'paid-specialist-for-reachable-unclaimed-salvage'}
        end
    end
    -- Bootstrap/recover one engineer when none remains. Local visible work is
    -- demand, NOT proof of a land route; the new worker must validate its own
    -- path before accepting a job. Never use an amphibious ACU as that proof.
    if #workers==0 and engineer and threat(self,factory:GetPosition(),35)==0 then
        if self.mass>=math.max(700,(self.massIncome or 0)*30)and self.energy>=engineerQuote.energy+500 and count(self,'factory')<20 then
            return{blueprint=engineer.id,role='engineer',reason='recover-builder-for-funded-production-backlog'}
        end
        local work=0
        for _,site in ipairs(self.map.massSites)do
            if frame.Distance(factory:GetPosition(),site.position)<=80 and reclaim.Visible(site.position,coverage)
                and not occupied(self,site.position)and not self.siteLeases[site.id]
                and(self.siteRetry[site.id]or 0)<=self.now and threat(self,site.position,35)==0 then work=work+1 end
        end
        for _,actor in ipairs(self.own)do local d=frame.Describe(actor,self.catalog)
            if d and d.structure and actor:GetFractionComplete()<1 and frame.Distance(factory:GetPosition(),actor:GetPosition())<=80 then work=work+1 end
        end
        if work>=2 then return{blueprint=engineer.id,role='engineer',reason='paid-first-engineer-for-observed-local-work'}end
    end
    -- Growth uses an actual engineer's navigator and compatible movement rules.
    if not probe then return nil,'no-owned-engineer-route-probe'end
    local pd=frame.Describe(probe,self.catalog)
    local function compatible(d)return d and d.motionType and d.motionType==pd.motionType
        and((d.navigationRadius==nil and pd.navigationRadius==nil)or finite(d.navigationRadius)and finite(pd.navigationRadius)and d.navigationRadius<=pd.navigationRadius)
        and d.footprintX<=pd.footprintX and d.footprintZ<=pd.footprintZ end
    -- A probe already on another island cannot establish this factory's route.
    if path(self,probe,factory:GetPosition())~=true then return nil,'worker-factory-route-unconfirmed'end
    local limit=({easy=2,normal=4,hard=6,reforger=8})[self.profile.level]or 4
    if not engineer or not compatible(engineer)or count(self,'engineer')>=limit then return nil,'worker-safety-cap-or-motion-mismatch'end
    if not finite(engineer.buildTime)or not finite(factoryData.buildRate)or factoryData.buildRate<=0
        or not finite(pd.buildRate)or pd.buildRate<=0 then return nil,'missing-public-build-timing'end
    local mex,mq=buildable(self,probe,function(d)return d.flags.MASSEXTRACTION end)
    if not mex or not finite(mex.buildTime)or not finite(mex.massProduction)or mex.massProduction<=0 then return nil,'missing-mex-work-evidence'end
    local jobs={};local remainingMass=mass-engineerQuote.mass;local remainingEnergy=energy-engineerQuote.energy
    for _,site in ipairs(self.map.massSites)do
        if #jobs>=16 then break end
        if remainingMass>=mq.mass and remainingEnergy>=mq.energy and not occupied(self,site.position)and not self.siteLeases[site.id]
            and(self.siteRetry[site.id]or 0)<=self.now and reclaim.Visible(site.position,coverage)
            and threat(self,site.position,35)==0 and buildSiteLegal(self,mex,site.position)
            and path(self,probe,site.position)==true then
            local seconds=mex.buildTime/pd.buildRate+frame.Distance(probe:GetPosition(),site.position)/math.max(.1,pd.speed)
            local gain=mex.massProduction*math.max(0,180-seconds)-mq.mass
            if gain>0 then
                jobs[#jobs+1]={id=site.id,funded=true,safeForEngineer=true,siteValidated=true,routeValidated=true,reachable=true,
                    validatedAt=self.now,openSlots=1,workerSeconds=seconds,netGainMass=gain}
                remainingMass=remainingMass-mq.mass;remainingEnergy=remainingEnergy-mq.energy
            end
        end
    end
    local q={legal=true,canBuild=true,mass=engineerQuote.mass,energy=engineerQuote.energy,
        buildSeconds=engineer.buildTime/factoryData.buildRate,deploymentSeconds=10}
    return logistics.ChooseEngineerProduction({now=self.now,horizonSeconds=90,capRemaining=cap,massBudget=mass,energyBudget=energy,
        jobs=jobs,workers=workers,quotes={[engineer.id]=q}},self.catalog)
end
function State:Reclaimers()
    for _,actor in ipairs(self.own)do local d=frame.Describe(actor,self.catalog)
        if d and d.roles.reclaimer and actor:GetFractionComplete()>=1 then
            local danger=threat(self,actor:GetPosition(),20)>0 or self:BuilderInCombat(actor)
            local current=self.tasks:Current(actor)
            if danger then
                if current and current.kind=='reclaim'then self.tasks:Cancel(actor,self.now,'reclaim-danger')end
                if not self.tasks:Busy(actor,self.now)then self:BuilderWithdraw(actor,'unarmed-reclaimer-withdraws')end
            elseif not self.tasks:Busy(actor,self.now)and frame.Ready(actor)then self:Reclaim(actor)end
        end
    end
end
function State:Reclaim(actor)
    self:RefreshReclaim()
    local choices={}
    for _,r in ipairs(self.reclaim or{})do
        if not r.remembered and self.now>=r.lastSeen and self.now-r.lastSeen<=5 and r.mass>=15
            and threat(self,r.position,35)==0 and not self.reclaimLeases[tostring(r.id)]then
            local gain=r.mass/(5+frame.Distance(actor:GetPosition(),r.position)/3)
            if gain>2 then choices[#choices+1]={record=r,score=gain}end
        end
    end
    table.sort(choices,function(a,b)return a.score>b.score or a.score==b.score and tostring(a.record.id)<tostring(b.record.id)end)
    for i=1,math.min(8,#choices)do
        local best=choices[i].record;local reachable=path(self,actor,best.position)
        if reachable==nil then return false end -- budget exhausted; next tick
        if reachable then
            local reclaim=import('/lua/sim/reforged_reclaim.lua')
            if reclaim.Visible(best.position,reclaim.Coverage(self.army))then
                local prop=GetEntityById(tonumber(best.id));local previousMass=best.mass
                local function observe()
                    if threat(self,best.position,35)>0 then return'released',{cause='reclaim-field-became-dangerous'}end
                    if not reclaim.Visible(best.position,reclaim.Coverage(self.army))then
                        return'released',{cause='reclaim-vision-lost'}
                    end
                    local fresh=reclaim.Collect(self.army,best.position,2,false)
                    for _,r in ipairs(fresh)do if tostring(r.id)==tostring(best.id)then
                        if r.mass<previousMass then previousMass=r.mass;return'progress',{massRemaining=r.mass,cause='visible-wreck-mass-decreased'}end
                        return
                    end end
                    return'completed',{cause='visible-wreck-removed'}
                end
                if prop and submit(self,actor,'reclaim',nil,best.position,'fresh-secured-profitable-wreckfield',function()IssueReclaim({actor},prop)end,observe)then
                    local task=self.tasks:Current(actor)
                    self.reclaimLeases[tostring(best.id)]={actor=actor,actorId=tostring(actor:GetEntityId()),task=task.id}
                    return true
                end
            end
        end
    end
    return false
end
function State:RefreshReclaim()
    if self.now<(self.nextReclaim or 0)then return end
    self.nextReclaim=self.now+5;self.reclaim={}
    -- Only this controller's fresh sensor collection feeds memory. Presentation
    -- Snapshot() can run for spectator focus and must never change AI decisions.
    local reclaim=import('/lua/sim/reforged_reclaim.lua')
    local fresh,_,_,coverage=reclaim.Collect(self.army);local seen={}
    for _,r in ipairs(fresh)do seen[tostring(r.id)]=true end
    for id,r in pairs(self.reclaimMemory)do
        if self.now-r.lastSeen>20 or not seen[id]and coverage and reclaim.Visible(r.position,coverage)then self.reclaimMemory[id]=nil end
    end
    table.sort(fresh,function(a,b)return a.mass>b.mass or a.mass==b.mass and tostring(a.id)<tostring(b.id)end)
    for i=1,math.min(128,#fresh)do local r=fresh[i]
        local record={id=r.id,position={r.position[1],r.position[2],r.position[3]},mass=r.mass,lastSeen=self.now,remembered=false}
        self.reclaim[#self.reclaim+1]=record;self.reclaimMemory[tostring(r.id)]=record
    end
    local ids={};for id in pairs(self.reclaimMemory)do ids[#ids+1]=id end
    table.sort(ids,function(a,b)local x,y=self.reclaimMemory[a],self.reclaimMemory[b];return x.lastSeen>y.lastSeen or x.lastSeen==y.lastSeen and a<b end)
    for i=257,#ids do self.reclaimMemory[ids[i]]=nil end
end
director.Attach(State,{path=path,threat=threat,occupied=occupied,submit=submit,log=log})
campaign.Attach(State,{path=path,threat=threat,submit=submit,log=log,count=count,build=build,buildable=buildable,placement=placement})
expansion.Attach(State,{path=path,threat=threat,occupied=occupied,build=build,buildable=buildable,canSpend=canSpend,siteLegal=buildSiteLegal})
function State:StrategicRecall()
    if not self.plan or not self.plan.emergency then return end
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog);local t=self.tasks:Current(u)
        if d and d.mobile and not d.roles.commander and not d.roles.engineer and not d.roles.scout and not d.roles.reclaimer
            and t and(t.kind=='advance'or t.kind=='attack'or t.kind=='move')and t.position
            and frame.Distance(t.position,self.map.ownStart)>85 and not string.find(t.reason or'','withdraw',1,true)
            and self.orders<self.profile.ordersPerSecond*self.profile.decisionSeconds then
            self.tasks:Cancel(u,self.now,'strategic-emergency-recall');self.orders=self.orders+1
        end
    end
end
function State:Phase(name)
    self.phase=name
    if self.phaseTrace then log(self,'controller-phase',{phase=name})end
end
function State:Step()
    self:Phase('clock-and-rules')
    self.now=GetGameTimeSeconds();self.orders=0;self.pathQueries=0
    self.tasks:SetBudget(function(cost,check)return self:ReserveCalls(cost,check)end)
    if self.failedFairness then error('AI rules changed; controller stopped')end
    if self.now-(self.lastValidation or 0)>=30 then
        self.lastValidation=self.now
        if not Validate(self.brain)then self.failedFairness=true;error('AI rules readback failed')end
    end
    self:Phase('own-units');self.own=frame.Own(self.brain);self.combatReads={}
    self:Phase('task-progress');self.tasks:Step(self.now,self.own)
    local live={};for _,u in ipairs(self.own)do live[tostring(u:GetEntityId())]=u end
    for id in pairs(self.raids)do if not live[id]then self.raids[id]=nil end end
    for id in pairs(self.repairs)do if not live[id]or not self:RepairAssigned(live[id])then self.repairs[id]=nil end end
    for id,lease in pairs(self.reclaimLeases)do
        local current=live[lease.actorId]==lease.actor and self.tasks:Current(lease.actor)
        if not current or current.id~=lease.task then self.reclaimLeases[id]=nil end
    end
    for key,q in pairs(self.pathCache)do if self.now-q.at>30 then self.pathCache[key]=nil end end
    for _,result in ipairs(self.tasks:DrainOutcomes())do
        for _,site in ipairs(self.map.massSites)do if frame.Distance(site.position,result.position)<1 then
            self.siteLeases[site.id]=nil
            if result.kind=='task-completed'then self.siteFailures[site.id]=nil;self.siteRetry[site.id]=nil
            elseif(result.kind=='task-stalled'or result.kind=='task-failed')and not result.child then
                local n=math.min(3,(self.siteFailures[site.id]or 0)+1);self.siteFailures[site.id]=n;self.siteRetry[site.id]=self.now+20*2^(n-1)
                log(self,'site-backoff',{site=site.id,x=site.position[1],z=site.position[3],untilTime=self.siteRetry[site.id],cause=result.cause,attempt=n})
            end
            break
        end end
    end
    self:Phase('perception');local engaged={}
    for _,u in ipairs(self.own)do local t=self.tasks:Current(u);local id=self.microTargets and self.microTargets[u]
     if t and t.kind=='attack'and id then engaged[#engaged+1]=id end
    end
    self.contacts,self.targets,self.cursor=frame.Observe(self.brain,self.own,self.memory,self.catalog,self.now,self.cursor,self.targets,engaged)
    if not self.productionCatalog or self.now-(self.lastCapabilityRead or-100)>=3 then
        self:Phase('research-capabilities');self.productionCatalog=frame.ResearchedCatalog(self.brain,self.catalog);self.lastCapabilityRead=self.now
    end
    frame.PrepareOwn(self.own,self.brain);self:RefreshOperations()
    self:Phase('reclaim');self:RefreshReclaim()
    self:Phase('economy');economy(self)
    self:Phase('urgent-tactics');self:Micro()
    self:Phase('power-planning');planPower(self)
    self:Phase('strategy');self:ReviewStrategy();self:StrategicRecall()
    self:Phase('deployment');self:ReserveDeployment()
    self:Phase('team');self:TeamWork()
    self:Phase('reclaimer-work');self:Reclaimers()
    self:Phase('builders');builders(self)
    self:Phase('production');self:ProductionStep()
    for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
        if d and d.structure and u:GetFractionComplete()>=1 then self:Detonate(u,d)end
    end
    self:Phase('cloak-support');self:CicadaSupport();self:RetailConversion()
    self:Phase('forces');self:Forces()
    self:Phase('research');self:ResearchStep()
    if self.now-(self.lastSummary or-100)>=10 then
        self.lastSummary=self.now
        local active=self.tasks:ActiveCount();local idleBuilders=0
        if self.builderCombat then for actor in pairs(self.builderCombat)do
            local ok,id=pcall(function()return tostring(actor:GetEntityId())end)
            if not ok or live[id]~=actor then self.builderCombat[actor]=nil end
        end end
        for _,unit in ipairs(self.own)do local d=frame.Describe(unit,self.catalog)
            if d and(d.roles.commander or d.roles.engineer)and frame.Ready(unit)and not self.tasks:Busy(unit,self.now)then idleBuilders=idleBuilders+1 end
        end
        log(self,'capacity-state',{reason=self.capacityWait or'not-requested',target=self.capacityTarget or count(self,'factory'),factories=count(self,'factory'),mass=self.mass,energy=self.energy})
        for _,unit in ipairs(self.own)do local d=frame.Describe(unit,self.catalog)
            if d and(d.roles.commander or d.roles.engineer)and frame.Ready(unit)and not self.tasks:Busy(unit,self.now)then
                log(self,'builder-wait',{actor=tostring(unit:GetEntityId()),reason=self.expansionWait or'no-current-safe-affordable-task',power=self.powerWait or'not-requested',capacity=self.capacityWait or'not-requested'})
            end
        end
        log(self,'economy-budget',{rawMass=self.rawMass,rawEnergy=self.rawEnergy,taskMass=self.taskMass,taskEnergy=self.taskEnergy,powerMass=self.powerMass,powerEnergy=self.powerEnergy,pendingPower=self.pendingPower,futurePower=self.futurePower,energyIncome=self.energyIncome,powerIncomeTarget=self.powerIncomeTarget,powerWait=self.powerWait,spendableMass=self.mass,spendableEnergy=self.energy})
        log(self,'controller-state',{level=self.profile.level,incomePercent=self.brain.ReforgedResourcePercent or 100,ownUnits=#self.own,visibleTargets=(function()local n=0;for _ in pairs(self.targets)do n=n+1 end;return n end)(),contacts=#self.contacts,
            mass=self.mass,energy=self.energy,massIncome=self.massIncome,energySurplus=self.energySpare,orders=self.orders,pathQueries=self.pathQueries,
            opening=self.opening and self.opening.style or'analyzing',builderWait=self.builderWait or'normal-priorities',activeTasks=active,idleBuilders=idleBuilders,expansion=self.expansionWait or'not-evaluated',researchGoal=self.researchGoal or'none',objective=self.wreckObjective and'secure-wreckfield:'..self.wreckObjective.id or'normal-priorities',
            researchStrategy=self.doctrine and self.doctrine.id or'none',deployment=self.deploymentWait or'none',deploymentReservedMass=self.deploymentMass or 0,
            waiting=self.orders>0 and'executing-orders'or active>0 and'observing-task-progress'or(self.mass<40 or self.energy<60)and'saving-funds'or'no-legal-affordable-task',worker=self.workerWait or'not-evaluated',quoteSource='public-base-conservative'})
    end
    self.phaseTrace=false;self.phase='waiting'
end
function State:ResearchStep()return research(self)end
function State:ProductionStep()return produce(self)end
operations.Attach(State,{path=path,submit=submit,log=log,contestedField=contestedField,count=count,build=build,buildable=buildable,placement=placement})
function Create(brain)
    local profile=assert(policy.Profile(brain.ReforgedAILevel));local map=frame.PublicMap(brain)
    local self=setmetatable({brain=brain,army=brain:GetArmyIndex(),profile=profile,map=map,tps=SIM_TICKS_PER_SECOND,trace=trace(brain),
        catalog=frame.Catalog(),cursor=0,pathCache={},siteLeases={},siteRetry={},siteFailures={},scouted={},reclaimLeases={},reclaimMemory={},nextReclaim=(brain:GetArmyIndex()-1)*.5,researchRetry={},raids={},repairs={},combatReads={},productionWaitAt=setmetatable({},{__mode='k'}),seed=1,phaseTrace=true},{__index=State})
    local seed=tonumber(ScenarioInfo.Options and(ScenarioInfo.Options.RandomSeed or ScenarioInfo.Options.Seed))
    if seed and seed>=1 and seed<2147483647 then self.seed=math.floor(seed)end
    self.faction=({'UEF','CYBRAN','ILLUMINATE'})[brain:GetFactionIndex()]
    self.catalogIds={};for id in pairs(self.catalog)do self.catalogIds[#self.catalogIds+1]=id end;table.sort(self.catalogIds)
    assert(#self.catalogIds>0,'No registered Reforged AI blueprint metadata')
    self.tasks=taskModule.Create(self.trace,self.army,self.tps);self.memory=knowledge.Create(map.width,map.height,profile.maxContacts)
    director.Initialize(self)
    return self
end
function Start(brain)
    if ScenarioInfo.Options.NoAI then return end
    if brain.ReforgedAIStarted then return end;brain.ReforgedAIStarted=true
    local reporter=trace(brain)
    reporter:Event(GetGameTick(),'controller-start',{level=brain.ReforgedAILevel,version='evidence-ai-5',gameplay=ruleset.ProfileId,gameplayPatch=ruleset.PatchId,gameplayVersion=ruleset.Version,
        perception='current-vision-and-frozen-memory',quoteSource='public-base-conservative',stockManager=false})
    brain:ForkThread(function()
        WaitTicks(1)
        reporter:Event(GetGameTick(),'controller-phase',{phase='create-controller'})
        local ok,state=pcall(Create,brain)
        if not ok then reporter:Event(GetGameTick(),'controller-error',{detail=tostring(state),cause='initialization'});return end
        brain.ReforgedAIController=state
        if not Validate(brain)then return end
        reporter:Event(GetGameTick(),'controller-phase',{phase='victory-conditions'})
        local ready,message=pcall(function()brain:SetVictoryCondition(ScenarioInfo.Options.Victory);brain:StartSkirmishConditions()end)
        if not ready then reporter:Event(GetGameTick(),'controller-error',{detail=tostring(message),cause='victory-conditions'});return end
        local failures=0
        while not brain:IsDefeated()do
            local good,message=pcall(state.Step,state)
            if not good then
                failures=failures+1
                log(state,'controller-error',{detail=tostring(message),phase=state.phase,consecutive=failures})
                if state.failedFairness then director.Stop(state);log(state,'controller-stop',{cause='fairness-readback-failed'});return end
                -- Do not silently abandon a living army. Retry a complete step
                -- from fresh own/perception data; do not resume mid-phase.
                local delay=math.min(10,state.profile.decisionSeconds*2^math.min(5,failures))
                log(state,'controller-retry',{phase=state.phase,delay=delay,consecutive=failures})
                WaitTicks(math.max(1,math.floor(delay*state.tps)))
            else
                if failures>0 then log(state,'controller-recovered',{afterFailures=failures})end
                failures=0
                WaitTicks(math.max(1,math.floor(state.profile.decisionSeconds*state.tps)))
            end
        end
        director.Stop(state)
        log(state,'controller-stop',{cause='army-defeated'})
    end)
end
