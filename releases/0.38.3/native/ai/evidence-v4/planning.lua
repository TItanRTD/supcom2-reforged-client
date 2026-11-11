-- Public research identifiers; prerequisites and prices always come from the
-- active base/DLC/mod research definitions. No direct unlocks or bonus points.
function Evidence(contacts,catalog)
    local e={air=0,ground=0,missile=0,defense=0,strategic=0,interception=0,redirection=0}
    for _,c in ipairs(contacts)do local d=catalog[c.blueprint]
        if d and not d.scriptManaged and c.confidence>.25 and not d.roles.scout and not d.roles.engineer then
            local value=math.max(1,d.mass)*c.confidence
            if d.mobile and d.layer=='air'and d.groundRange+d.airRange>0 then e.air=e.air+value end
            if d.mobile and d.layer=='land'and d.groundRange>0 then e.ground=e.ground+value end
            if(d.tacticalLaunchRange or 0)>0 then e.missile=e.missile+value end
            if(d.strategicLaunchRange or 0)>0 then e.strategic=e.strategic+value end
            if(d.tacticalInterceptRange or 0)>0 then e.interception=e.interception+value end
            if(d.redirectionRange or 0)>0 then e.redirection=e.redirection+value end
            if d.roles.defense then e.defense=e.defense+value end
        end
    end
    return e
