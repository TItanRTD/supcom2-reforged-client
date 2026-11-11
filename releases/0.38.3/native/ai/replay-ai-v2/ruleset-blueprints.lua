-- Runs after the selected balance and research blueprint passes.
local describe=setmetatable({}, {__index=getfenv(1)})
doscript('/lua/system/reforged_ai_catalog.lua',describe)

function Install(all)
    for id,d in pairs(describe.Build(all))do
        local bp=all.Unit[id]
        if d.layer=='air'and bp.Air and type(bp.Air.MaxAirspeed)=='number'and bp.Air.MaxAirspeed>0 then
            d.speed=bp.Air.MaxAirspeed
        end
        d.passiveConverterEnergy=bp.ReforgedPassiveConverter and bp.Economy.MaintenanceConsumptionPerSecondEnergy or nil
        d.tacticalInterceptRange=0
        d.tacticalLaunchRange=0
        local otherWeapons=false
        for _,entry in ipairs(bp.Weapons or{})do
            local w=type(entry)=='table'and entry or(all.Weapon or{})[entry]
            if w and type(w.MaxRadius)=='number'and (w.Damage or 0)>0 then
                if w.TargetType=='RULEWTT_Projectile'and w.TargetRestrictOnlyAllow=='TACTICAL MISSILE'then
                    d.tacticalInterceptRange=math.max(d.tacticalInterceptRange,w.MaxRadius)
                elseif w.TargetType~='RULEWTT_Projectile'and w.WeaponCategory~='Death'and w.Label~='DeathWeapon'then
                    local projectile=w.ProjectileId and (all.Projectile or {})[string.lower(w.ProjectileId)]
                    local tactical=w.Label=='TacticalMissile01'
                    for _,category in ipairs(projectile and projectile.Categories or{})do
                        if category=='TACTICAL'then tactical=true;break end
                    end
                    if tactical and d.groundRange>0 then d.tacticalLaunchRange=math.max(d.tacticalLaunchRange,w.MaxRadius)
                    elseif w.MaxRadius>0 then otherWeapons=true end
                end
            end
        end
        d.tacticalOnly=d.tacticalLaunchRange>0 and not otherWeapons
        bp.ReforgedAI=d
    end
end
