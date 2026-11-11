-- Engine-facing adapter for the persistent research plan and its paid builds.
local effective=import('/lua/sim/reforged_ai_effective.lua')
local frame=import('/lua/sim/reforged_ai_frame.lua')
local planning=import('/lua/sim/reforged_ai_planning.lua')
local doctrine=import('/lua/sim/reforged_ai_doctrine.lua')
local function isCombat(d)return d.mobile and not(d.roles.scout or d.roles.engineer or d.roles.commander or d.roles.reclaimer or d.flags.FIELDENGINEER)end
function Attach(State,h)
    function State:DoctrineContext()
        local e=planning.Evidence(self.contacts,self.catalog)
        local c={faction=self.faction,now=self.now,seed=self.seed,army=self.army,personality=self.personality,
            mass=self.mass,energy=self.energy,massIncome=self.massIncome,airPressure=e.air,groundPressure=e.ground,missilePressure=e.missile,
            emergency=self.plan and self.plan.emergency or false,commanderHealth=1,landMass=0,landFactories=0,megalithReady=0,
            exposedMexes=0,mexGroundThreat=0,mexAirThreat=0,radars=0,detonationTargets=0,structureDetonationTargets=0,intelNeeded=false}
        c.intelNeeded=self.now>60 and self:InformationNeed();c.safeWindow=self.plan and self.plan.deadline or 90;c.pointIncome=self.pointIncome or 0;c.airFactories=0;c.airMass=0;c.harvogMass=0
        for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog or self.catalog)
            if d and u:GetFractionComplete()>=1 then
                if d.roles.commander then c.commanderHealth=u:GetHealth()/math.max(1,u:GetMaxHealth());c.commanderFighting=self:BuilderInCombat(u);c.commanderForward=frame.Distance(u:GetPosition(),self.map.ownStart)>45 end
                if d.roles.factory and d.layer=='air'then c.airFactories=c.airFactories+1 end
                if d.layer=='air'and isCombat(d)then c.airMass=c.airMass+d.mass end
                if d.flags.ASSAULTBOT and d.faction=='ILLUMINATE'then c.harvogMass=c.harvogMass+d.mass end
                if d.roles.factory and d.layer=='land'and not d.roles.gantry then c.landFactories=c.landFactories+1 end
                if d.roles.radar then c.radars=c.radars+1 end
                if d.flags.MEGALITHII then c.megalithReady=c.megalithReady+1 end
                if d.layer=='land'and isCombat(d)and d.groundRange>0 then c.landMass=c.landMass+d.mass end
                if d.flags.MASSEXTRACTION then
                    if frame.Distance(u:GetPosition(),self.map.ownStart)>40 then c.exposedMexes=c.exposedMexes+1 end
                    for _,v in ipairs(self.contacts)do local enemy=self.catalog[v.blueprint]
                        if enemy and enemy.groundRange>0 and v.confidence>.5 and frame.Distance(u:GetPosition(),v.position)<enemy.groundRange+25 then
                            if enemy.layer=='air'then c.mexAirThreat=c.mexAirThreat+enemy.mass else c.mexGroundThreat=c.mexGroundThreat+enemy.mass end
                        end
                    end
                end
                if self.faction=='CYBRAN'and not d.flags.EXPERIMENTAL and u:GetHealth()/math.max(1,u:GetMaxHealth())<.4 then
                    for _,v in ipairs(self.contacts)do local enemy=self.catalog[v.blueprint]
                        if enemy and enemy.layer~='air'and v.current and v.channel=='vision'and v.age<=2 and frame.Distance(u:GetPosition(),v.position)<12 then
                            if d.structure then c.structureDetonationTargets=c.structureDetonationTargets+1
                            elseif isCombat(d)then c.detonationTargets=c.detonationTargets+1 end;break
                        end
                    end
                end
            end
        end
        return c
    end
    function State:SelectResearch(definitions)
        local c=self:DoctrineContext();local prior=self.doctrine
        self.doctrine=doctrine.Select(c,prior)
        if not prior then h.log(self,'research-strategy',{plan=self.doctrine.id,reason='persistent-faction-plan',evidence='own-state-and-active-tree'})end
        local goal,reason,nextId,kind,chain,wait=doctrine.ChooseResearch(self.doctrine,c,definitions,self.brain,self.researchRetry)
        -- Existing mod-specific salvage/Centurion choices remain available once
        -- the faction plan is complete; they cannot repeatedly divert it.
        if not goal and kind=='complete'and not c.emergency then
            local optional,why=self:OptionalResearch(definitions)
            if optional then
                goal=optional;reason=why;kind='side';chain=planning.ResearchPath(goal,definitions,self.brain)
                nextId,wait=planning.NextResearch(goal,definitions,self.brain,self.researchRetry,self.now,self.mass,self.energy)
            end
        end
        self.researchPayoff=goal and{goal=goal,forceMass=c.landMass+c.airMass,remainingPoints=chain and chain.points or 0,reserveMass=chain and chain.mass or 0,reserveEnergy=chain and chain.energy or 0,deadline=self.now+c.safeWindow,action=reason,release='capability-force-or-deadline-changes'}or nil
        self.doctrineGoal=goal;self.doctrineResearchKind=kind
        return goal,reason,nextId,wait or(nextId and'funded-earned-prerequisite'or reason),chain
    end
    function State:ResearchPurchased(kind,cost)doctrine.Purchased(self.doctrine,kind,cost)end
    function State:UnitCount(id,ready)
        local total=0
        for _,u in ipairs(self.own)do if string.lower(u:GetBlueprint().BlueprintId)==id and(not ready or u:GetFractionComplete()>=1)then total=total+1 end end
        return total+(ready and 0 or self.tasks:Pending(id))
    end
    function State:DeploymentTarget(defs)
        local best,score
        for _,id in ipairs(self.catalogIds)do local d=self.productionCatalog[id]
            if d.mobile and d.controlled and(d.flags.EXPERIMENTAL or d.id=='rfuc01')and self:UnitCount(id)<math.min(3,math.max(1,math.floor((self.massIncome or 0)/15)))then
                local unlocked=planning.BlueprintUnlock(d,defs,self.brain,true)or not planning.BlueprintUnlock(d,defs,self.brain,false)
                local compatible=false;local ready=false
                for _,u in ipairs(self.own)do local producer=frame.Describe(u,self.catalog)
                    if producer and producer.roles.producer and u:CanBuild(id)then compatible=true;ready=true;break end
                    if producer and(producer.roles.engineer or producer.roles.commander)then
                        for _,gid in ipairs(self.catalogIds)do local g=self.catalog[gid]
                            if g.roles.gantry and frame.Quote(u,g)then for _,rule in ipairs(g.buildable)do if planning.UnlockMatches(d,rule)then compatible=true;break end end end
                        end
                    end
                end
                if compatible and unlocked then
                    local preference=(ready and 3 or 1)+(self.plan and self.plan.factoryLayer==d.layer and 1 or 0)
                    if d.flags.SNEAKOTRON then preference=self:UnitCount('ucx0101',true)>0 and 4 or 0 end
                    if d.layer=='naval'and not(self.plan and self.plan.style=='naval')then preference=preference*.3 end
                    local value=preference/math.max(200,d.mass)
                    if preference>0 and(not score or value>score)then best=d;score=value end
                end
            end
        end
        return best,best and'funded-compatible-earned-experimental'or nil
    end
    function State:ReserveDeployment()
        self.deployment=nil;self.deploymentMass=0;self.deploymentEnergy=0;self.deploymentWait='no-outstanding-unlocked-target'
        local defs=import('/lua/sim/Research.lua').ResearchDefinitions
        local target,reason=self:DeploymentTarget(defs)
        if not target then return end
        if #self.own+self.tasks:PendingCount()>=(tonumber(ScenarioInfo.Options.UnitCap)or 1000)then self.deploymentWait='unit-cap';return end
        if self.plan and self.plan.emergency then self.deploymentWait='local-survival';return end
        local producer
        for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
            if d and d.roles.producer and u:GetFractionComplete()>=1 and u:CanBuild(target.id)then producer=u;break end
        end
        local project
        if producer then
            local q=frame.Quote(producer,target)
            -- Reserve toward ONE actual unlocked unit. Keep a working army/power
            -- budget, and discard the reservation when capability/producer is lost.
            project={kind='produce',unit=target,description=target,reason=reason,quote=q}
        else
            local compatiblePending=false
            for _,id in ipairs(self.catalogIds)do local g=self.catalog[id]
                if g.roles.gantry then for _,rule in ipairs(g.buildable)do if planning.UnlockMatches(target,rule)and self:UnitCount(id)>0 then compatiblePending=true end end end
            end
            if compatiblePending then self.deploymentWait='compatible-producer-under-construction-or-busy';return end
            for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
                if d and(d.roles.commander or d.roles.engineer)and not self:BuilderInCombat(u)
                    and frame.Ready(u)and not self.tasks:Busy(u,self.now)
                    and not(d.roles.engineer and self:Expand(u,false,true))then
                    local gantry,q=h.buildable(self,u,function(x)if not x.roles.gantry then return false end;for _,rule in ipairs(x.buildable)do if planning.UnlockMatches(target,rule)then return true end end;return false end)
                    if gantry and self.mass>=q.mass+math.min(target.mass,250)and self.energy>=q.energy+math.min(target.energy,700)then
                        local p=h.placement(self,u,gantry,u:GetPosition(),45,true)
                        if p then project={kind='build',actor=u,position=p,unit=target,description=gantry,quote=q,reason='gantry-for-'..reason};break end
                    end
                end
            end
        end
        if project then
            self.deployment=project
            local buffer=project.kind=='produce'and 160 or 0
            self.deploymentMass=math.min(project.quote.mass,math.max(0,self.mass-buffer))
            self.deploymentEnergy=math.min(project.quote.energy,math.max(0,self.energy-(buffer>0 and 300 or 0)))
            self.mass=self.mass-self.deploymentMass;self.energy=self.energy-self.deploymentEnergy
            self.deploymentWait='funded-or-saving-for-'..project.kind
        else self.deploymentWait='producer-under-construction-or-no-safe-builder'end
        if self.now-(self.lastDeploymentReport or-100)>=10 then
            self.lastDeploymentReport=self.now
            h.log(self,'deployment-plan',{unit=target.id,action=project and project.kind or'wait',reason=self.deploymentWait,reservedMass=self.deploymentMass,reservedEnergy=self.deploymentEnergy})
        end
    end
    function State:DeploymentBuild(actor)
        local p=self.deployment
        if not p or p.kind~='build'or p.actor~=actor then return false end
        self.mass=self.mass+self.deploymentMass;self.energy=self.energy+self.deploymentEnergy
        local ok=h.build(self,actor,p.description,p.position,p.reason)
        if ok then self.deploymentMass=0;self.deploymentEnergy=0;self.deployment=nil
        else self.mass=self.mass-self.deploymentMass;self.energy=self.energy-self.deploymentEnergy end
        return ok
    end
    function State:DeploymentProduction(factory)
        local p=self.deployment
        if not p or p.kind~='produce'then return false end
        local q=frame.Quote(factory,p.unit)
        if not q or q.mass>self.mass+self.deploymentMass or q.energy>self.energy+self.deploymentEnergy then return false end
        if h.submit(self,factory,'produce',p.unit.id,nil,p.reason,function()IssueBuildFactory({factory},p.unit.id,1)end)then
            self.mass=self.mass+self.deploymentMass-q.mass;self.energy=self.energy+self.deploymentEnergy-q.energy
            self.deploymentMass=0;self.deploymentEnergy=0;self.deployment=nil;return true,p.unit
        end
        return false
    end
    function State:CicadaSupport()
        self.cicadaHeld={};self.cloakAttempt=self.cloakAttempt or setmetatable({},{__mode='k'})
        for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
            if d and d.flags.SNEAKOTRON and u:GetFractionComplete()>=1 then
                local target,near
                for _,v in ipairs(self.own)do local vd=frame.Describe(v,self.catalog)
                    if vd and vd.flags.MEGALITHII and v:GetFractionComplete()>=1 then
                        local distance=frame.Distance(u:GetPosition(),v:GetPosition())
                        if not near or distance<near then target=v;near=distance end
                    end
                end
                if target then
                    self.cicadaHeld[u]=true
                    local radius=(u:GetBlueprint().Intel or{}).CloakFieldRadius or 0
                    if near>math.max(10,radius*.55)and not self.tasks:Busy(u,self.now)and h.path(self,u,target:GetPosition())==true then
                        h.submit(self,u,'move',nil,target:GetPosition(),'cicada-escorts-owned-megalith',function()IssueMove({u},target:GetPosition())end)
                    end
                    if radius>0 and near<=radius*.8 and self.energy>=500 and type(IssueAbility)=='function'
                        and type(u.IsUnitAbilityState)=='function'and not u:IsUnitAbilityState('StealthField','Activated')
                        and self.now-(self.cloakAttempt[u]or-100)>=15 and self.orders<self.profile.ordersPerSecond*self.profile.decisionSeconds then
                        IssueAbility({u},u:GetPosition(),'StealthField');self.orders=self.orders+1;self.cloakAttempt[u]=self.now
                        h.log(self,'ability-issued',{actor=tostring(u:GetEntityId()),ability='StealthField',reason='cloak-owned-megalith',evidence='submitted'})
                    end
                end
            end
        end
    end
end
