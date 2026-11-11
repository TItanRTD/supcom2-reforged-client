-- General synchronized lobby rules, applied identically to occupied human and
-- AI army slots. Native SetArmyHandicap ADDS a delta; never apply the full bonus
-- repeatedly or add the old Custom resource setting on top.
local allowed={[25]=true,[50]=true,[75]=true,[100]=true,[125]=true,[150]=true,[175]=true,[200]=true,[300]=true}
function Percent(brain)
    local options=ScenarioInfo.Options or{}
    if options.RFLadder==true or options.RFLadder=='true'then return 100 end
    local slot=tonumber(string.match(brain.Name or'','^ARMY_(%d+)$'))
    if not slot or slot<1 or slot>8 then return 100 end
    local percent=slot and tonumber(options['RFIncome'..slot])or 100
    if not allowed[percent]then return 100 end
    return percent
end
function Apply(brain)
    if brain.ReforgedResourcesApplied then return end
    local percent=Percent(brain)
    local current=ArmyGetHandicap(brain:GetArmyIndex())
    assert(type(current)=='number'and current==current and math.abs(current)<math.huge,'Unknown army income modifier')
    local desired=percent/100-1
    SetArmyHandicap(brain:GetArmyIndex(),desired-current)
    local actual=ArmyGetHandicap(brain:GetArmyIndex())
    assert(type(actual)=='number'and math.abs(actual-desired)<.0001,'Army income modifier readback mismatch')
    brain.ReforgedResourcesApplied=true;brain.ReforgedResourcePercent=percent
    LOG('RF_SLOT|v=1|army='..brain:GetArmyIndex()..'|incomePercent='..percent..'|readback='..actual)
end