end
function ResearchGoal(faction,contacts,catalog,brain,now,seed,definitions)
    local e=Evidence(contacts,catalog);local goals={}
    local function add(id,reason)goals[#goals+1]={id,reason}end
    if faction=='ILLUMINATE'then
        if e.air>=80 then add('ILP_ASSAULTBOTAA','observed-air-harvog-aa')end
        add('ILA_TELEPORT','land-mobility-bridges-flanks-and-escape')
        add('ILB_RANGE','land-engagement-range');add('ILB_TRAINING1','land-training')
    elseif faction=='CYBRAN'then
        if e.air>=80 or e.missile>=120 then add('CLU_ADV','observed-air-or-missiles-adaptor')end
        add('CLA_JUMPJETS','land-mobility')
        if e.defense>=250 then add('CLU_MISSILETRUCK','observed-fortification-siege')end
        -- Stable per-match branch, not a new random build every update.
        if seed%3==0 then add('CCP_NANOBOTWEAPON','commander-supported-deathball')
        elseif seed%3==1 then add('CLU_MEGALITHII','funded-experimental-finisher')
        else add('CLP_ENGINEERPD','forward-position-defense')end
        add('CLA_POWERDETONATE','close-contact-trade-tool');add('CLU_MEGALITHII','late-game-finisher')
    else
        if e.ground>=200 then add('ULU_ARTILLERY','observed-ground-mass-demolisher')end
        if e.air>=80 then add('ULP_AA','observed-air-land-aa')end
        if e.defense>=200 then add('ULU_ARTILLERY','observed-fortification-siege')end
        add('ULB_RANGE','land-engagement-range');add('ULP_SHIELDS','sustained-ground-pressure')
    end
    for _,g in ipairs(goals)do if(not definitions or definitions[g[1]])and not brain:HasResearched(g[1])then return g[1],g[2]end end
    return nil,'strategic-goals-complete'
end
local function cost(v)return type(v)=='number'and v==v and v>=0 and v<math.huge end
function ResearchPath(goal,definitions,brain)
    if not goal or not definitions[goal]then return nil,'goal-unavailable-in-active-tree'end
    local function solve(id,visiting)
        if brain:HasResearched(id)then return{nodes={},points=0,mass=0,energy=0}end
        if visiting[id]then return nil,'prerequisite-cycle'end
        local d=definitions[id]
        if not d or not cost(d.COST)or not cost(d.MASS or 0)or not cost(d.ENERGY or 0)or d.PREREQUISITES~=nil and type(d.PREREQUISITES)~='string'then return nil,'malformed-research-definition'end
        local path={};for k,v in pairs(visiting)do path[k]=v end;path[id]=true
        local parents={};for key in string.gmatch(d.PREREQUISITES or'','[%w_]+')do parents[#parents+1]=key end;table.sort(parents)
        local selected,why
        if #parents>0 then
            -- The active native comma list is an alternative gate. A custom
            -- publication uses that same native field; no retail graph is baked in.
            for _,parent in ipairs(parents)do
                local branch,message=solve(parent,path)
                if branch and(not selected or branch.points<selected.points or branch.points==selected.points and(branch.mass+branch.energy/10)<(selected.mass+selected.energy/10))then selected=branch end
                why=message or why
            end
            if not selected then return nil,why or'no-legal-prerequisite-branch'end
        else selected={nodes={},points=0,mass=0,energy=0}end
        selected.nodes[#selected.nodes+1]=id;selected.points=selected.points+d.COST;selected.mass=selected.mass+(d.MASS or 0);selected.energy=selected.energy+(d.ENERGY or 0)
        return selected
    end
    local result,why=solve(goal,{})
    return result,result and(#result.nodes==0 and'complete'or'valid-alternative-chain')or why
end
function NextResearch(goal,definitions,brain,retries,now,mass,energy)
    local chain,why=ResearchPath(goal,definitions,brain);if not chain then return nil,why end
    local id=chain.nodes[1];if not id then return nil,'complete'end
    local d=definitions[id]
    if(retries[id]or 0)>now then return nil,'retry-backoff'end
    local bank=brain:GetEconomyStored('RESEARCH')
    if not cost(bank)or d.COST>bank then return nil,'saving-for-next-prerequisite'end
    if not cost(mass)or not cost(energy)or(d.MASS or 0)>mass or(d.ENERGY or 0)>energy then return nil,'saving-resource-cost'end
    return id,'funded-earned-prerequisite'
end

-- Restriction-removal entries use exact blueprint IDs or category intersections.
-- Unsupported expressions fail closed; never treat a substring as an unlock.
function UnlockMatches(unit,entry)
    if type(entry)~='string'or not unit then return false end
    if string.lower(entry)==string.lower(unit.id)then return true end
    if string.find(entry,'[^%w_%s%-]')then return false end
    local positive=false
    for token in string.gmatch(entry,'%S+')do
        local exclude=string.sub(token,1,1)=='-';local key=exclude and string.sub(token,2)or token
        local matches=(unit.flags or{})[string.upper(key)]==true or string.lower(key)==string.lower(unit.id)
        if exclude and matches or not exclude and not matches then return false end
        if not exclude then positive=true end
    end
    return positive
end
function BlueprintUnlock(unit,definitions,brain,completed)
    local ids={};for id in pairs(definitions)do ids[#ids+1]=id end;table.sort(ids)
    local best,bestCost
    for _,id in ipairs(ids)do
        local entries=definitions[id].BuildRestrictionRemoval
        if type(entries)=='string'then entries={entries}end
        if type(entries)=='table'and brain:HasResearched(id)==completed then
            for _,entry in ipairs(entries)do if UnlockMatches(unit,entry)then
                local chain=ResearchPath(id,definitions,brain)
                if chain and(not bestCost or chain.points<bestCost)then best=id;bestCost=chain.points end
            end end
        end
    end
    return best
end

-- Optional unlock IDs are editable. Follow the ACTIVE publication's exact unit
-- restriction removal rather than assuming RF_* node names still exist.
function UnitUnlock(unit,definitions,brain,completed)
    local ids={};for id in pairs(definitions)do ids[#ids+1]=id end;table.sort(ids)
    for _,id in ipairs(ids)do
        local entries=definitions[id].BuildRestrictionRemoval
        if type(entries)=='string'then entries={entries}end
        if type(entries)=='table'and brain:HasResearched(id)==completed then
            for _,entry in ipairs(entries)do
                if type(entry)=='string'and string.lower(entry)==string.lower(unit)then return id end
            end
        end
    end
end
