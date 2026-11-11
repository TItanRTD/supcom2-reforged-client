-- Race for unopposed public deposits using own anchors and observed threats.
-- No enemy absence is inferred from fog. Native paths/placement own legality.
local frame=import('/lua/sim/reforged_ai_frame.lua')
local function distance(a,b)return frame.Distance(a,b)end
function Attach(State,h)
    function State:ExpansionSites(center,commander,coreOnly)
        local sites={};local emergency=self.plan and self.plan.emergency
        if self.expansionMarkerList~=self.map.massSites then
            self.expansionMarkerList=self.map.massSites;self.expansionNeighbors={}
            for _,a in ipairs(self.map.massSites)do local n=0
                for _,b in ipairs(self.map.massSites)do if a~=b and distance(a.position,b.position)<=30 then n=n+1 end end
                self.expansionNeighbors[a.id]=math.min(3,n)
            end
        end
        for _,m in ipairs(self.map.massSites)do
            local home=distance(self.map.ownStart,m.position)
            local seen=self.scouted[m.id]and self.now-self.scouted[m.id]<=60
            local frontier=home<=110
            -- Do not wait many minutes for the frontier radius to grow. A
            -- completed mex immediately opens the next nearby resource cluster.
            for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
                if d and d.flags.MASSEXTRACTION and u:GetFractionComplete()>=1 and distance(u:GetPosition(),m.position)<=140 then frontier=true;break end
            end
            local enemyOwned=false
            for _,c in ipairs(self.contacts)do local d=self.catalog[c.blueprint]
                if d and d.structure and c.confidence>.25 and distance(c.position,m.position)<8 then enemyOwned=true;break end
            end
            if (not(coreOnly or commander)or home<=80)and(not emergency or home<=55)
                and(frontier or seen)and not enemyOwned and not h.occupied(self,m.position)and not self.siteLeases[m.id]
                and(self.siteRetry[m.id]or 0)<=self.now and h.threat(self,m.position,35)==0 then
                -- Prefer saturating a nearby cluster, while keeping the first
                -- core deposits ahead of long travel. Leases exclude duplicates.
                local score=distance(center,m.position)+home*.08-self.expansionNeighbors[m.id]*8-(home<=55 and 120 or 0)
                sites[#sites+1]={site=m,score=score,home=home}
            end
        end
        table.sort(sites,function(a,b)return a.score<b.score or a.score==b.score and a.site.id<b.site.id end)
        return sites
    end
    function State:ExpansionRouteSafe(actor,position)
        -- A native reachable endpoint alone does not make a known enemy line
        -- safe. Reject observed threat on the direct travel corridor as well.
        local origin=actor:GetPosition();local dx,dz=position[1]-origin[1],position[3]-origin[3];local length=dx*dx+dz*dz
        for _,c in ipairs(self.contacts)do local d=self.catalog[c.blueprint]
            local range=d and d.groundRange>0 and d.groundRange+12 or not d and c.channel=='radar'and 32 or 0
            if range>0 and c.confidence>.25 then
                local t=length>0 and math.max(0,math.min(1,((c.position[1]-origin[1])*dx+(c.position[3]-origin[3])*dz)/length))or 0
                local x,z=c.position[1]-origin[1]-dx*t,c.position[3]-origin[3]-dz*t
                if x*x+z*z<=range*range then return false end
            end
        end
        return true
    end
    function State:Expand(actor,coreOnly,preview)
        local mex,q=h.buildable(self,actor,function(d)return d.flags.MASSEXTRACTION==true end)
        if not h.canSpend(self,q)then self.expansionWait=(self.powerEnergy or 0)>0 and'energy-reserved-for-power'or'saving-for-mex-or-no-legal-blueprint';return false end
        local description=frame.Describe(actor,self.catalog)
        local sites=self:ExpansionSites(actor:GetPosition(),description.roles.commander,coreOnly)
        local attempts=0
        for _,row in ipairs(sites)do local site=row.site
            if h.siteLegal(self,mex,site.position)and self:ExpansionRouteSafe(actor,site.position)then
                attempts=attempts+1
                local reachable=h.path(self,actor,site.position)
                if reachable==nil then self.expansionWait='path-budget-deferred';return false end
                if reachable then
                    if preview then return true end
                    if h.build(self,actor,mex,site.position,'claim-unopposed-mex-cluster-early')then
                        self.siteLeases[site.id]={actor=actor,untilTime=self.now+120}
                        self.expansionWait='issued-early-cluster-expansion';return true
                    end
                    self.siteRetry[site.id]=self.now+12
                else self.siteRetry[site.id]=self.now+60 end
                if attempts>=4 then break end
            end
        end
        self.expansionWait=#sites>0 and'no-safe-reachable-legal-expansion'or'no-unleased-safe-frontier-marker'
        return false
    end
    function State:ExpansionWorker(factory,quotes,cap)
        if self.now<10 or cap<1 or self.plan and self.plan.emergency or h.threat(self,factory:GetPosition(),35)>0 then return end
        local engineer,q
        for _,id in ipairs(self.catalogIds)do local d=self.catalog[id];local quote=quotes[id]
            if d.roles.engineer and d.faction==self.faction and quote and quote.legal==true and quote.canBuild==true
                and(not q or quote.mass<q.mass)then engineer=d;q=quote end
        end
        if not engineer then return end
        local workers=0;local probe
        for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog)
            if d and d.roles.engineer then
                workers=workers+1
                if u:GetFractionComplete()<1 then return end
                local task=self.tasks:Current(u)
                -- Redirect the current engineer before paying for another one.
                if not task or task.kind=='guard'then return end
                if d.id==engineer.id and h.threat(self,u:GetPosition(),20)==0 then probe=probe or u end
            end
        end
        for _,id in ipairs(self.catalogIds)do if self.catalog[id].roles.engineer and self.tasks:Pending(id)>0 then return end end
        local limit=({easy=2,normal=3,hard=4,reforger=4})[self.profile.level]or 3
        if workers>=limit then return end
        -- Additional workers require a real same-blueprint engineer's routes.
        -- The first worker can be funded for visible local work, without using
        -- an ACU's different movement rules as proof that an engineer can walk.
        if workers>0 and(not probe or h.path(self,probe,factory:GetPosition())~=true)then return end
        local mex
        for _,id in ipairs(self.catalogIds)do local d=self.catalog[id]
            if d.faction==self.faction and d.flags.MASSEXTRACTION and(not mex or d.mass<mex.mass)then mex=d end
        end
        if not mex then return end
        local funded=math.min(math.floor((self.mass-q.mass-100)/math.max(1,mex.mass)),math.floor((self.energy-q.energy-200)/math.max(1,mex.energy)))
        local wanted=workers==0 and 2 or math.max(3,workers*2)
        if funded<wanted then return end
        local reclaim=import('/lua/sim/reforged_reclaim.lua');local coverage=reclaim.Coverage(self.army)
        local jobs=0;local routes=0
        for _,row in ipairs(self:ExpansionSites(factory:GetPosition(),false,false))do local m=row.site
            if distance(factory:GetPosition(),m.position)<=180 and reclaim.Visible(m.position,coverage)
                and h.siteLegal(self,mex,m.position)then
                local reachable=false
                if workers==0 then reachable=distance(factory:GetPosition(),m.position)<=110
                elseif self:ExpansionRouteSafe(probe,m.position)then
                    routes=routes+1;reachable=h.path(self,probe,m.position)
                    if reachable==nil then break end
                end
                if reachable then jobs=jobs+1 end
                if jobs>=wanted or routes>=4 then break end
            end
        end
        if jobs>=wanted then return{blueprint=engineer.id,role='engineer',reason='early-worker-for-funded-unopposed-mex-clusters'}end
    end
end
