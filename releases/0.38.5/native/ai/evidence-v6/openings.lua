-- Reforged 0.30.0 pure openings policy; engine effects belong to the native adapter.
local styles={'land_pressure','air_control','expansion','defensive','naval'}
local styleSet={}for _,style in ipairs(styles)do styleSet[style]=true end
local function number(v)return type(v)=='number'and v==v and v>=0 and v<math.huge end
local function integer(v)return number(v)and v==math.floor(v)end
local function id(v)return type(v)=='string'and #v>0 and #v<=128 end
local function point(p,w,h)
    return type(p)=='table'and number(p[1])and p[1]<=w and number(p[3])and p[3]<=h
end
local function route(r)
    return type(r)=='table'and r.validated==true and type(r.reachable)=='boolean'
        and(not r.reachable or(number(r.seconds)and r.seconds>0))
end

function AnalyzeOpeningMap(map)
    if type(map)~='table'or not id(map.key)or not number(map.width)or map.width<=0 or map.width>16384
        or not number(map.height)or map.height<=0 or map.height>16384 or not point(map.ownStart,map.width,map.height)
        or type(map.candidateStarts)~='table'or #map.candidateStarts<1 or #map.candidateStarts>8
        or type(map.massSites)~='table'or #map.massSites>256 or type(map.terrain)~='table'then
        return nil,'invalid-public-map'
    end
    local t=map.terrain
    if t.validated~=true or not integer(t.chokes)or t.chokes>32 or not integer(t.flanks)or t.flanks>32
        or not number(t.waterFraction)or t.waterFraction>1 or type(t.navalBuildSiteValidated)~='boolean'then
        return nil,'unverified-terrain'
    end
    local land,air,naval,advantage,minTravel,minLandTravel=0,0,0,0,nil,nil
    local seen={}
    local starts={}
    for _,start in ipairs(map.candidateStarts)do
        if type(start)~='table'or not id(start.id)then return nil,'unverified-candidate-route'end
        starts[#starts+1]=start
    end
    table.sort(starts,function(a,b)return a.id<b.id end)
    for _,start in ipairs(starts)do
        if type(start)~='table'or not id(start.id)or seen[start.id]or not point(start.position,map.width,map.height)
            or not route(start.land)or not route(start.air)or not route(start.naval)then return nil,'unverified-candidate-route'end
        if start.position[1]==map.ownStart[1]and start.position[3]==map.ownStart[3]then return nil,'own-start-in-candidates'end
        seen[start.id]=true
        if start.land.reachable then land=land+1;minLandTravel=math.min(minLandTravel or start.land.seconds,start.land.seconds)end
        if start.air.reachable then air=air+1 end
        if start.naval.reachable then naval=naval+1 end
        if start.air.reachable then
            local delta=start.land.reachable and math.max(0,1-start.air.seconds/start.land.seconds)or 1
            advantage=advantage+delta
        end
        for _,r in ipairs({start.land,start.air})do
            if r.reachable then minTravel=math.min(minTravel or r.seconds,r.seconds)end
        end
    end
    local nearMass,reachableMass=0,0
    seen={}
    for _,site in ipairs(map.massSites)do
        if type(site)~='table'or not id(site.id)or seen[site.id]or not point(site.position,map.width,map.height)
            or not route(site.engineer)then return nil,'unverified-mass-route'end
        seen[site.id]=true
        if site.engineer.reachable then
            reachableMass=reachableMass+1
            if site.engineer.seconds<=40 then nearMass=nearMass+1 end
        end
    end
    local count=#map.candidateStarts
    return{key=map.key,landReach=land/count,airReach=air/count,navalReach=naval/count,
        nearMass=nearMass,reachableMass=reachableMass,airAdvantage=advantage/count,
        earliestCandidateTravel=minTravel,earliestLandTravel=minLandTravel,chokes=math.min(1,t.chokes/3),flanks=math.min(1,t.flanks/3),
        waterFraction=t.waterFraction,navalBuildSiteValidated=t.navalBuildSiteValidated}
end

-- Initial configurable priors, not measured claims about faction strength.
function OpeningPreferences(faction,personality)
    local priors={
        UEF={1.2,1.1,1,1,1.1},CYBRAN={1.2,1,1,0.8,1.1},ILLUMINATE={1.1,1.1,1.15,0.85,0.8}}
    local bias={Balanced={},Land={land_pressure=1.6},Air={air_control=1.8},Naval={naval=1.8},
        Rush={land_pressure=1.6,air_control=1.2,expansion=0.7,defensive=0.7},Turtle={defensive=1.7,expansion=1.1}}
    if not priors[faction]or not bias[personality]then return nil,'invalid-opening-preference'end
    local result={}
    for i,style in ipairs(styles)do result[style]=priors[faction][i]*(bias[personality][style]or 1)end
    return result
end
local function fit(map,style)
    local close=map.earliestCandidateTravel and math.max(0,1-map.earliestCandidateTravel/180)or 0
    local landClose=map.earliestLandTravel and math.max(0,1-map.earliestLandTravel/180)or 0
    if style=='land_pressure'and map.landReach==1 then return 1+landClose*.8+map.flanks*.4-map.chokes*.5
    elseif style=='air_control'and map.airReach==1 then return 1+map.airAdvantage*1.5+map.flanks*.2
    elseif style=='expansion'and map.reachableMass>0 then return .8+math.min(6,map.nearMass)*.2+(1-close)*.4
    elseif style=='defensive'and map.landReach>0 then return .8+map.chokes*.8+close*.4
    elseif style=='naval'and map.navalBuildSiteValidated and map.waterFraction>0 and map.navalReach>0 then return .8+map.waterFraction+map.navalReach*.5 end
end
local function copySteps(steps)
    if type(steps)~='table'or #steps<1 or #steps>24 then return end
    local allowed={build=true,produce=true,research=true,scout=true,expand=true}
    local result={}
    for _,step in ipairs(steps)do
        if type(step)~='table'or not allowed[step.kind]or not id(step.target)or not integer(step.count)or step.count<1 or step.count>8 then return end
        result[#result+1]={kind=step.kind,target=step.target,count=step.count}
    end
    return result
end
local function hash(value,text)
    for i=1,#text do value=(value*131+string.byte(text,i))%2147483647 end
    return math.max(1,value)
end
local function draw(seed,choices,total)
    seed=(seed*16807)%2147483647
    local target=(seed/2147483647)*total
    for _,choice in ipairs(choices)do target=target-choice.weight;if target<0 then return choice,seed end end
    return choices[#choices],seed
end
function ChooseOpening(context)
    if type(context)~='table'or not integer(context.seed)or context.seed<1 or context.seed>=2147483647
        or not integer(context.epoch)or context.epoch>1000000 or not id(context.armyKey)or not id(context.rulesKey)
        or not number(context.massBudget)or not number(context.energyBudget)or type(context.plans)~='table'or #context.plans>32 then
        return nil,'invalid-opening-context'
    end
    local map,why=AnalyzeOpeningMap(context.map);if not map then return nil,why end
    local defaults=OpeningPreferences(context.faction,context.personality or'Balanced')
    if not defaults then return nil,'invalid-opening-preference'end
    local preferences=context.preferences or defaults
    if type(preferences)~='table'then return nil,'invalid-opening-preference'end
    for _,style in ipairs(styles)do if not number(preferences[style])or preferences[style]>4 then return nil,'invalid-opening-preference'end end
    local groups,seen={},{}
    for _,plan in ipairs(context.plans)do
        if type(plan)~='table'or not id(plan.id)or seen[plan.id]then return nil,'invalid-opening-plan'end
        seen[plan.id]=true
        local quality=styleSet[plan.style]and fit(map,plan.style)
        local steps=copySteps(plan.steps)
        if quality and steps and plan.faction==context.faction and plan.legal==true and plan.economyValidated==true
            and number(plan.initialMass)and number(plan.initialEnergy)and plan.initialMass<=context.massBudget
            and plan.initialEnergy<=context.energyBudget and number(plan.weight)and plan.weight>0 and plan.weight<=4
            and preferences[plan.style]>0 then
            local group=groups[plan.style]or{style=plan.style,weight=quality*preferences[plan.style],plans={}}
            group.plans[#group.plans+1]={id=plan.id,style=plan.style,steps=steps,weight=plan.weight};groups[plan.style]=group
        end
    end
    local seed=hash(hash(hash(context.seed,context.armyKey),map.key),context.rulesKey..':'..context.faction..':'..context.epoch)
    local function result(plan)
        return{kind='opening-plan',templateId=plan.id,style=plan.style,steps=plan.steps,mapKey=map.key,
            rulesKey=context.rulesKey,faction=context.faction,epoch=context.epoch,choiceSeed=seed,
            reason='public-map-fit-preferences-and-seeded-variation'}
    end
    local previous=context.current
    if type(previous)=='table'and previous.mapKey==map.key and previous.rulesKey==context.rulesKey
        and previous.faction==context.faction and previous.epoch==context.epoch and previous.choiceSeed==seed then
        for _,style in ipairs(styles)do
            local group=groups[style]
            if group then for _,plan in ipairs(group.plans)do if plan.id==previous.templateId then return result(plan)end end end
        end
    end
    local best,choices=0,{}
    for _,style in ipairs(styles)do local group=groups[style];if group then best=math.max(best,group.weight)end end
    -- Variation is limited to suitably ranked families. Extra variants of one
    -- family do not increase that family's probability.
    local total=0
    for _,style in ipairs(styles)do
        local group=groups[style]
        if group and group.weight>=best*.75 then
            table.sort(group.plans,function(a,b)return a.id<b.id end)
            choices[#choices+1]=group;total=total+group.weight
        end
    end
    if total<=0 then return nil,'no-viable-opening'end
    local group,nextSeed=draw(seed,choices,total)
    local variantTotal=0;for _,plan in ipairs(group.plans)do variantTotal=variantTotal+plan.weight end
    local plan=draw(nextSeed,group.plans,variantTotal)
    return result(plan)
end
