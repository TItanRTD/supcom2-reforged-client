-- Reforged 0.30.0 pure logistics policy; engine effects belong to the native adapter.
local function number(v)return type(v)=='number'and v==v and v>=0 and v<math.huge end
local function integer(v)return number(v)and v==math.floor(v)end
local function current(now,at)return number(at)and at<=now and now-at<=10 end
local function identity(v)return type(v)=='string'and #v>0 end
local function point(p)return type(p)=='table'and number(p[1])and type(p[2])=='number'and p[2]==p[2]and math.abs(p[2])<math.huge and number(p[3])end
local function route(site)return site.routeValidated==true and site.reachable==true end

-- netGainMass is the adapter's horizon-limited return after construction,
-- travel/opportunity and expected loss costs, not a hidden enemy-economy read.
-- A contested field is an army objective first. No engineer is assigned until
-- control is freshly revalidated. Unknown/stale fields require new scouting.
function ChooseFieldWork(context)
    if type(context)~='table'or not number(context.now)or type(context.sites)~='table'then return nil,'invalid-field-context'end
    if #context.sites>64 then return nil,'field-work-budget'end
    local choice,score,seen=nil,nil,{}
    for _,site in ipairs(context.sites)do
        if type(site)~='table'or not identity(site.id)or seen[site.id]then return nil,'invalid-field-site'end
        seen[site.id]=true
        if(site.kind=='reclaim'or site.kind=='expand')and point(site.position)and current(context.now,site.observedAt)
            and route(site)and site.reserved~=true and site.siteValidated==true and number(site.netGainMass)and site.netGainMass>0
            and number(site.travelSeconds)and number(site.workSeconds)and site.workSeconds>0 and site.retryAllowed==true then
            local action
            if site.kind=='reclaim'and number(site.reclaimableMass)and site.reclaimableMass>0 and site.netGainMass<=site.reclaimableMass then
                if site.control=='secure'then action='reclaim'
                elseif site.control=='contested'and site.forceReady==true then action='secure-wreckfield'end
            elseif site.kind=='expand'and site.control=='secure'and site.vacant==true and site.funded==true then action='expand'end
            if action then
                local value=site.netGainMass/(site.travelSeconds+site.workSeconds)
                if not score or value>score or(value==score and site.id<choice.site)then
                    choice={kind=action,site=site.id,position={site.position[1],site.position[2],site.position[3]},
                        assignEngineer=action~='secure-wreckfield',requiresRevalidation=true,
                        reason=action=='secure-wreckfield'and'contest-reclaim-with-forces-before-engineers'or'profitable-reachable-field-work'}
                    score=value
                end
            end
        end
    end
    if choice then return choice end
    return nil,'no-profitable-validated-field-work'
end

-- Only funded, safe, reachable unreserved backlog enters capacity estimates.
-- Workers are scoped to jobs they can reach; readyInSeconds includes their
-- current commitments. Submitted/queued engineers block another hire until
-- the native task owner reconciles completion, cancellation, death or timeout.
function ChooseEngineerProduction(context,catalog)
    if type(context)~='table'or type(catalog)~='table'or not number(context.now)or not number(context.horizonSeconds)or context.horizonSeconds<=0
        or not integer(context.capRemaining)or not number(context.massBudget)or not number(context.energyBudget)
        or type(context.jobs)~='table'or type(context.workers)~='table'or type(context.quotes)~='table'then
        return nil,'invalid-engineering-context'
    end
    if #context.jobs>64 or #context.workers>64 then return nil,'engineering-work-budget'end
    local horizon=context.horizonSeconds
    local work,gain,slots=0,0,0
    local jobIds,seen={},{}
    for _,job in ipairs(context.jobs)do
        if type(job)~='table'or not identity(job.id)or seen[job.id]then return nil,'invalid-engineering-job'end
        seen[job.id]=true
        if job.funded==true and job.safeForEngineer==true and job.siteValidated==true and route(job)
            and current(context.now,job.validatedAt)and integer(job.openSlots)and job.openSlots>0
            and number(job.workerSeconds)and job.workerSeconds>0 and number(job.netGainMass)and job.netGainMass>0 then
            local useful=math.min(job.workerSeconds,horizon*job.openSlots)
            work=work+useful;gain=gain+job.netGainMass;slots=slots+job.openSlots;jobIds[#jobIds+1]=job.id
        end
    end
    if work<=0 then return nil,'no-validated-engineering-backlog'end
    table.sort(jobIds)
    local capacity,workers=0,{}
    seen={}
    for _,worker in ipairs(context.workers)do
        if type(worker)~='table'or not identity(worker.id)or seen[worker.id]or not number(worker.readyInSeconds)
            or(worker.state~='idle'and worker.state~='busy'and worker.state~='queued'and worker.state~='submitted')then
            return nil,'invalid-engineering-worker'
        end
        seen[worker.id]=true
        if worker.state=='queued'or worker.state=='submitted'then return nil,'engineer-already-pending'end
        if worker.state=='idle'then return nil,'reuse-idle-engineer'end
        capacity=capacity+math.max(0,horizon-worker.readyInSeconds)
        workers[#workers+1]=worker
    end
    if context.capRemaining<1 then return nil,'unit-cap'end
    local deficit=work-capacity
    if deficit<=0 then return nil,'existing-engineer-capacity'end
    local choice,cost
    for id,q in pairs(context.quotes)do
        local unit=catalog[id]
        if unit and unit.roles.engineer and type(q)=='table'and q.legal==true and q.canBuild==true
            and number(q.mass)and number(q.energy)and number(q.buildSeconds)and number(q.deploymentSeconds)
            and q.mass<=context.massBudget and q.energy<=context.energyBudget then
            local arrival=q.buildSeconds+q.deploymentSeconds
            local ready=0;for _,worker in ipairs(workers)do if worker.readyInSeconds<=arrival then ready=ready+1 end end
            local available=math.max(0,horizon-arrival)
            local useful=math.min(deficit,available)
            -- Half a horizon's available work is initial utilization tuning,
            -- not a bonus or a measured optimal engineer ratio.
            if available>0 and ready<slots and useful>=available*.5 and gain*useful/work>q.mass then
                if not cost or q.mass<cost or(q.mass==cost and id<choice.blueprint)then
                    choice={kind='build-unit',blueprint=id,role='engineer',count=1,jobs=jobIds,
                        reason='profitable-backlog-after-owned-and-pending-capacity'};cost=q.mass
                end
            end
        end
    end
    if choice then return choice end
    return nil,'no-profitable-affordable-engineer'
end
