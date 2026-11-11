-- Strategic influences over public map estimates, own state and legal contacts.
-- Scores are tunable priors, not measured competitive win probabilities.
local order={'defensive','land_pressure','air_control','expansion','siege','research','reclaim','experimental','naval'}
local settings={
    defensive={mix={mainline=1.3,aa=1.4,support=1.2},raid=0,pressure=1.6,expand=false,invest=false},
    land_pressure={mix={mainline=1.3,raider=1.5},raid=.3,pressure=.85,expand=true,invest=true},
    air_control={mix={aa=1.5,mainline=1.15},raid=.2,pressure=1,expand=true,invest=true},
    expansion={mix={mainline=1.1,aa=1.2},raid=.1,pressure=1.3,expand=true,invest=true},
    siege={mix={siege=2,support=1.4},raid=.15,pressure=1.4,expand=true,invest=true},
    research={mix={support=1.3,aa=1.2},raid=.1,pressure=1.3,expand=true,invest=true},
    reclaim={mix={mainline=1.2,support=1.2},raid=.1,pressure=1.1,expand=true,invest=true},
    experimental={mix={support=1.6,aa=1.4},raid=.1,pressure=1.2,expand=true,invest=true},
    naval={mix={mainline=1.3,aa=1.3},raid=.15,pressure=1.1,expand=true,invest=true},
}
local function n(x)return type(x)=='number'and x==x and x>=0 and x<math.huge and x or 0 end
local function clamp(x,a,b)return math.max(a,math.min(b,x))end
function Personality(value,seed,army)
    local allowed={Balanced=true,Land=true,Air=true,Naval=true,Rush=true,Turtle=true}
    if allowed[value]then return value end
    if value=='Random'then return({'Balanced','Land','Air','Naval','Rush','Turtle'})[((seed or 1)+(army or 1)*17)%6+1]end
    return'Balanced'
end
function Choose(c,previous)
    local now=n(c.now);local own=c.own or{};local enemy=c.enemy or{};local map=c.map or{}
    local ready=n(own.ground);local near=n(own.homeDefense);local danger=n(enemy.home)
    local deadline=n(c.safeWindow);local uncertainty=clamp(n(c.uncertainty),0,1)
    local health=clamp(own.commanderHealth==nil and 1 or n(own.commanderHealth),0,1)
    local emergency=danger>0 and(danger>near*.8 or health<.45)
    local scores={};local reasons={}
    local function add(style,score,reason) scores[style]=score;reasons[style]=reason end
    add('defensive',1+danger/math.max(100,near)+n(map.chokes)*.2,'retain-local-survival-capacity')
    if c.landLegal and c.landReach then add('land_pressure',2+clamp(1-n(map.travelSeconds)/180,0,1)+n(map.flanks)*.4+
        math.min(1,ready/math.max(200,n(enemy.ground)+n(enemy.defense))),'reachable-ground-pressure')end
    if c.airLegal then add('air_control',1.8+n(map.airAdvantage)+n(enemy.air)/math.max(200,ready)+
        (c.teamRole=='air_cover'and 1.2 or 0),'air-route-and-interception-demand')end
    local safe=not emergency and deadline>45 and type(c.energySurplus)=='number'and c.energySurplus>=0
    if safe and n(c.safeMexes)>0 then add('expansion',1.8+math.min(1.6,n(c.safeMexes)*.25)+
        math.min(1,deadline/180)-uncertainty,'funded-safe-expansion-window')end
    if safe and c.landLegal and c.landReach and n(enemy.defense)>100 then
        add('siege',2.3+math.min(1.8,n(enemy.defense)/math.max(150,ready))+n(map.chokes)*.25,'observed-static-defense')
    end
    if safe and c.researchGoal and c.researchETA and c.researchETA+20<deadline and n(c.mass)>150 and n(c.energy)>400 then
        add('research',2.4+math.min(1,(deadline-c.researchETA)/120)-uncertainty,'unlock-before-observed-deadline')
    end
    if not emergency and n(c.reclaimMass)>150 then add('reclaim',2.8+math.min(1.5,n(c.reclaimMass)/500),'visible-profitable-salvage')end
    if safe and c.experimentalReady and ready>=200 then add('experimental',5,'completed-experimental-with-screen')end
    if c.navalLegal and c.navalReach and not emergency then add('naval',3+n(map.waterFraction),'native-reachable-useful-water-objective')end
    local personality=Personality(c.personality,c.seed,c.army)
    local biases={Land={land_pressure=.6},Air={air_control=.7},Naval={naval=.8},Rush={land_pressure=.9,expansion=-.5,research=-.4},Turtle={defensive=.6,siege=.5}}
    for style,bias in pairs(biases[personality]or{})do if scores[style]then scores[style]=scores[style]+bias end end
    if c.teamRole=='ground'then if scores.land_pressure then scores.land_pressure=scores.land_pressure+.5 end end
    if c.teamRole=='support'then if scores.siege then scores.siege=scores.siege+.4 end end
    if c.allyLost then scores.defensive=scores.defensive+.8;reasons.defensive='ally-commitment-lost-reassess-coverage'end
    local winner,best
    for _,style in ipairs(order)do if scores[style]then
        -- Switching to a different factory family costs time and committed money.
        local cost=previous and previous.style~=style and n((c.switchCosts or{})[style])or 0
        local value=scores[style]-math.min(1,cost/500)
        if not winner or value>best then winner=style;best=value end
    end end
    if emergency then winner='defensive';best=100;reasons.defensive='observed-immediate-survival-threat'
    elseif previous and scores[previous.style]and winner~=previous.style then
        local held=now-n(previous.since)
        if held<30 or best<scores[previous.style]+.55 then winner=previous.style;best=scores[winner];reasons[winner]='retain-feasible-plan-hysteresis'end
    end
    local cfg=settings[winner];local changed=not previous or previous.style~=winner
    return{style=winner,since=changed and now or previous.since,revision=(previous and previous.revision or 0)+(changed and 1 or 0),
        score=best,reason=reasons[winner],emergency=emergency,mix=cfg.mix,raidFraction=cfg.raid,pressureMultiplier=cfg.pressure,
        allowExpansion=cfg.expand and not emergency,allowInvestment=cfg.invest and safe,
        factoryLayer=winner=='air_control'and'air'or winner=='naval'and'naval'or'land',
        researchGoal=winner=='research'and c.researchGoal or nil,deadline=deadline,personality=personality,scores=scores}
end
-- Completed interception assets must be geographically useful. No team promises
-- and no queued aircraft are treated as delivered protection.
function ReadyCover(units,position,deadline)
    local mass=0
    for _,u in ipairs(units)do
        if u.complete and u.airRange>0 and u.speed>0 and u.health>=.35 then
            local dx,dz=u.position[1]-position[1],u.position[3]-position[3]
            local arrival=math.max(0,math.sqrt(dx*dx+dz*dz)-u.airRange)/u.speed
            if arrival<=deadline then mass=mass+u.mass end
        end
    end
    return mass
end
function ResearchETA(goal,defs,brain,income)
    local chain=import('/lua/sim/reforged_ai_planning.lua').ResearchPath(goal,defs,brain)
    if not chain then return nil end
    local bank=brain:GetEconomyStored('RESEARCH')
    if type(bank)~='number'or bank~=bank or bank<0 then return nil end
    local deficit=math.max(0,chain.points-bank)
    if deficit>0 and n(income)<=0 then return nil end
    return deficit>0 and deficit/income or 0,chain.mass,chain.energy
end
