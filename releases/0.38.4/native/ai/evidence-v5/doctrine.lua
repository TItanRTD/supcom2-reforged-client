-- Persistent faction research plans. Inputs are own economy/units and legal
-- observations. Active definitions always own prices, prerequisites and unlocks.
local planning=import('/lua/sim/reforged_ai_planning.lua')
local function n(v)return type(v)=='number'and v==v and v>=0 and v<math.huge and v or 0 end
local foundations={UEF={'UBB_BUILDCOST','UBB_BUILDTIME'},CYBRAN={'CBB_BUILDTIME','CBB_BUILDCOST'},ILLUMINATE={'ILB_BUILDCOST','ILB_BUILDTIME'}}
function Select(c,previous)
    if previous and previous.faction==c.faction then
        if c.now-(previous.reviewed or 0)>60 and n(c.airFactories)>0 and n(c.airMass)>math.max(200,n(c.landMass)*2)then previous.id='air-control';previous.reviewed=c.now end
        return previous
    end
    local id
    if c.faction=='CYBRAN'then id='megalith-cicada'
    elseif c.faction=='ILLUMINATE'then id=((c.groundPressure or 0)>200 or(n(c.seed)+n(c.army))%2==0)and'teleport-shields'or'teleport-bodaboom'
    else id=((c.exposedMexes or 0)>0 or c.personality=='Turtle'or(n(c.seed)+n(c.army))%2==0)and'mexguns-fatboy'or'fatboy'
    end
    return{id=id,faction=c.faction,since=c.now,sideSpent=0,mainPurchases=0}
