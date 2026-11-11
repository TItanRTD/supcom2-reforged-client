-- Reforged 0.30.0 pure strategy policy; engine effects belong to the native adapter.
local roles={'mainline','aa','siege','support','raider'}
local function number(v)return type(v)=='number'and v==v and v>=0 and v<math.huge end
local function position(p)return type(p)=='table'and number(p[1])and number(p[3])end
local function ordered(catalog)
    local result={}for _,unit in pairs(catalog)do result[#result+1]=unit end
    table.sort(result,function(a,b)return a.id<b.id end);return result
end
local function usable(contact,catalog)
    return type(contact)=='table'and number(contact.confidence)and contact.confidence>0 and contact.confidence<=1
        and number(contact.age)and position(contact.position)and catalog[contact.blueprint]
end
local function fresh(contact)
    return contact.current==true and contact.channel=='vision'and contact.age<=2
end
local function quote(unit,context)
    local q=(context.quotes or{})[unit.id]
    if type(q)~='table'or q.legal~=true or q.canBuild~=true or not number(q.mass)or not number(q.energy)then return end
    if not number(context.massBudget)or not number(context.energyBudget)then return end
    if q.mass>context.massBudget or q.energy>context.energyBudget then return end
    return q
end
function DesiredMix(contacts,catalog)
    local air,defense,ground,total=0,0,0,0
    for _,contact in ipairs(contacts)do
        local unit=usable(contact,catalog)
        if unit then
            local value=math.max(1,unit.mass)*contact.confidence
            if unit.mobile and not unit.roles.scout and not unit.roles.engineer then
                total=total+value;if unit.layer=='air'then air=air+value elseif unit.layer=='land'and unit.groundRange>0 then ground=ground+value end
            elseif unit.roles.defense then total=total+value;defense=defense+value end
        end
    end
    local mix={mainline=.60,aa=.10,siege=.15,support=.10,raider=.05}
    if total>0 then mix.aa=mix.aa+.45*air/total;mix.siege=mix.siege+.50*defense/total+.18*ground/total end
    local sum=0;for _,role in ipairs(roles)do sum=sum+mix[role]end
    for _,role in ipairs(roles)do mix[role]=mix[role]/sum end
    return mix
end
-- Air starts may add one early land factory when ordinary reconnaissance
-- confirms a useful ground route and a reason to stop relying on air alone.
function TacticalThreat(position,contacts,catalog)
    for _,contact in ipairs(contacts)do
        local d=usable(contact,catalog)
        local range=d and d.tacticalLaunchRange or 0
        if range>0 and fresh(contact)then
            local dx,dz=position[1]-contact.position[1],position[3]-contact.position[3]
            if dx*dx+dz*dz<=range*range then return true end
        end
    end
    return false
end
-- Favor an existing team split only with a recent ally declaration and an
-- estimated ground route. Unknown allies or routes leave the normal plan in charge.
function OpeningAirCover(context,allies,routeLength)
    if context.now>150 or context.teamRole~='air_cover' or context.allowInvestment~=true
        or context.airReady<1 or context.landCommitted>0 then return false end
    for _,ally in ipairs(allies)do
        if not ally.emergency and number(ally.age)and ally.age+context.reviewAge<=8
            and number(ally.homeGround)and ally.homeGround>=120
            and position(ally.home)and number(ally.groundSpeed)and ally.groundSpeed>0 then
            local length=routeLength(ally.home)
            if number(length)and length/ally.groundSpeed<=75 then return true end
        end
    end
    return false
end
function OpeningLandFollowup(context,contacts,catalog)
    if context.now<25 or context.now>150 or context.airFactories<1 or context.landFactories>0
        or not context.landReach or context.allowInvestment~=true then return end
    local combat=0
    for _,contact in ipairs(contacts)do
        local unit=usable(contact,catalog)
        if unit and fresh(contact)then
            if unit.structure and unit.layer=='land'and unit.roles.factory and not unit.roles.gantry then
                return 'opening-land-followup-spotted-factory'
            end
            if unit.structure and unit.roles.defense and unit.airRange>0 then
                return 'opening-land-followup-spotted-aa'
            end
            if unit.layer=='land'and unit.mobile and unit.groundRange>0
                and not unit.roles.scout and not unit.roles.commander and not unit.roles.engineer then
                combat=combat+1
                if combat>=2 then return 'opening-land-followup-spotted-army'end
            end
        end
    end
end
function ChooseProduction(context,catalog,enemyCatalog)
    -- Own active capabilities and public enemy potential are separate views.
    -- Never test an opponent's weapons against our army's research unlocks.
    enemyCatalog=enemyCatalog or catalog
    if not number(context.capRemaining)or context.capRemaining<1 then return nil,'unit-cap'end
    local layer=context.productionLayer or'land'
    if layer~='land'and layer~='air'and layer~='naval'then return nil,'invalid-production-layer'end
    local enemyAir,enemyFighters=0,0
    for _,c in ipairs(context.contacts or{})do local d=usable(c,enemyCatalog)
        if d and d.layer=='air'and d.mobile and not d.roles.scout then
            enemyAir=enemyAir+d.mass*c.confidence
            if d.airRange>0 then enemyFighters=enemyFighters+d.mass*c.confidence end
        end
    end
    local coverBlocked=false
    local function viable(unit)
        if unit.roles.fieldEngineer or(unit.flags or{}).FIELDENGINEER then return false end
        if unit.faction=='UEF'and unit.layer=='air'and unit.flags and unit.flags.BOMBER and not unit.flags.FIGHTER
            and enemyFighters>0 and(context.friendlyFighterMass or 0)<enemyFighters*1.2 then coverBlocked=true;return false end
        return true
    end
    local units=ordered(catalog)
    -- If bomber cover is absent, acquire interceptors instead of idling forever
    -- because global AA quotas happen to be filled by ground units.
    if layer=='air'and enemyFighters>0 and(context.friendlyFighterCommitted or context.friendlyFighterMass or 0)<enemyFighters*1.2 then
        for _,unit in ipairs(units)do local q=quote(unit,context)
            if q and unit.layer=='air'and unit.mobile and not unit.roles.scout and unit.airRange>0 and viable(unit)then
                return{kind='build-unit',blueprint=unit.id,role='aa',reason='build-interceptors-for-observed-air-cover-gap'}
            end
        end
    end
    if context.scoutNeeded==true and number(context.scoutsCommitted)and number(context.scoutsWanted)
        and context.scoutsCommitted<math.min(3,context.scoutsWanted)then
        local best,cost
        for _,unit in ipairs(units)do
            local q=quote(unit,context)
            if unit.roles.scout and unit.layer==layer and q and(not cost or q.mass<cost)then best=unit;cost=q.mass end
        end
        if best then return{kind='build-unit',blueprint=best.id,role='scout',reason='refresh-start-expansion-and-flank-intel'}end
    end
    if not number(context.armyTargetMass)or context.armyTargetMass<=0 then return nil,'missing-army-target'end
    local mix=DesiredMix(context.contacts or{},enemyCatalog);local committed=context.committedRoleMass or{}
    if context.roleWeights then
        local total=0
        for _,role in ipairs(roles)do local w=context.roleWeights[role]or 1
            if not number(w)or w<.25 or w>4 then return nil,'invalid-strategy-mix'end
            mix[role]=mix[role]*w;total=total+mix[role]
        end
        for _,role in ipairs(roles)do mix[role]=mix[role]/total end
    end
    local choice,gap,fit
    for _,role in ipairs(roles)do
        local have=committed[role]or 0
        if not number(have)then return nil,'invalid-commitment'end
        local deficit=mix[role]*context.armyTargetMass-have
        if role=='aa'and layer=='land'and number(context.groundAACommitted)then
            local target=enemyAir>0 and math.max(0,enemyAir*.6-(context.friendlyFighterMass or 0)*.7)or context.armyTargetMass*.03
            deficit=target-context.groundAACommitted
        end
        if deficit>0 then
            for _,unit in ipairs(units)do
                local q=quote(unit,context)
                if unit.roles[role]and unit.layer==layer and q and viable(unit)then
                    local deviation=math.abs(deficit-q.mass)
                    if not choice or deficit>gap or(deficit==gap and deviation<fit)then
                        choice={kind='build-unit',blueprint=unit.id,role=role,reason='observed-counter-and-committed-army-deficit'}
                        gap=deficit;fit=deviation
                    end
                end
            end
        end
    end
    if choice then return choice end
    if context.massBudget>=300 then
        local best,price
        for _,unit in ipairs(units)do local q=quote(unit,context)
            if q and unit.layer==layer and(unit.roles.mainline or unit.roles.siege)and viable(unit)and(not price or q.mass<price)then best=unit;price=q.mass end
        end
        if best then return{kind='build-unit',blueprint=best.id,role=best.roles.mainline and'mainline'or'siege',reason='spend-surplus-on-legal-combat-production'}end
    end
    return nil,coverBlocked and'fighter-cover-not-ready'or'no-affordable-legal-deficit'
end
function ChooseExpansionDefense(context,catalog)
    if context.ownedExpansion~=true or context.exposed~=true or context.placementValidated~=true then return nil,'no-validated-exposed-expansion'end
    if not number(context.defensesCommitted)or context.defensesCommitted>=2 then return nil,'defense-cap'end
    if not number(context.defenseBudgetMass)then return nil,'missing-defense-budget'end
    local best,cost
    for _,unit in ipairs(ordered(catalog))do
        local q=quote(unit,context)
        if unit.roles.expansionDefense and q and q.mass<=context.defenseBudgetMass and(not cost or q.mass<cost)then best=unit;cost=q.mass end
    end
    if best then return{kind='build-defense',blueprint=best.id,site=context.site,reason='bounded-light-defense-for-exposed-expansion'}end
    return nil,'no-affordable-legal-light-defense'
end
local function segmentDistance2(p,a,b)
    local dx,dz=b[1]-a[1],b[3]-a[3];local length=dx*dx+dz*dz
    local t=length>0 and math.max(0,math.min(1,((p[1]-a[1])*dx+(p[3]-a[3])*dz)/length))or 0
    local x,z=p[1]-a[1]-t*dx,p[3]-a[3]-t*dz;return x*x+z*z
end
function ChooseRoute(routes,contacts,catalog,layer,maxThreat)
    if not number(maxThreat)or(layer~='air'and layer~='land'and layer~='naval')then return nil,'invalid-route-budget'end
    if #routes>8 then return nil,'route-work-budget'end
    local best,score
    for _,route in ipairs(routes)do
        if route.reachable==true and type(route.id)=='string'and type(route.points)=='table'and #route.points>=2 and #route.points<=32 then
            local valid=true;local length=0
            for i,p in ipairs(route.points)do
                if not position(p)then valid=false;break end
                if i>1 then local a=route.points[i-1];length=length+math.sqrt((p[1]-a[1])^2+(p[3]-a[3])^2)end
            end
            if valid then
                local risk=0
                for _,contact in ipairs(contacts)do
                    local unit=usable(contact,catalog)
                    if unit and not unit.scriptManaged then
                        local range=import('/lua/sim/reforged_ai_effective.lua').WeaponRange(unit,layer=='air'and'Air'or'Land',contact.currentLayer or unit.physicalLayer)
                        range=math.max(range,layer~='air'and(unit.scriptedRange or 0)or 0)
                        if range>0 then
                            for i=2,#route.points do
                                if segmentDistance2(contact.position,route.points[i-1],route.points[i])<=(range+3)^2 then
                                    risk=risk+math.max(20,unit.mass)*contact.confidence*(unit.roles.defense and 1.5 or 1)
                                    break
                                end
                            end
                        end
                    end
                end
                local value=length+risk*2
                if risk<=maxThreat and(not score or value<score or(value==score and route.id<best.id))then
                    best={id=route.id,length=length,knownThreatMass=risk};score=value
                end
            end
        end
    end
    if best then return best end
    return nil,'no-acceptable-route'
end
local function contactIntent(kind,contact,route,reason)
    local visible=fresh(contact)
    return{kind=kind,contactId=contact.id,targetId=visible and contact.id or nil,position={contact.position[1],contact.position[2],contact.position[3]},
        route=route.id,action=visible and'attack'or'move',requiresReacquire=not visible,reason=reason}
end
local function scout(context,catalog)
    local choice,priority
    for _,site in ipairs(context.scoutSites or{})do
        if type(site.id)=='string'and(site.lastScouted==nil or(number(site.lastScouted)and site.lastScouted<=context.now))then
            local route=ChooseRoute((context.routes or{})[site.id]or{},context.contacts or{},catalog,context.scoutLayer or'air',0)
            if route then
                local age=site.lastScouted and context.now-site.lastScouted or(context.now+60)
                local value=age/(1+route.length/100)
                if not priority or value>priority or(value==priority and site.id<choice.site)then
                    choice={kind='scout',site=site.id,route=route.id,reason='refresh-oldest-reachable-start-expansion-or-flank'};priority=value
                end
            end
        end
    end
    return choice or{kind='rally',reason='no-safe-scout-route-prepare-reachable-forces'}
end
function ChooseObjective(context,catalog)
    if not number(context.now)or not number(context.mainForceMass)then return nil,'invalid-objective-context'end
    if context.commanderUnderAttack==true and number(context.commanderHealth)and context.commanderHealth<.4 then
        return{kind='protect-commander',action='retreat-and-screen',reason='assassination-survival-first'}
    end
    if context.homeUnderAttack==true then return{kind='defend',reason='protect-own-economy-and-production'}end
    local contacts=context.contacts or{}
    if #contacts>256 then return nil,'contact-work-budget'end
    local routes=context.routes or{}
    -- finishReady and localCoverageFresh must be established by the future
    -- force/sensor adapters. This prototype has no tactical damage predictor.
    if context.victory=='assassination'and context.finishReady==true and context.localCoverageFresh==true and context.mainForceMass>0 then
        for _,contact in ipairs(contacts)do
            local unit=usable(contact,catalog)
            if unit and unit.roles.commander and fresh(contact)and number(contact.health)and contact.health<=1 then
                local route=ChooseRoute(routes[contact.id]or{},contacts,catalog,context.forceLayer or'land',context.mainForceMass/1.5)
                if route then return contactIntent('finish',contact,route,'verified-opening-to-kill-enemy-commander')end
            end
        end
    end
    if number(context.lastProgressAt)and context.lastProgressAt<=context.now and context.now-context.lastProgressAt>=90 then
        return{kind='break-stalemate',needs={scout=true,siege=true,alternateRoute=true},reason='no-progress-reassess-counter-and-approach'}
    end
    local raidMass=math.min(number(context.raidForceMass)and context.raidForceMass or 0,context.mainForceMass*.25)
    local choice,score
    if raidMass>0 then
        for _,contact in ipairs(contacts)do
            local unit=usable(contact,catalog)
            if unit and(unit.roles.economy or unit.roles.engineer)and contact.confidence>=.5 then
                local route=ChooseRoute(routes[contact.id]or{},contacts,catalog,context.forceLayer or'land',raidMass/1.5)
                if route then
                    local value=math.max(20,unit.mass)*contact.confidence/(1+route.length+route.knownThreatMass*2)
                    if not score or value>score or(value==score and contact.id<choice.contactId)then
                        choice=contactIntent('raid',contact,route,'deny-scouted-expansion-or-engineer');choice.maxForceMass=raidMass;score=value
                    end
                end
            end
        end
    end
    if choice then return choice end
    if context.pressureReady==true and context.mainForceMass>0 then
        for _,contact in ipairs(contacts)do
            local unit=usable(contact,catalog)
            if unit and(unit.roles.factory or unit.roles.defense or unit.roles.economy or(context.victory~='assassination'and unit.structure))then
                local route=ChooseRoute(routes[contact.id]or{},contacts,catalog,context.forceLayer or'land',context.mainForceMass/1.5)
                if route then return contactIntent('pressure',contact,route,'attack-known-production-and-open-a-finishing-route')end
            end
        end
    end
    return scout(context,catalog)
end
