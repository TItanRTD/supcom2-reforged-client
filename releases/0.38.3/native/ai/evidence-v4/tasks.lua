-- One outstanding task per actor. Native observations, not the return from an
-- Issue* call, establish progress. All clocks are synchronized game time.
local function distance(a,b)return math.sqrt((a[1]-b[1])^2+(a[3]-b[3])^2)end
function Create(trace,army,tps)
    local tasks,serial,claimed,cooldown,outcomes={},0,{},{},{}
    local state={};local replacements,pendingStops={},{}
    local budget=function()return true end
    function state:SetBudget(fn)budget=fn end
    function state:Clear(actor)
        local id=tostring(actor:GetEntityId())
        if not budget(1)then pendingStops[id]=actor;return false end
        IssueClearCommands({actor});pendingStops[id]=nil;return true
    end
    local function event(task,tick,kind,extra)
        local f={task=task.id,actor=task.actorId,kind=task.kind,blueprint=task.blueprint,reason=task.reason}
        for k,v in pairs(extra or{})do f[k]=v end
        trace:Event(tick,kind,f)
    end
    function state:Busy(actor,now)
        local id=tostring(actor:GetEntityId())
        return not replacements[id]and(tasks[id]~=nil or(cooldown[id]or 0)>now)
    end
    function state:Current(actor)
        local task=tasks[tostring(actor:GetEntityId())]
        if task and task.actor==actor then return{id=task.id,kind=task.kind,blueprint=task.blueprint,reason=task.reason,started=task.started,lastProgress=task.lastProgress,
            position=task.position and{task.position[1],task.position[2],task.position[3]}}end
    end
    function state:DrainOutcomes()
        local result=outcomes;outcomes={};return result
    end
    local function outcome(t,kind,now,extra)
        if t.kind=='build'and t.position then
            outcomes[#outcomes+1]={kind=kind,blueprint=t.blueprint,position={t.position[1],t.position[2],t.position[3]},
                actor=t.actorId,at=now,cause=extra and extra.cause,child=t.childId~=nil,approaching=t.approaching==true}
        end
    end
    function state:Pending(blueprint)
        local n=0;for _,t in pairs(tasks)do if(t.kind=='build'or t.kind=='produce')and t.blueprint==blueprint and not t.childId then n=n+1 end end;return n
    end
    -- Pending footprints exist before the engine materializes their children.
    function state:Sites()
        local out={};for _,t in pairs(tasks)do if t.kind=='build'and t.position then
            out[#out+1]={position=t.position,blueprint=t.blueprint}
        end end;return out
    end
    function state:Reserved()
        local mass,energy=0,0
        for _,t in pairs(tasks)do if not t.childId and t.reservation then mass=mass+t.reservation.mass;energy=energy+t.reservation.energy end end
        return mass,energy
    end
    function state:ActiveCount()local n=0;for _ in pairs(tasks)do n=n+1 end;return n end
    function state:PendingCount()
        local n=0;for _,t in pairs(tasks)do if(t.kind=='build'or t.kind=='produce')and not t.childId then n=n+1 end end;return n
    end
    function state:Submit(actor,kind,blueprint,position,reason,now,issue,observe,reservation)
        local actorId=tostring(actor:GetEntityId())
        local replacing=replacements[actorId]~=nil or pendingStops[actorId]~=nil
        if self:Busy(actor,now)and not replacing then return false end
        if not budget(replacing and 3 or 1,true)then return false end
        budget(replacing and 2 or 1)
        local prior=tasks[actorId]
        serial=serial+1
        local id=tostring(actor:GetEntityId())
        local t={id=tostring(army)..'-'..serial,actor=actor,actorId=id,kind=kind,blueprint=blueprint,
            position=position and{position[1],position[2],position[3]},reason=reason,started=now,lastProgress=now,
            fraction=0,baseline={},ack=false,observe=observe,reservation=reservation,issue=issue}
        if position then local origin=actor:GetPosition();t.distance=distance(origin,position);t.lastPosition={origin[1],origin[2],origin[3]}end
        if kind=='build'or kind=='produce'then
            for _,u in pairs(actor:GetAIBrain():GetListOfUnits(categories.ALLUNITS,false)or{})do
                local ok,key=pcall(function()if u and not u:IsDead()and u:GetArmy()==army then return tostring(u:GetEntityId())end end)
                if ok and key then t.baseline[key]=u end
            end
        end
        local tick=math.floor(now*tps+.5)
        event(t,tick,'task-planned',{x=position and position[1],z=position and position[3]})
        local ok,why=pcall(function()
            if replacing then IssueClearCommands({actor})end
            issue()
        end)
        if not ok then
            event(t,tick,'task-failed',{detail=tostring(why),cause='submission-error'})
            if replacing and prior and prior.issue then
                -- Restore executable work if the replacement adapter throws.
                budget(1);pcall(prior.issue)
            else cooldown[id]=now+10 end
            replacements[id]=nil;return false
        end
        if replacing and prior then event(prior,tick,'task-released',{cause=replacements[id]or'replacement-committed'})end
        replacements[id]=nil;pendingStops[id]=nil
        tasks[id]=t;cooldown[id]=now+.5
        event(t,tick,'order-issued',{evidence='submitted'})
        return true
    end
    function state:Step(now,own)
        -- Uncommitted replacement requests leave the previous order executable.
        replacements={}
        local stopIds={};for id in pairs(pendingStops)do stopIds[#stopIds+1]=id end;table.sort(stopIds)
        for _,id in ipairs(stopIds)do local actor=pendingStops[id];if actor:IsDead()then pendingStops[id]=nil else self:Clear(actor)end end
        local live={};for _,u in ipairs(own)do live[tostring(u:GetEntityId())]=u end
        for id in pairs(claimed)do if live[id]~=claimed[id].entity then claimed[id]=nil end end
        local ordered={};for id in pairs(tasks)do ordered[#ordered+1]=id end;table.sort(ordered)
        -- Observe every authoritative producer lineage before any proximity match.
        local authoritative={}
        for _,id in ipairs(ordered)do local t=tasks[id]
            if live[id]==t.actor and(t.kind=='build'or t.kind=='produce')then
                local ok,child=pcall(t.actor.GetUnitBeingBuilt,t.actor)
                if ok and child and not child:IsDead()and child:GetArmy()==army then authoritative[tostring(child:GetEntityId())]={entity=child,task=t.id}end
            end
        end
        local function done(t,kind,extra)
            event(t,math.floor(now*tps+.5),kind,extra);outcome(t,kind,now,extra);tasks[t.actorId]=nil
            -- Retain the claim while the produced OWN entity exists. Another
            -- outstanding factory must not claim the same finished child.
            if kind~='task-completed'and kind~='task-released'then cooldown[t.actorId]=now+10 end
        end
        for _,id in ipairs(ordered)do
            local t=tasks[id];local actor=t.actor
            local ok,why=pcall(function()
            if live[id]~=actor or actor:IsDead()or actor:GetArmy()~=army then done(t,'task-failed',{cause='actor-lost'})
            elseif(t.kind=='guard'or string.find(t.reason or'','commander-pressure',1,true))and now-t.started>=12 then
                done(t,'task-released',{cause='periodic-builder-work-review'});self:Clear(actor)
            elseif t.kind=='guard'then
                local status,detail=t.observe();if status=='failed'then done(t,'task-failed',detail);self:Clear(actor)
                elseif status=='released'then done(t,'task-released',detail);self:Clear(actor)
                elseif status=='progress'then t.lastProgress=now;if now-(t.lastReport or-100)>=5 then detail.evidence='observed';event(t,math.floor(now*tps+.5),'task-progress',detail);t.lastReport=now end end
            elseif t.kind=='build'or t.kind=='produce'then
                local child=t.child
                if not child then
                    local current=actor:GetUnitBeingBuilt()
                    if current and not current:IsDead()and current:GetArmy()==army then
                        local key=tostring(current:GetEntityId());local bp=current:GetBlueprint()
                        if string.lower(bp.BlueprintId or'')==t.blueprint and t.baseline[key]~=current and(not claimed[key]or claimed[key].entity~=current)then child=current end
                    end
                    -- Very fast builds can finish between samples. Match an
                    -- unclaimed new OWN entity at this builder/site, never a
                    -- global count that could belong to another factory.
                    if not child then
                        for _,u in ipairs(own)do
                            local key=tostring(u:GetEntityId())
                            if not u:IsDead()and t.baseline[key]~=u and(not authoritative[key]or authoritative[key].entity~=u or authoritative[key].task==t.id)and(not claimed[key]or claimed[key].entity~=u)
                                and string.lower(u:GetBlueprint().BlueprintId or'')==t.blueprint
                                and distance(u:GetPosition(),t.position or actor:GetPosition())<=(t.kind=='build'and 4 or 16)then child=u;break end
                        end
                    end
                    if child then t.child=child;t.childId=tostring(child:GetEntityId());claimed[t.childId]={entity=child,task=t.id} end
                end
                if child then
                    if live[t.childId]~=child or child:IsDead()or child:GetArmy()~=army then done(t,'task-failed',{cause='construction-lost'})
                    else
                        local f=child:GetFractionComplete()
                        if f>=1 then done(t,'task-completed',{evidence='observed',entity=t.childId,fraction=f})
                        elseif not t.ack or f>t.fraction+.02 then
                            t.ack=true;t.fraction=f;t.lastProgress=now
                            if now-(t.lastReport or-100)>=5 then event(t,math.floor(now*tps+.5),'task-progress',{evidence='observed',entity=t.childId,fraction=f});t.lastReport=now end
                        end
                    end
                end
                -- Ordinary build commands path to construction range themselves. Moving
                -- toward the site is real progress, but an ignored order at the
                -- site should release its reservation promptly.
                if tasks[id]and not child and t.position then
                    local d=distance(actor:GetPosition(),t.position)
                    local position=actor:GetPosition()
                    if d<t.distance-1 or distance(position,t.lastPosition)>2 then
                        t.distance=d;t.lastPosition={position[1],position[2],position[3]};t.lastProgress=now;t.approaching=true
                    end
                end
                local timeout=child and 45 or 12
                if tasks[id]and now-t.lastProgress>timeout then
                    done(t,'task-stalled',{cause=t.child and'construction-not-advancing'or'no-construction-observed'})
                    self:Clear(actor)
                end
            elseif t.kind=='reclaim'or t.kind=='repair'then
                local status,detail
                if t.observe then status,detail=t.observe()end
                if status=='failed'or status=='released'then done(t,status=='released'and'task-released'or'task-failed',detail);self:Clear(actor)
                elseif status=='completed'then detail=detail or{};detail.evidence='observed';done(t,'task-completed',detail)
                elseif status=='progress'then
                    t.lastProgress=now
                    if now-(t.lastReport or-100)>=5 then detail=detail or{};detail.evidence='observed';event(t,math.floor(now*tps+.5),'task-progress',detail);t.lastReport=now end
                else
                    local d=distance(actor:GetPosition(),t.position)
                    if d<t.distance-3 then t.distance=d;t.lastProgress=now end
                    if now-t.lastProgress>30 then done(t,'task-stalled',{cause='no-observed-work-progress'});self:Clear(actor)end
                end
            elseif t.kind=='attack'then
                local status,detail=t.observe()
                if status=='completed'then detail=detail or{};detail.evidence='observed';done(t,'task-completed',detail)
                elseif status=='released'then done(t,'task-released',detail);self:Clear(actor)
                else
                    if status=='lost'then t.lostSince=t.lostSince or now else t.lostSince=nil end
                    if status=='progress'then
                        t.lastProgress=now
                        if now-(t.lastReport or-100)>=5 then detail.evidence='observed';event(t,math.floor(now*tps+.5),'task-progress',detail);t.lastReport=now end
                    end
                    local d=distance(actor:GetPosition(),t.position)
                    if d<t.distance-3 then t.distance=d;t.lastProgress=now end
                    if t.lostSince and now-t.lostSince>=5 then
                        done(t,'task-released',{cause='target-vision-lost-replan'});self:Clear(actor)
                    elseif now-t.lastProgress>120 then
                        done(t,'task-stalled',{cause='no-observed-engagement-progress',distance=d});self:Clear(actor)
                    end
                end
            else
                local d=distance(actor:GetPosition(),t.position)
                if d<=6 then done(t,'task-completed',{evidence='observed',cause='reached-objective',distance=d})
                elseif d<t.distance-3 then
                    t.distance=d;t.lastProgress=now
                    if now-(t.lastReport or-100)>=10 then event(t,math.floor(now*tps+.5),'task-progress',{evidence='observed',distance=d});t.lastReport=now end
                elseif now-t.lastProgress>(t.kind=='advance'and 120 or 30)then
                    done(t,'task-stalled',{cause='movement-not-advancing',distance=d});self:Clear(actor)
                end
            end
            end)
            if not ok then
                -- An owned handle may expire between observation and use. Drop
                -- only its task, release the reservation and continue the army.
                if tasks[id]then done(t,'task-failed',{cause='task-observation-error',detail=tostring(why)})end
                if live[id]==actor then pcall(function()if not actor:IsDead()then self:Clear(actor)end end)end
            end
        end
        for id,untilTime in pairs(cooldown)do if now>=untilTime and not tasks[id]then cooldown[id]=nil end end
    end
    function state:Cancel(actor,now,reason)
        -- Intent only: Submit commits clear+replacement together after budget
        -- admission, bypassing the recent-command cooldown. No clear-only gap.
        replacements[tostring(actor:GetEntityId())]=reason or 'replacement-requested'
    end
    function state:Replace(actor,kind,blueprint,position,reason,now,issue,observe,reservation)
        local id=tostring(actor:GetEntityId());local previous=replacements[id]
        replacements[id]=reason
        local ok=self:Submit(actor,kind,blueprint,position,reason,now,issue,observe,reservation)
        if not ok then replacements[id]=previous end
        return ok
    end
    function state:ReplaceGroup(actors,position,reason,now,issue)
        if #actors<1 or #actors>12 or not budget(#actors+2,true)then return false end
        local previous={}
        for _,actor in ipairs(actors)do local id=tostring(actor:GetEntityId());if actor:IsDead()or actor:GetArmy()~=army then return false end;previous[id]=tasks[id]end
        budget(2)
        local ok=pcall(function()IssueClearCommands(actors);issue(actors,position)end)
        if not ok then
            for _,actor in ipairs(actors)do local t=previous[tostring(actor:GetEntityId())];if t and t.issue then budget(1);pcall(t.issue)end end
            return false
        end
        for _,actor in ipairs(actors)do
            local id=tostring(actor:GetEntityId());local prior=previous[id]
            if prior then event(prior,math.floor(now*tps+.5),'task-released',{cause=reason})end
            serial=serial+1;local p=actor:GetPosition()
            local t={id=tostring(army)..'-'..serial,actor=actor,actorId=id,kind='move',position={position[1],position[2],position[3]},reason=reason,started=now,lastProgress=now,
                distance=distance(p,position),issue=function()issue({actor},position)end}
            tasks[id]=t;cooldown[id]=now+.5;replacements[id]=nil;pendingStops[id]=nil
            event(t,math.floor(now*tps+.5),'order-issued',{evidence='submitted',affectedUnits=#actors,group=true})
        end
        return true
    end
    function state:Stop(actor,now,reason)
        local id=tostring(actor:GetEntityId());local t=tasks[id]
        if not self:Clear(actor)then return false end
        if t then event(t,math.floor(now*tps+.5),'task-released',{cause=reason});outcome(t,'task-released',now,{cause=reason});tasks[id]=nil end
        cooldown[id]=now+.5;return true
    end
    return state
end
