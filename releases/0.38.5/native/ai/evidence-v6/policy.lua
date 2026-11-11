-- Reforged 0.30.0 pure policy policy; engine effects belong to the native adapter.
local levels={
    easy={name='Easy',decisionSeconds=2.5,ordersPerSecond=2,scouts=1,engineers=1,flanks=false,raids=false},
    normal={name='Normal',decisionSeconds=1.5,ordersPerSecond=4,scouts=1,engineers=2,flanks=false,raids=false},
    hard={name='Hard',decisionSeconds=1,ordersPerSecond=8,scouts=2,engineers=2,flanks=true,raids=true},
    reforger={name='Reforger',decisionSeconds=.5,ordersPerSecond=12,scouts=3,engineers=2,flanks=true,raids=true},
}
function DifficultyLevels()
    return{'easy','normal','hard','reforger'}
end
local archetypes={Balanced=true,Land=true,Air=true,Naval=true,Rush=true,Turtle=true}
function Profile(level)
    local p=levels[level]
    if not p then return nil,'unknown-level'end
    return {key='reforged_'..level,level=level,name=p.name,decisionSeconds=p.decisionSeconds,ordersPerSecond=p.ordersPerSecond,
        perUnitOrderSeconds=.5,maxContacts=2048,maxPathQueriesPerSecond=4,scoutsWanted=p.scouts,engineerLimit=p.engineers,compareFlanks=p.flanks,raidExpansions=p.raids,
        buildBonus=0,resourceBonus=0,veterancyBonus=0,intelType='None',handicap=0,
        freeUnits=false,freeResearch=false,enemyEconomyAccess=false,hiddenUnitAccess=false}
end
-- The retail Custom option parses these exact fields. This is a configuration
-- contract, not a new lobby entry or a certified native manager replacement.
function ScenarioSettings(level,archetype)
    local profile,why=Profile(level)
    if not profile then return nil,why end
    if not archetypes[archetype]then return nil,'unknown-archetype'end
    return {AIPersonality='Custom',aitype='Normal',aiarchetype=archetype,
        aibuildbonus='0',airesourcebonus='0',aivetbonus='0',aiintel='None',aitargetpreference='Strongest'},profile
end
-- Unknown readback is not evidence of a fair game. Research bonuses earned
-- normally are permitted; these checks concern AI-only configuration boosts.
function CheckReadback(state)
    if type(state)~='table'then return false,'missing-readback'end
    local equal={brainType='AI',aiType='Normal',buildBonus=0,resourceBonus=0,veterancyBonus=0,intelType='None',handicap=0,
        hasCheatBuff=false,hasOmniMarker=false,freeUnits=false,freeResearch=false}
    for _,name in ipairs({'brainType','aiType','buildBonus','resourceBonus','veterancyBonus','intelType','handicap','hasCheatBuff','hasOmniMarker','freeUnits','freeResearch'})do
        if state[name]~=equal[name]then return false,name end
    end
    return true
end