end
function Goals(plan,c)
    if plan.id=='air-control'then local prefix=c.faction=='UEF'and'UAB_'or c.faction=='CYBRAN'and'CAB_'or'IAB_';return{prefix..'DAMAGE',prefix..'TRAINING1',prefix..'HEALTH',prefix..'REGENERATION'}end
    local result={};for _,id in ipairs(foundations[plan.faction]or{})do result[#result+1]=id end
    if plan.faction=='CYBRAN'then
        result[#result+1]='CLU_MEGALITHII'
        if n(c.megalithReady)>0 then result[#result+1]='CLU_STEALTH_D1'end
        result[#result+1]='CLB_RATEOFFIRE';result[#result+1]='CLB_TRAINING1';result[#result+1]='CLP_SHIELD'
    elseif plan.faction=='ILLUMINATE'then
        result[#result+1]=plan.id=='teleport-shields'and'ILP_ANTIMATTERCHROME'or'ILU_ARMORENHANCER'
        result[#result+1]='ILA_TELEPORT';result[#result+1]='ILB_RANGE';result[#result+1]='ILB_DAMAGE';result[#result+1]='ILB_TRAINING1'
    else
        if plan.id=='mexguns-fatboy'then result[#result+1]='UBP_PDUPGRADE'end
        result[#result+1]='ULU_FATBOY';result[#result+1]='ULB_DAMAGE';result[#result+1]='ULU_SHIELDGENERATOR';result[#result+1]='ULB_TRAINING1'
    end
    return result
end
function ChooseResearch(plan,c,defs,brain,retries)
    local goals=Goals(plan,c);local goal,chain,blocked
    for _,id in ipairs(goals)do
        if defs[id]and not brain:HasResearched(id)then
            local p,why=planning.ResearchPath(id,defs,brain)
            if p then goal=id;chain=p;break else blocked=why end
        end
    end
    local bank=n(brain:GetEconomyStored('RESEARCH'))
    local candidates={}
    local function add(id,reason,limit,urgent)
        if defs[id]and not brain:HasResearched(id)then
            local p=planning.ResearchPath(id,defs,brain)
            local eta=p and math.max(0,p.points-bank)/math.max(.001,n(c.pointIncome))or math.huge
            if p and(p.points<=limit or urgent and eta+10<n(c.safeWindow))then candidates[#candidates+1]={id=id,reason=reason,chain=p,urgent=urgent}end
        end
    end
    -- Commander health is bought only while the actual commander is in danger.
    if c.faction=='UEF'and c.commanderFighting and n(c.commanderHealth)<.7 then add('UCB_HEALTH','acu-survival-in-current-engagement',3,true)end
    if c.faction=='CYBRAN'then
        if n(c.airPressure)>=80 or n(c.missilePressure)>=120 then add('CLU_ADV','observed-air-or-missiles-adaptor',6,true)end
        if c.commanderFighting or c.commanderForward then add('CCB_VISION','active-acu-vision',2)end
        if n(c.landMass)>=200 and c.intelNeeded then add('CLB_RADAR','land-force-radar-gap',3)end
        if n(c.radars)>0 and c.intelNeeded then add('CBB_RADAR','owned-radar-coverage-gap',3)end
        if n(c.detonationTargets)>0 then add('CLA_POWERDETONATE','visible-close-range-trade-opportunity',6)end
        if n(c.structureDetonationTargets)>0 then add('CBA_POWERDETONATE','threatened-structure-trade-opportunity',4,true)end
    elseif c.faction=='ILLUMINATE'then
        if n(c.airPressure)>=80 and n(c.landFactories)>0 and n(c.harvogMass)>=100 then add('ILP_ASSAULTBOTAA','observed-air-harvog-aa',6,true)end
        if n(c.landMass)>=250 and c.intelNeeded then add('ILB_RADARSONAR','land-force-radar-gap',3)end
    else
        if n(c.mexGroundThreat)>0 then add('UBP_PDUPGRADE','observed-raids-on-owned-mexes',math.huge,true)end
        if n(c.landMass)>=150 then add('ULB_RANGE','earned-range-for-current-land-force',3,n(c.groundPressure)>80);add('ULB_TRAINING1','training-current-land-force',3,n(c.groundPressure)>80)end
        if n(c.mexAirThreat)>0 then add('UBP_AAUPGRADE','observed-air-attacks-on-owned-mexes',5,true)end
        if n(c.radars)>0 and c.intelNeeded then add('UBB_INTEL','owned-radar-coverage-gap',2)end
        if c.commanderFighting and c.intelNeeded then add('UCB_RADAR','active-acu-radar-gap',3)end
        -- Avoid the expensive Fatboy/damage chain as an emergency AA detour.
        if n(c.airPressure)>=120 and n(c.landMass)>=300 then add('ULP_AA','affordable-land-aa-upgrade',6,true)end
    end
    local nextMain=chain and chain.nodes[1]
    local mainCost=nextMain and n(defs[nextMain].COST)or 0
    for _,candidate in ipairs(candidates)do
        local onPath=false;for _,id in ipairs(chain and chain.nodes or{})do if id==candidate.id then onPath=true end end
        local limit=candidate.urgent and 7 or 6
        local room=candidate.urgent or not goal or onPath or n(plan.sideSpent)+candidate.chain.points<=limit
        -- Nonurgent side purchases may use only points beyond the next main step.
        local affordable=bank>=candidate.chain.points+((candidate.urgent or onPath)and 0 or mainCost)
        if candidate.urgent then affordable=bank>=candidate.chain.points end
        if room and affordable and(not c.emergency or candidate.urgent)then
            local nextId=planning.NextResearch(candidate.id,defs,brain,retries,c.now,c.mass,c.energy)
            if nextId then return candidate.id,candidate.reason,nextId,onPath and'main'or'side',candidate.chain end
        end
    end
    if c.emergency then return nil,'survival-hold-main-research',nil,'hold',chain end
    if goal then
        local nextId,why=planning.NextResearch(goal,defs,brain,retries,c.now,c.mass,c.energy)
        return goal,'committed-'..plan.id,nextId,'main',chain,why
    end
    return nil,blocked or'available-plan-complete',nil,'complete'
end
function Purchased(plan,kind,cost)
    if kind=='main'then plan.sideSpent=0;plan.mainPurchases=n(plan.mainPurchases)+1
    else plan.sideSpent=n(plan.sideSpent)+n(cost)end
end
