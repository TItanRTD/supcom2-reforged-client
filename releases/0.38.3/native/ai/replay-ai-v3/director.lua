-- Operational strategy adapter. All strategic evidence comes from own units,
-- public terrain/markers, vision-gated contacts, or explicit allied declarations.
local frame=import('/lua/sim/reforged_ai_frame.lua')
local planning=import('/lua/sim/reforged_ai_planning.lua')
local adaptive=import('/lua/sim/reforged_ai_adaptive.lua')
local topology=import('/lua/sim/reforged_ai_topology.lua')
local team=import('/lua/sim/reforged_ai_teamplay.lua')
function Initialize(self)
    self.topology=topology.Create(self.map,function(x,z)return GetTerrainHeight(x,z),GetSurfaceHeight(x,z)end)
    self.personality=adaptive.Personality(self.brain.ReforgedAIPersonality,self.seed,self.army)
    self.teamAssigned={};self.teamTasks={};self.teamKnown={};self.researchSpent=0
end
function Stop(self)team.Remove(self.army,self.now or 0)end
function Attach(State,h)
    function State:FighterCover(position,seconds)
        local fighters={}
        for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog or self.catalog)
            if d and d.layer=='air'and d.mobile then fighters[#fighters+1]={complete=u:GetFractionComplete()>=1,
                airRange=d.airRange,speed=d.speed,health=u:GetHealth()/math.max(1,u:GetMaxHealth()),position=u:GetPosition(),mass=d.mass}end
        end
        return adaptive.ReadyCover(fighters,position,seconds or 15)
    end
    function State:ReviewStrategy()
        self.topology:Step(64)
        -- Survival is checked every decision; a calm strategic review is 5 s.
        local homeThreat=0
        for _,c in ipairs(self.contacts)do local d=self.catalog[c.blueprint]
            -- Known pure interceptors cannot damage the ground economy. Keep
            -- them in air-demand evidence, not the ground-survival alarm.
            if d and d.groundRange>0 and frame.Distance(c.position,self.map.ownStart)<=65+d.groundRange then
                homeThreat=homeThreat+math.max(20,d.mass)*c.confidence
            elseif not d and c.channel=='radar'and frame.Distance(c.position,self.map.ownStart)<=85 then
                homeThreat=homeThreat+80*c.confidence
            end
        end
        if self.plan and self.now-(self.lastStrategy or -100)<5 and homeThreat==(self.strategyHomeThreat or 0)then return end
        self.lastStrategy=self.now;self.strategyHomeThreat=homeThreat
        local own={ground=0,homeGround=0,homeDefense=0,commanderHealth=1};local legal={};local factories={land=0,air=0,naval=0}
        local experimental=false;local minSpeed=math.huge;local support=0;local navalActor;local committed={land=0,air=0,naval=0}
        for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog or self.catalog)
            if d then
                if d.roles.factory then
                    legal[d.layer]=true;factories[d.layer]=factories[d.layer]+(u:GetFractionComplete()>=1 and 1 or 0)
                    if u:GetFractionComplete()<1 then committed[d.layer]=committed[d.layer]+d.mass end
                end
                if u:GetFractionComplete()>=1 then
                    local health=math.max(0,math.min(1,u:GetHealth()/math.max(1,u:GetMaxHealth())))
                    if d.roles.commander then own.commanderHealth=u:GetHealth()/math.max(1,u:GetMaxHealth())end
                    if d.groundRange>0 and frame.Distance(u:GetPosition(),self.map.ownStart)<=85 then own.homeDefense=own.homeDefense+d.mass*health end
                    if d.mobile and not d.roles.commander and not d.roles.engineer and not d.roles.reclaimer then
                        if d.layer=='land'and d.groundRange>0 then
                            own.ground=own.ground+d.mass*health
                            minSpeed=math.min(minSpeed,math.max(.1,d.speed))
                            if frame.Distance(u:GetPosition(),self.map.ownStart)<=75 then own.homeGround=own.homeGround+d.mass*health end
                        end
                        if d.roles.support then support=support+d.mass end
                        if d.layer=='naval'then navalActor=navalActor or u end
                        if d.flags.EXPERIMENTAL and d.groundRange>0 then experimental=true end
                    end
                    if d.roles.commander or d.roles.engineer then
                        for _,id in ipairs(self.catalogIds)do local x=self.catalog[id]
                            if x.roles.factory and not x.roles.gantry and x.faction==self.faction and not legal[x.layer]and frame.Quote(u,x)then legal[x.layer]=true end
                        end
                    end
                end
            end
        end
        for _,id in ipairs(self.catalogIds)do local d=self.catalog[id]
            if d.roles.factory then committed[d.layer]=committed[d.layer]+self.tasks:Pending(id)*d.mass end
        end
        local speed=minSpeed<math.huge and minSpeed or 3
        local terrain=self.topology:Summary(self.map,speed)or{chokes=0,flanks=0,waterFraction=0,revision=0}
        -- Missing public starts are unknown, not proof that land is disconnected.
        -- Retain the already selected opening family until better evidence exists.
        local landReach=#self.map.candidateStarts==0 and self.opening and self.opening.style~='air_control';local nearest
        for _,s in ipairs(self.map.candidateStarts)do
            if s.land and s.land.reachable then landReach=true;nearest=math.min(nearest or math.huge,frame.Distance(self.map.ownStart,s.position)/speed)end
        end
        terrain.airAdvantage=(terrain.travelSeconds or nearest)and math.min(1,(terrain.travelSeconds or nearest)/180)or 0
        terrain.travelSeconds=terrain.travelSeconds or nearest or 180
        local enemy=planning.Evidence(self.contacts,self.catalog);enemy.home=homeThreat
        local window=math.max(60,math.min(180,nearest or 90));local fresh=0;local navalReach=false
        for _,c in ipairs(self.contacts)do local d=self.catalog[c.blueprint]
            if c.current then fresh=fresh+1 end
            if d and d.mobile and not d.roles.scout and d.groundRange>0 and c.confidence>.4 then
                -- Old contacts may have advanced: subtract their unobserved travel.
                local eta=math.max(0,(frame.Distance(c.position,self.map.ownStart)-65-d.groundRange)/math.max(.1,d.speed)-(c.age or 0))
                window=math.min(window,eta)
            end
            if d and d.layer=='naval'and navalActor and c.confidence>.5 and h.path(self,navalActor,c.position)==true then navalReach=true end
        end
        local mexes=0
        for _,m in ipairs(self.map.massSites)do
            if not h.occupied(self,m.position)and not self.siteLeases[m.id]and h.threat(self,m.position,35)==0
                and(not m.engineer or m.engineer.reachable)and(frame.Distance(m.position,self.map.ownStart)<=80 or self.scouted[m.id]and self.now-self.scouted[m.id]<60)then mexes=mexes+1 end
        end
        local salvage=0;for _,r in pairs(self.reclaimMemory)do if self.now-r.lastSeen<=20 then salvage=salvage+r.mass end end
        local points=self.brain:GetEconomyStored('RESEARCH')+(self.researchSpent or 0)
        if self.pointsAt and self.now>self.pointsAt then
            local earned=math.max(0,(points-self.pointsLast)/(self.now-self.pointsAt))
            self.pointIncome=(self.pointIncome or earned)*.5+earned*.5
        end
        self.pointsAt=self.now;self.pointsLast=points
        local defs=import('/lua/sim/Research.lua').ResearchDefinitions
        local goal=self:SelectResearch(defs)
        local eta,rm,re=adaptive.ResearchETA(goal,defs,self.brain,self.pointIncome or 0)
        if rm and(rm>self.mass or re>self.energy)then eta=nil end
        local allies=team.Allies(self.army,self.now,IsAlly);local known={};local lost=false
        for _,a in ipairs(allies)do known[a.army]=true end
        for id in pairs(self.teamKnown)do if not known[id]then lost=true end end
        self.teamKnown=known;self.allies=allies
        local declaration={home=self.map.ownStart,readyGround=own.ground,readyAir=self:FighterCover(self.map.ownStart,15),
            readySupport=support,homeGround=own.homeGround,airFactories=factories.air,groundSpeed=speed,declined=self.teamDeclined}
        local role=team.Role(self.army,declaration,allies)
        local switching={air_control=factories.air>0 and 0 or 200+committed.land,land_pressure=factories.land>0 and 0 or 200+committed.air}
        local old=self.plan
        self.plan=adaptive.Choose({now=self.now,own=own,enemy=enemy,map=terrain,personality=self.personality,seed=self.seed,army=self.army,
            landLegal=legal.land,airLegal=legal.air,navalLegal=legal.naval,landReach=landReach,navalReach=navalReach,
            safeWindow=window,uncertainty=fresh>0 and .25 or .75,safeMexes=mexes,energySurplus=self.energySpare,
            mass=self.mass,energy=self.energy,reclaimMass=salvage,researchGoal=goal,researchETA=eta,
            experimentalReady=experimental,teamRole=role,allyLost=lost,switchCosts=switching},old)
        self.teamRole=role;declaration.emergency=self.plan.emergency;declaration.style=self.plan.style
        if self.plan.emergency then
            if not self.teamRequest or self.teamRequest.deadline<=self.now then self.teamRequest=team.Request(self.army,self.map.ownStart,math.max(100,homeThreat-own.homeDefense),self.now)end
            self.teamRequest.expires=self.now+8
        else self.teamRequest=nil end
        declaration.request=self.teamRequest;declaration.commitment=self.teamCommitment;self.teamDeclaration=declaration
        team.Publish(self.army,declaration,self.now)
        if not old or old.style~=self.plan.style or old.emergency~=self.plan.emergency or self.now-(self.strategyReport or -100)>=20 then
            self.strategyReport=self.now
            h.log(self,'strategy-review',{style=self.plan.style,reason=self.plan.reason,emergency=self.plan.emergency,personality=self.personality,
                teamRole=role,travelSeconds=terrain.travelSeconds,chokes=terrain.chokes,flanks=terrain.flanks,terrainRevision=terrain.revision,
                safeWindow=window,researchETA=eta or -1,safeMexes=mexes,spendableMass=self.mass,readyGround=own.ground,homeThreat=homeThreat,allyCoverageLost=lost})
        end
    end
    function State:TeamWork()
        if not self.teamDeclaration then return end
        local allies=team.Allies(self.army,self.now,IsAlly);local c=self.teamCommitment;local live={}
        for _,u in ipairs(self.own)do live[tostring(u:GetEntityId())]=u end
        if c then
            local valid=team.Valid(c,allies,self.now)and not self.plan.emergency
            local capacity=0
            for _,id in ipairs(c.unitIds)do local u=live[id];local d=u and frame.Describe(u,self.productionCatalog)
                local task=u and self.tasks:Current(u)
                if u and d and u:GetFractionComplete()>=1 and u:GetHealth()>=u:GetMaxHealth()*.5 and
                    (not task or task.id==self.teamTasks[id])then capacity=capacity+d.mass end
            end
            valid=valid and capacity>=c.needed
            if not valid then
                for _,id in ipairs(c.unitIds)do local u=live[id];local task=u and self.tasks:Current(u)
                    if task and task.id==self.teamTasks[id]then self.tasks:Cancel(u,self.now,'team-commitment-ended')end
                end
                h.log(self,'team-abort',{plan=c.plan,reason=self.plan.emergency and'local-survival'or'expired-lost-or-insufficient-ready-help'})
                self.teamAssigned={};self.teamTasks={};self.teamCommitment=nil;c=nil
            end
        end
        if not c then
            local request=team.SelectRequest(self.army,self.teamDeclaration,allies,self.now)
            if request then
                local units={};local deferred=false
                for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
                    if d and d.mobile and d.layer=='land'and d.groundRange>0 and not d.roles.commander and not d.roles.engineer and not d.roles.reclaimer and
                        u:GetFractionComplete()>=1 and not self.tasks:Busy(u,self.now)then
                        local route=self.topology:Route(u:GetPosition(),request.position,'land')
                        local distance=route and route.length or frame.Distance(u:GetPosition(),request.position)*1.5
                        if distance/math.max(.1,d.speed)<=request.deadline-self.now then
                            local reachable=h.path(self,u,request.position);if reachable==nil then deferred=true end
                            units[#units+1]={id=tostring(u:GetEntityId()),complete=true,free=true,reachable=reachable==true,
                                arrival=distance/math.max(.1,d.speed),health=u:GetHealth()/math.max(1,u:GetMaxHealth()),mass=d.mass}
                        end
                    end
                end
                c=team.Commitment(request,self.army,units,self.now)
                if c then
                    c.needed=request.needed;self.teamCommitment=c;self.teamDeclined=nil
                    for _,id in ipairs(c.unitIds)do self.teamAssigned[id]=true end
                    h.log(self,'team-acknowledged',{plan=c.plan,owner=c.owner,mass=c.mass,units=#c.unitIds,deadline=c.deadline})
                elseif not deferred then self.teamDeclined=request.id end
            end
        end
        if c then
            local arrived=0;local issued=0
            for _,id in ipairs(c.unitIds)do local u=live[id]
                if u then
                    local d=frame.Describe(u,self.productionCatalog)
                    if frame.Distance(u:GetPosition(),c.position)<=18 then arrived=arrived+d.mass
                    elseif not self.tasks:Busy(u,self.now)then
                        if h.submit(self,u,'advance',nil,c.position,'defend-allied-request',function()IssueAggressiveMove({u},c.position)end)then
                            self.teamTasks[id]=self.tasks:Current(u).id;issued=issued+1
                        end
                    end
                end
            end
            local status=arrived>=c.needed and'ready'or next(self.teamTasks)and'executing'or'acknowledged'
            if status~=c.state then c.state=status;h.log(self,'team-status',{plan=c.plan,state=status,arrivedMass=arrived,orders=issued})end
            -- Renew only while the owner still requests help and own units exist.
            c.expires=math.min(c.deadline,self.now+5)
        end
        self.teamDeclaration.commitment=c;self.teamDeclaration.declined=self.teamDeclined
        team.Publish(self.army,self.teamDeclaration,self.now)
    end
end
