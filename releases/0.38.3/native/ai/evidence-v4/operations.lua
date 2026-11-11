-- Bounded local operations over owned units and already legal perceptions.
local frame=import('/lua/sim/reforged_ai_frame.lua')
local effective=import('/lua/sim/reforged_ai_effective.lua')
local tactics=import('/lua/sim/reforged_ai_tactics.lua')
local strategy=import('/lua/sim/reforged_ai_strategy.lua')
local function safe(fn,...)local ok,v=pcall(fn,...);if ok then return v end end
local function health(u)return math.max(0,math.min(1,u:GetHealth()/math.max(1,u:GetMaxHealth())))end
local function mobile(d)return d and d.mobile and d.controlled and not(d.roles.engineer or d.roles.commander or d.roles.reclaimer or d.roles.scout)end
local function hunker(u,d)
 for _,entry in ipairs(d.abilities or{})do local name=type(entry)=='table'and entry.Blueprint or entry
  if type(name)=='string'and name:lower():find('hunker',1,true)and safe(function()return u:IsUnitAbilityState(name,'Activated')end)then return true end
 end
 return false
end
function Attach(State,h)
 function State:OnProjectileLaunch(unit,label,projectile)
  self.launches=self.launches or{};local id=tostring(unit:GetEntityId());local prior=self.launches[id]
  self.launches[id]={at=GetGameTimeSeconds(),label=label,count=(prior and prior.count or 0)+1}
  h.log(self,'projectile-launched',{actor=id,weapon=label,projectile=tostring(projectile),evidence='returned-native-projectile'})
 end
 function State:OnProjectileImpact(projectile,kind)
  h.log(self,'projectile-impact',{projectile=tostring(projectile),kind=tostring(kind),evidence='native-impact-callback',attribution='target-not-inspected'})
 end
 function State:ReserveCalls(cost,check)
  local limit=self.profile.ordersPerSecond*self.profile.decisionSeconds
  if self.phase=='task-progress'then limit=math.min(2,limit*.35)end
  if self.phase=='urgent-tactics'and not self.criticalCommander then limit=math.max(3,limit-1)end
  if self.orders+cost>limit then return false end
  if not check then self.orders=self.orders+cost end
  return true
 end
 function State:AbilityReserved()
  local mass,energy=0,0
  for _,pending in pairs(self.abilityPending or{})do mass=mass+(pending.mass or 0);energy=energy+(pending.energy or 0)end
  return mass,energy
 end
 function State:Ability(actor,d,name,position,reason)
  local rule=d.abilityRules and d.abilityRules[name]
  if not rule or type(IssueAbility)~='function'or not d.controlled or not d.ready or hunker(actor,d)and not name:lower():find('hunker',1,true)then return false end
  self.abilityPending=self.abilityPending or{};self.abilityCooldown=self.abilityCooldown or{}
  local key=tostring(actor:GetEntityId())..':'..name
  if self.abilityPending[key]or(self.abilityCooldown[key]or 0)>self.now or not rule.toggle and safe(function()return actor:IsUnitAbilityState(name,'Activated')end)then return false end
  local enabled=rule.initiallyEnabled
  if not enabled then for tech,definition in pairs(import('/lua/sim/Research.lua').ResearchDefinitions)do
   if self.brain:HasResearched(tech)and effective.Matches(d.flags,definition.CATS,d.id)then
    for _,ability in ipairs(definition.AbilityEnable or{})do if ability:lower()==name:lower()then enabled=true end end
   end
  end end
  if name=='BombBouncerMegaBlast'then enabled=actor.MegaBlastEnabled==true end
  if not enabled then return false end
  local resource=rule.activate or{};local amount=tonumber(resource.SourceAmount)or 0
  local currency=string.upper(resource.SourceType or'');local mass=currency=='MASS'and amount or 0;local energy=currency=='ENERGY'and amount or 0
  if self.mass<mass or self.energy<energy or not self:ReserveCalls(1)then return false end
  local ok=pcall(IssueAbility,{actor},position or actor:GetPosition(),name)
  if not ok then return false end
  self.mass=self.mass-mass;self.energy=self.energy-energy
  self.abilityPending[key]={expectedActive=not(safe(function()return actor:IsUnitAbilityState(name,'Activated')end)==true),actor=actor,name=name,at=self.now,origin=actor:GetPosition(),mass=mass,energy=energy,rule=rule}
  h.log(self,'ability-issued',{actor=tostring(actor:GetEntityId()),ability=name,reason=reason,evidence='submitted',reservedEnergy=energy})
  return true
 end
 function State:RefreshOperations()
  self.contactGrid=effective.Index(self.contacts);self.urgent=self.urgent or{};self.recovery=self.recovery or{};self.lastServed=self.lastServed or{}
  self.microHeld={};self.cicadaHeld={};self.criticalCommander=false
  local live={};for _,u in ipairs(self.own)do live[tostring(u:GetEntityId())]=u end
  for id in pairs(self.urgent)do if not live[id]then self.urgent[id]=nil end end
  for id in pairs(self.recovery)do if not live[id]then self.recovery[id]=nil end end
  for key,pending in pairs(self.abilityPending or{})do
   local actor=pending.actor;local id=tostring(actor:GetEntityId())
   local active=live[id]==actor and safe(function()return actor:IsUnitAbilityState(pending.name,'Activated')end)==true
   if pending.rule.toggle then active=live[id]==actor and(safe(function()return actor:IsUnitAbilityState(pending.name,'Activated')end)==true)==pending.expectedActive end
   if pending.name=='BombBouncerCharge'then active=live[id]==actor and actor.MegaBlastEnabled==true end
   if pending.name=='BombBouncerMegaBlast'then active=live[id]==actor and actor.MegaBlastEnabled==false end
   if active then
    self.abilityPending[key]=nil;self.abilityCooldown[key]=self.now+math.max(pending.rule.cooldown or 0,pending.rule.retrigger or 0)+(pending.rule.duration or 0)
    h.log(self,'ability-confirmed',{actor=id,ability=pending.name,evidence='observed-own-state'})
   elseif live[id]~=actor or self.now-pending.at>=3 then
    self.abilityPending[key]=nil;self.abilityCooldown[key]=self.now+3
    h.log(self,'ability-unconfirmed',{actor=id,ability=pending.name,reason=live[id]~=actor and'actor-lost'or'no-activation-observed'})
   end
  end
  local priorMembership={}
  for _,g in ipairs(self.groups or{})do for _,u in ipairs(g.units)do priorMembership[u]=g.id end end
  self.groups={}
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
   if mobile(d)and d.ready then
    local id=tostring(u:GetEntityId());local hp=health(u);local p=u:GetPosition()
    if hp<.3 and d.mass>=150 then self.recovery[id]=self.recovery[id]or{since=self.now}end
    if self.recovery[id]and hp>=.7 then self.recovery[id]=nil;h.log(self,'unit-rejoined',{actor=id,evidence='observed-health-recovery'})end
    if not self.recovery[id]and not self.teamAssigned[id]then
     local group,near
     for _,g in ipairs(self.groups)do local distance=frame.Distance(p,g.anchor)
      if g.layer==d.layer and distance<=48 and(not near or distance<near)then group=g;near=distance end
     end
     if not group and #self.groups<128 then group={id=id,anchor=p,layer=d.layer,units={},mass=0,ground=0,air=0};self.groups[#self.groups+1]=group end
     if group then
      group.units[#group.units+1]=u;local value=d.mass*hp*(d.halfBaked and .6 or 1);group.mass=group.mass+value
      if d.groundRange>0 or d.scripted=='pods'or d.scripted=='deploy-cannon'then group.ground=group.ground+value end
      if d.airRange>0 then group.air=group.air+value end
     end
    end
   end
  end
  local claimed={}
  for _,g in ipairs(self.groups)do
   local votes={};for _,u in ipairs(g.units)do local prior=priorMembership[u];if prior then votes[prior]=(votes[prior]or 0)+1 end end
   local best,score;for id,n in pairs(votes)do if not claimed[id]and(not score or n>score or n==score and id<best)then best=id;score=n end end
   if best then g.id=best end;claimed[g.id]=true
  end
 end
 function State:LocalSupport(actor,layer,seconds)
  local p=actor:GetPosition();local total=0
  for _,g in ipairs(self.groups or{})do if frame.Distance(g.anchor,p)<=75 then
   for _,u in ipairs(g.units)do local d=frame.Describe(u,self.productionCatalog);local range=effective.WeaponRange(d,layer or'Land',nil,nil,true)
    if range>0 and not self.recovery[tostring(u:GetEntityId())]then
     local arrival=math.max(0,frame.Distance(u:GetPosition(),p)-range)/math.max(.1,d.speed)
     if arrival<=(seconds or 6)then total=total+d.mass*health(u)*math.max(.25,1-arrival/math.max(1,seconds or 6))end
    end
   end
  end end
  return total
 end
 function State:DomainPressure()
  local incoming={Air=0,Land=0};local defense={Air=0,Land=0}
  for _,c in ipairs(effective.Query(self.contactGrid,self.map.ownStart,200,128))do local d=self.catalog[c.blueprint]
   if d and not d.scriptManaged then local strike=effective.WeaponRange(d,'Land',c.currentLayer or d.physicalLayer)
    strike=math.max(strike,d.scriptedRange or 0)
    if strike>0 and frame.Distance(c.position,self.map.ownStart)<=65+strike then local domain=(c.currentLayer or d.physicalLayer)=='Air'and'Air'or'Land';incoming[domain]=incoming[domain]+d.mass*(c.confidence or 1)end
   elseif not d and c.channel=='radar'and frame.Distance(c.position,self.map.ownStart)<85 then incoming.Land=incoming.Land+80*(c.confidence or 1)end
  end
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
   if d and d.ready then local distance=frame.Distance(u:GetPosition(),self.map.ownStart)
    local air=effective.WeaponRange(d,'Air',nil,nil,true);local ground=effective.WeaponRange(d,'Land',nil,nil,true)
    local airUseful=air>0 and math.max(0,distance-65-air)/math.max(.1,d.speed)<=10
    local groundUseful=ground>0 and math.max(0,distance-65-ground)/math.max(.1,d.speed)<=10
    local value=d.mass*health(u);local sum=incoming.Air+incoming.Land
    if airUseful and groundUseful and sum>0 then defense.Air=defense.Air+value*incoming.Air/sum;defense.Land=defense.Land+value*incoming.Land/sum
    elseif airUseful then defense.Air=defense.Air+value elseif groundUseful then defense.Land=defense.Land+value end
   end
  end
  return incoming,defense
 end
 function State:SafeRetreat(actor,d)
  local origin=actor:GetPosition();local layer=d.currentLayer or d.physicalLayer
  local function exposure(p)return effective.Exposure(p,effective.Query(self.contactGrid,p,200,96),self.catalog,layer)end
  local current=exposure(origin);local candidates={self.map.ownStart};local ranked={}
  for _,radius in ipairs({12,24,40})do for direction=0,7 do local angle=direction*math.pi/4;candidates[#candidates+1]=frame.Point(origin[1]+math.cos(angle)*radius,origin[3]+math.sin(angle)*radius)end end
  for _,p in ipairs(candidates)do
   if p[1]>2 and p[3]>2 and p[1]<self.map.width-2 and p[3]<self.map.height-2 then
    local danger=exposure(p);local routeDanger=0
    for step=1,3 do local f=step/3;routeDanger=math.max(routeDanger,exposure({origin[1]+(p[1]-origin[1])*f,origin[2],origin[3]+(p[3]-origin[3])*f}))end
    if danger<current or current==0 and danger==0 and p==self.map.ownStart then ranked[#ranked+1]={position=p,value=danger*100+routeDanger*20+frame.Distance(p,self.map.ownStart)*.1,routeDanger=routeDanger}end
   end
  end
  table.sort(ranked,function(a,b)return a.value<b.value end)
  for i=1,math.min(3,#ranked)do local row=ranked[i]
   if row.routeDanger<=current*1.15+10 and h.path(self,actor,row.position)==true then return row.position end
  end
 end
 function State:InformationNeed(position)
  position=position or self.operationTarget
  if not position then for _,site in ipairs(self.map.massSites)do if frame.Distance(site.position,self.map.ownStart)>35 and not self.scouted[site.id]then position=site.position;break end end end
  if not position then return false end
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
   if d and d.ready then
    local vision=safe(function()return u:GetIntelRadius('Vision')end)or d.visionRadius or 0
    local radar=safe(function()return u:GetIntelRadius('Radar')end)or 0
    if frame.Distance(u:GetPosition(),position)<=math.max(vision,radar)*.9 then return false end
   end
  end
  for _,c in ipairs(effective.Query(self.contactGrid,position,45,16))do if c.current and c.channel=='vision'and c.age<=2 then return false end end
  return true
 end
 function State:Special(actor,d,intent)
  if d.roles.commander and intent and intent.kind=='focus'and intent.target then
   local target=self.catalog[intent.target.blueprint];local value=0
   for _,c in ipairs(effective.Query(self.contactGrid,actor:GetPosition(),35,48))do local enemy=self.catalog[c.blueprint]
    if enemy and c.current and c.channel=='vision'and effective.WeaponRange(d,c.currentLayer or enemy.physicalLayer,nil,enemy.flags)>0 then value=value+enemy.mass end
   end
   if target and(target.roles.commander or value>=300)and self:Ability(actor,d,'Overcharge',nil,'funded-acu-firing-window')then return true end
  end
  if d.scripted=='deploy-cannon'then
   local active=safe(function()return actor:IsUnitAbilityState('Deploy','Activated')end)==true
   local nearby=effective.Query(self.contactGrid,actor:GetPosition(),110,96);local target
   local max,min=0,0;for _,w in ipairs(d.baseWeapons or d.weapons)do if w.maxRange>max then max=w.maxRange;min=w.minRange end end
   for _,c in ipairs(nearby)do local enemy=self.catalog[c.blueprint];local distance=frame.Distance(actor:GetPosition(),c.position)
    if enemy and c.current and c.channel=='vision'and enemy.physicalLayer~='Air'and distance>=min+3 and distance<=max*.95 then target=c;break end
   end
   if active and(intent and intent.kind=='withdraw'or not target)then return self:Ability(actor,d,'Deploy',nil,'pack-before-relocation')
   elseif not active and target then return self:Ability(actor,d,'Deploy',nil,'deploy-for-compatible-firing-window')end
   if self.abilityPending and self.abilityPending[tostring(actor:GetEntityId())..':Deploy']then return true end
   if active and not target then self.microHeld[actor]=true;return true end
  elseif d.scripted=='charged-blast'then
   local value=0;for _,c in ipairs(effective.Query(self.contactGrid,actor:GetPosition(),20,96))do local enemy=self.catalog[c.blueprint]
    if enemy and c.current and c.channel=='vision'and enemy.physicalLayer~='Air'then value=value+enemy.mass end
   end
   if value>=150 then
    if actor.MegaBlastEnabled then return self:Ability(actor,d,'BombBouncerMegaBlast',nil,'observed-close-army-blast')
    else return self:Ability(actor,d,'BombBouncerCharge',nil,'funded-close-army-blast')end
   end
  elseif d.scripted=='vortex'and intent and intent.target then return self:Ability(actor,d,'Pullinsmash',intent.target.position,'observed-vortex-control-target')end
  return false
 end
 function State:GroupMobility(actor,d,intent)
  if not intent or not(intent.kind=='withdraw'or intent.target)then return false end
  local position=intent.position or intent.target.position;local origin=actor:GetPosition();local distance=frame.Distance(origin,position)
  if distance<25 then return false end
  local general=actor:GetBlueprint().General or{};local choices={{cap='RULEUCC_Teleport',range='GetTeleportRange',issue=IssueTeleport,cooldown=general.TeleportCooldown or 20},{cap='RULEUCC_Jump',range='GetJumpRange',issue=IssueJump,cooldown=general.JumpCooldown or 20}}
  self.mobilityAt=self.mobilityAt or{}
  for _,choice in ipairs(choices)do
   if type(choice.issue)=='function'and type(actor[choice.range])=='function'and effective.Command(actor,d,choice.cap)and self.now-(self.mobilityAt[actor]or-100)>=choice.cooldown then
    local range=actor[choice.range](actor);local cost=general.MoveEnergyCost
    if type(range)=='number'and type(cost)=='number'and cost>=0 and self.energy>=cost+150 then
     local step=math.min(range*.8,distance);local p=frame.Point(origin[1]+(position[1]-origin[1])/distance*step,origin[3]+(position[3]-origin[3])/distance*step)
     local contacts=effective.Query(self.contactGrid,p,200,96)
     local danger=effective.Exposure(p,contacts,self.catalog,d.currentLayer or d.physicalLayer)
     local before=effective.Exposure(origin,contacts,self.catalog,d.currentLayer or d.physicalLayer)
     local support=self:LocalSupport(actor,'Land',6)
     if p[1]>2 and p[3]>2 and p[1]<self.map.width-2 and p[3]<self.map.height-2 and GetSurfaceHeight(p[1],p[3])<=GetTerrainHeight(p[1],p[3])+.5 and danger<=before and(intent.kind=='withdraw'or support>=math.max(160,danger*1.4))then
      local members={actor};local costs=cost
      if not d.roles.commander and not d.roles.engineer then
       local maxMembers=math.min(4,math.max(1,math.floor(self.profile.ordersPerSecond*self.profile.decisionSeconds-self.orders-2)))
       for _,group in ipairs(self.groups or{})do
        local contains=false;for _,u in ipairs(group.units)do if u==actor then contains=true end end
        if contains then for _,u in ipairs(group.units)do local ud=frame.Describe(u,self.productionCatalog)
         if u~=actor and #members<maxMembers and self:ReserveCalls(#members+3,true)and effective.Command(u,ud,choice.cap)and type(u[choice.range])=='function'and frame.Distance(u:GetPosition(),p)<=u[choice.range](u)*.9 and self.now-(self.mobilityAt[u]or-100)>=choice.cooldown then
          local price=(u:GetBlueprint().General or{}).MoveEnergyCost
          if type(price)=='number'and self.energy>=costs+price+150 then members[#members+1]=u;costs=costs+price end
         end
        end end
       end
      end
      -- Offensive paid movement needs a funded local group; emergency escape can be solo.
      if(intent.kind=='withdraw'or #members>=2)and self.tasks:ReplaceGroup(members,p,'paid-coordinated-'..choice.cap,self.now,choice.issue)then
       self.energy=self.energy-costs;self.groupMoveUntil=self.groupMoveUntil or{}
       for _,u in ipairs(members)do self.mobilityAt[u]=self.now;self.microHeld[u]=true;self.groupMoveUntil[u]=self.now+2 end
       h.log(self,'group-mobility-issued',{ability=choice.cap,units=#members,energy=costs,evidence='submitted'})
       return true
      end
     end
    end
   end
  end
  -- Afterburn uses its loaded per-unit ability cost, never a Titan production goal.
  if effective.Command(actor,d,'RULEUCC_Move')and(d.groundRange>0 or d.airRange>0)then
   for name in pairs(d.abilityRules or{})do if name:lower():find('speedoverdrive',1,true)then
    if self:Ability(actor,d,name,nil,intent.kind=='withdraw'and'afterburn-safe-withdrawal'or'afterburn-group-arrival')then return true end
   end end
  end
  return false
 end
 function State:Micro()
  local jobs={};local allocated={};local live={};self.microTargets=self.microTargets or{}
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
   if d and d.controlled and d.ready and(d.mobile or d.roles.commander)and not d.roles.scout and not d.roles.reclaimer then
    local id=tostring(u:GetEntityId());live[id]=u
    local contacts=effective.Query(self.contactGrid,u:GetPosition(),100,1)
    local current=self.tasks:Current(u);local hp=health(u)
    local damaged=self.ownHealth and self.ownHealth[id]and hp<self.ownHealth[id]-.02
    local engaged=#contacts>0 or current and current.kind=='attack'or hunker(u,d)
    local urgent=d.roles.commander and(damaged or hp<.6 and engaged)or self.recovery[id]~=nil
    if urgent or engaged or self.urgent[id]then
     local old=self.urgent[id]or{since=self.now,deadline=self.now+(d.roles.commander and .5 or 2)}
     old.actor=u;old.description=d;old.priority=(d.roles.commander and urgent and 10000 or d.roles.engineer and engaged and 8000 or urgent and 7000 or 3000)+math.min(2000,(self.now-old.since)*100)
     self.urgent[id]=old;jobs[#jobs+1]=old
     if d.roles.commander and urgent then self.criticalCommander=true end
    end
   end
  end
  self.ownHealth={};for id,u in pairs(live)do self.ownHealth[id]=health(u)end
  table.sort(jobs,function(a,b)return a.priority>b.priority or a.priority==b.priority and tostring(a.actor:GetEntityId())<tostring(b.actor:GetEntityId())end)
  local work=0
  for _,job in ipairs(jobs)do
   if work>=24 or not self:ReserveCalls(1,true)then break end;work=work+1
   local actor,d=job.actor,job.description;local id=tostring(actor:GetEntityId());local p=actor:GetPosition()
   local contacts=effective.Query(self.contactGrid,p,200,96)
   local intent=tactics.Decide({description=d,position=p,health=health(actor),home=self.map.ownStart,localSupport=self:LocalSupport(actor,d.physicalLayer=='Air'and'Air'or'Land',6)},contacts,self.catalog,allocated)
   if self.recovery[id]then intent={kind='withdraw',position=self.map.ownStart,reason='damaged-valuable-unit-recovery'}end
   if d.roles.commander or d.roles.engineer then
    local danger=effective.Exposure(p,contacts,self.catalog,d.currentLayer or d.physicalLayer)
    if danger>0 and(health(actor)<.65 or d.roles.engineer or danger>self:LocalSupport(actor,'Land',5)+180)then intent={kind='withdraw',position=self.map.ownStart,reason=d.roles.commander and'urgent-acu-survival'or'urgent-builder-survival'}end
   end
   local current=self.tasks:Current(actor);local committed=false;local held=false
   if hunker(actor,d)then
    if health(actor)>=.6 and effective.Exposure(p,contacts,self.catalog,d.currentLayer or d.physicalLayer)==0 then
     for name in pairs(d.abilityRules or{})do if name:lower():find('hunker',1,true)then committed=self:Ability(actor,d,name,nil,'safe-acu-hunker-release');break end end
    end
    held=true
   elseif self.groupMoveUntil and(self.groupMoveUntil[actor]or 0)>self.now then held=true
   elseif self:Special(actor,d,intent)then held=true;committed=true
   elseif intent then
    if intent.kind=='withdraw'or intent.kind=='kite'then
     if effective.Command(actor,d,'RULEUCC_Move')then
      local retreat=self:SafeRetreat(actor,d)
      if retreat then
       intent.position=retreat
       if current and current.kind=='move'and current.position and frame.Distance(current.position,retreat)<6 and self.now-current.lastProgress<10 then held=true
       elseif self:GroupMobility(actor,d,intent)then committed=true
       else committed=self.tasks:Replace(actor,'move',nil,retreat,intent.reason,self.now,function()IssueMove({actor},retreat)end)end
      elseif d.roles.commander then
       -- Hunker is a deliberate last resort; while active no move/repair plan is issued.
       for name in pairs(d.abilityRules or{})do if name:lower():find('hunker',1,true)and self:Ability(actor,d,name,nil,'acu-no-safer-reachable-escape')then committed=true;break end end
      end
     end
    elseif intent.kind=='focus'and effective.Command(actor,d,'RULEUCC_Attack')then
     local target=self.targets[intent.target.id]
     local same=current and current.kind=='attack'and self.microTargets[actor]==intent.target.id
     local firing=safe(function()return actor:IsUnitState('Firing')end)==true
     local settling=current and current.kind=='attack'and self.now-current.started<2
     local launched=self.launches and self.launches[id];if launched and self.now-launched.at<.75 then firing=true end
     if same or firing or settling then held=true
     elseif target and self:GroupMobility(actor,d,intent)then committed=true
     elseif target then
      local enemy=self.catalog[intent.target.blueprint];local range=effective.WeaponRange(d,intent.target.currentLayer or enemy.physicalLayer,nil,enemy.flags,true)
      local observer=frame.CombatObserver(self.army,target,intent.target.id,function()return self.combatReads end,actor,range)
      committed=self.tasks:Replace(actor,'attack',nil,intent.target.position,intent.reason,self.now,function()IssueAttack({actor},target)end,observer)
      if committed then self.microTargets[actor]=intent.target.id end
     end
    end
   end
   if held or committed then
    self.microHeld[actor]=true;self.urgent[id]=nil;self.lastServed[id]=self.now
    if committed then h.log(self,'urgent-serviced',{actor=id,wait=self.now-job.since,deadline=job.deadline,reason=intent and intent.reason or'special-state',nativeCalls=self.orders})end
   elseif self.now>=job.deadline and self.now-(job.reported or-100)>=5 then job.reported=self.now;h.log(self,'urgent-deferred',{actor=id,wait=self.now-job.since,reason='budget-path-state-or-legality'})end
  end
  self.microWork=work
 end
 function State:FighterCover(position,seconds,operation)
  self.coverReservations=self.coverReservations or{};local mass=0;local key=operation or math.floor(position[1]/48)..':'..math.floor(position[3]/48)
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog or self.catalog)
   if mobile(d)and d.physicalLayer=='Air'and d.airRange>0 and d.ready and health(u)>=.35 then
    local id=tostring(u:GetEntityId());local previous=self.coverReservations[id];local task=self.tasks:Current(u)
    local compatible=not previous or previous.untilTime<=self.now or previous.key==key or frame.Distance(previous.position,position)<=35
    local mission=not task or not task.position or frame.Distance(task.position,position)<=d.airRange+d.speed*(seconds or 15)
    local arrival=math.max(0,frame.Distance(u:GetPosition(),position)-d.airRange)/math.max(.1,d.speed)
    if compatible and mission and arrival<=(seconds or 15)then mass=mass+d.mass*health(u);self.coverReservations[id]={key=key,position=position,untilTime=self.now+5}end
   end
  end
  return mass
 end
 function State:CicadaSupport()
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
   if d and d.flags.SNEAKOTRON and d.ready then
    local target,near
    for _,v in ipairs(self.own)do local vd=frame.Describe(v,self.productionCatalog)
     if vd and vd.flags.MEGALITHII and vd.ready then local distance=frame.Distance(u:GetPosition(),v:GetPosition());if not near or distance<near then target=v;near=distance end end
    end
    if target then
     self.cicadaHeld[u]=true;local radius=(u:GetBlueprint().Intel or{}).CloakFieldRadius or 0
     if radius>0 and near<=radius*.8 then self:Ability(u,d,'StealthField',nil,'protect-owned-experimental')
     elseif near>math.max(10,radius*.55)and not self.tasks:Busy(u,self.now)and effective.Command(u,d,'RULEUCC_Move')and h.path(self,u,target:GetPosition())==true then h.submit(self,u,'move',nil,target:GetPosition(),'local-cicada-escort',function()IssueMove({u},target:GetPosition())end)end
    end
   end
  end
 end
 function State:FactoryAddon(factory)
  local fd=frame.Describe(factory,self.productionCatalog);if not fd or not fd.roles.producer then return false end
  local incoming,defense=self:DomainPressure();local atHome=frame.Distance(factory:GetPosition(),self.map.ownStart)<85
  local intelGap=self:InformationNeed(factory:GetPosition());local choice,quote,score
  for _,id in ipairs(self.catalogIds)do local d=self.productionCatalog[id]
   if d.roles.module then local q=frame.Quote(factory,d)
    if q and q.mass<=self.mass and q.energy<=self.energy and self.tasks:Pending(id)==0 then
     local existing=false
     for _,owned in ipairs(self.own)do if string.lower(owned:GetBlueprint().BlueprintId)==id then
      local parent=safe(function()return owned:GetParent()end)
      if parent==factory or not parent and frame.Distance(owned:GetPosition(),factory:GetPosition())<10 then existing=true;break end
     end end
     local value=0
     if d.airRange>0 and atHome and incoming.Air>defense.Air then value=100+incoming.Air-defense.Air end
     if d.roles.shield and(health(factory)<.8 or self.siegePosition and frame.Distance(factory:GetPosition(),self.siegePosition.position)<65)then value=80 end
     if(d.tacticalLaunchRange or 0)>0 and self.siegePosition and frame.Distance(factory:GetPosition(),self.siegePosition.position)<65 then value=60 end
     if d.roles.radar and intelGap then value=50 end
     if not existing and value>0 and(not score or value/q.mass>score)then choice=d;quote=q;score=value/q.mass end
    end
   end
  end
  if choice and h.submit(self,factory,'produce',choice.id,nil,'paid-contextual-factory-module',function()IssueBuildFactory({factory},choice.id,1)end)then self.mass=self.mass-quote.mass;self.energy=self.energy-quote.energy;return true end
  return false
 end
 local previousRepair=State.Repair
 function State:Repair(actor)
  local ad=frame.Describe(actor,self.productionCatalog)
  if not effective.Command(actor,ad,'RULEUCC_Repair')or hunker(actor,ad)then return false end
  local choice,score
  for _,target in ipairs(self.own)do local d=frame.Describe(target,self.productionCatalog)
   if d and target~=actor and(d.mass>=150 or d.roles.commander or d.structure)and target:GetFractionComplete()>=1 and health(target)<.8 and not hunker(target,d)and frame.Distance(actor:GetPosition(),target:GetPosition())<65 and not self:RepairAssigned(target)then
    local danger=effective.Exposure(target:GetPosition(),effective.Query(self.contactGrid,target:GetPosition(),200,96),self.catalog,d.currentLayer or d.physicalLayer)
    local value=d.mass*(1-health(target))/(1+frame.Distance(actor:GetPosition(),target:GetPosition()))
    if danger==0 and(not score or value>score)and h.path(self,actor,target:GetPosition())==true then choice=target;score=value end
   end
  end
  if choice then
   local last=choice:GetHealth();local key=tostring(choice:GetEntityId())
   local function observe()
    if choice:IsDead()or choice:GetArmy()~=self.army then return'failed',{cause='repair-target-lost'}end
    if health(choice)>=.95 then return'completed',{entity=key}end
    local hp=choice:GetHealth();if hp>last+.01 then last=hp;return'progress',{entity=key,health=hp}end
   end
   if h.submit(self,actor,'repair',nil,choice:GetPosition(),'recover-damaged-owned-asset',function()IssueRepair({actor},choice)end,observe)then self:LeaseRepair(choice,actor);return true end
  end
  return previousRepair(self,actor)
 end
 function State:StrategicRecall()
  -- Preserve missions until an executable local replacement is affordable.
  self.recall=self.plan and self.plan.emergency or false
 end
 function State:Forces()
  self.groupObjectives=self.groupObjectives or{};self.wreckObjective=nil
  local pressure=(({easy=350,normal=260,hard=200,reforger=150})[self.profile.level]or 260)*(self.plan and self.plan.pressureMultiplier or 1)
  for _,group in ipairs(self.groups)do
   local destination,chosen,reason;local contacts=effective.Query(self.contactGrid,group.anchor,220,128);local score
   for _,c in ipairs(contacts)do local enemy=self.catalog[c.blueprint]
    local compatible=false
    if enemy then for _,u in ipairs(group.units)do local ud=frame.Describe(u,self.productionCatalog)
     if effective.WeaponRange(ud,c.currentLayer or enemy.physicalLayer,nil,enemy.flags)>0 then compatible=true;break end
    end end
    if enemy and compatible and not enemy.scriptManaged and c.confidence>.3 then
     local home=frame.Distance(c.position,self.map.ownStart)<65
     local threat=effective.Exposure(c.position,contacts,self.catalog,group.layer=='air'and'Air'or group.layer=='naval'and'Water'or'Land')
     local value=(home and 100000 or enemy.roles.economy and 2000 or enemy.roles.factory and 1500 or 500)*c.confidence/(1+frame.Distance(c.position,group.anchor))
     if(home or group.ground>=pressure and group.mass>=threat*1.4)and(not score or value>score)then destination=c.position;chosen=c;score=value;reason=home and'defend-local-owned-economy'or'local-group-pressure'end
    end
   end
   local field=not self.recall and h.contestedField(self,group.mass,group.units)
   if field and not chosen and group.ground>=pressure then destination=field.position;reason='secure-known-wreckfield-before-engineers';self.wreckObjective=field end
   if self.recall then destination=self.map.ownStart;reason='local-survival-reserve';chosen=nil
   elseif not destination and group.ground>=pressure then
    local oldest
    for _,site in ipairs(self.map.candidateStarts)do local at=self.scouted[site.id]or-100
     if not oldest or at<oldest then destination=site.position;oldest=at;reason='local-group-public-approach-recon'end
    end
   end
   if destination then
    self.groupObjectives[group.id]={position=destination,reason=reason,at=self.now};self.operationTarget=destination
    for _,u in ipairs(group.units)do local d=frame.Describe(u,self.productionCatalog);local id=tostring(u:GetEntityId())
     if not self.microHeld[u]and not self.cicadaHeld[u]and not self.teamAssigned[id]and not self.recovery[id]and not self.tasks:Busy(u,self.now)and effective.Command(u,d,'RULEUCC_Move')and frame.Distance(u:GetPosition(),destination)>10 then
      local dangerous=effective.Exposure(destination,contacts,self.catalog,d.currentLayer or d.physicalLayer)
      local moveTo=destination;local reachable=h.path(self,u,moveTo)
      if reachable~=true and chosen and d.physicalLayer=='Water'then
       local range,min=effective.WeaponRange(d,chosen.currentLayer or self.catalog[chosen.blueprint].physicalLayer,nil,self.catalog[chosen.blueprint].flags)
       for i=0,7 do local angle=i*math.pi/4;local radius=math.max(min+3,range*.8);local p=frame.Point(destination[1]+math.cos(angle)*radius,destination[3]+math.sin(angle)*radius)
        if range>0 and p[1]>2 and p[3]>2 and p[1]<self.map.width-2 and p[3]<self.map.height-2 and GetSurfaceHeight(p[1],p[3])>GetTerrainHeight(p[1],p[3])+.5 and h.path(self,u,p)==true then moveTo=p;reachable=true;break end
       end
      end
      if(group.mass>=dangerous*1.4 or self.recall)and reachable==true then
       local target=chosen and chosen.current and chosen.channel=='vision'and self.targets[chosen.id]
       if moveTo~=destination then h.submit(self,u,'move',nil,moveTo,'reach-compatible-water-firing-position',function()IssueMove({u},moveTo)end)
       elseif target and effective.Command(u,d,'RULEUCC_Attack')then
        local range=effective.WeaponRange(d,chosen.currentLayer or self.catalog[chosen.blueprint].physicalLayer,nil,self.catalog[chosen.blueprint].flags,true)
        if range>0 then local observer=frame.CombatObserver(self.army,target,chosen.id,function()return self.combatReads end,u,range);h.submit(self,u,'attack',nil,destination,reason,function()IssueAttack({u},target)end,observer)end
       else h.submit(self,u,'advance',nil,destination,reason,function()if effective.Command(u,d,'RULEUCC_Attack')then IssueAggressiveMove({u},destination)else IssueMove({u},destination)end end)end
      end
     end
    end
   end
  end
  -- Scouts refresh a useful approach/expansion, using their own navigator.
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
   if d and d.roles.scout and d.controlled and d.ready and not self.tasks:Busy(u,self.now)and effective.Command(u,d,'RULEUCC_Move')then
    local candidates={};for _,site in ipairs(self.map.massSites)do candidates[#candidates+1]=site end;for _,site in ipairs(self.map.candidateStarts)do candidates[#candidates+1]=site end
    table.sort(candidates,function(a,b)return(self.scouted[a.id]or-100)<(self.scouted[b.id]or-100)or(self.scouted[a.id]or-100)==(self.scouted[b.id]or-100)and a.id<b.id end)
    for i=1,math.min(16,#candidates)do local site=candidates[i]
     if frame.Distance(u:GetPosition(),site.position)<12 then self.scouted[site.id]=self.now
     elseif self:InformationNeed(site.position)and effective.Exposure(site.position,effective.Query(self.contactGrid,site.position,200,96),self.catalog,d.physicalLayer)==0 and h.path(self,u,site.position)==true then
      h.submit(self,u,'move',nil,site.position,'scout-relevant-approach-or-expansion',function()IssueMove({u},site.position)end);break
     end
    end
   end
  end
 end
 function State:NavalBootstrap(actor)
  if self.now<90 or not self.map.terrain or self.map.terrain.waterFraction<.2 or h.count(self,'factory')<1 or self.mass<300 or self.energy<500 then return false end
  local existing=false
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.catalog);if d and d.roles.factory and d.outputs and d.outputs.naval then existing=true end end
  if existing then return false end
  local naval,quote=h.buildable(self,actor,function(d)return d.roles.factory and not d.roles.gantry and d.outputs and d.outputs.naval end)
  if not naval or not quote or quote.mass>self.mass or quote.energy>self.energy or self.tasks:Pending(naval.id)>0 then return false end
  local candidates={}
  for _,cell in pairs(self.topology.cells or{})do if cell.wet and frame.Distance(actor:GetPosition(),cell.p)<=150 then candidates[#candidates+1]=cell end end
  table.sort(candidates,function(a,b)local da,db=frame.Distance(a.p,actor:GetPosition()),frame.Distance(b.p,actor:GetPosition());return da<db or da==db and a.id<b.id end)
  for i=1,math.min(16,#candidates)do
   local site=h.placement(self,actor,naval,candidates[i].p,160,false)
   if site then
    self.navalOpportunity={position=site,at=self.now,provenance='native-legal-coastal-construction'}
    if h.build(self,actor,naval,site,'paid-coastal-naval-bootstrap')then return true end
   end
  end
  return false
 end
 function State:RetailConversion()
  for _,u in ipairs(self.own)do local d=frame.Describe(u,self.productionCatalog)
   if d and d.roles.converter and not d.passiveConverterEnergy and d.ready then
    for name,rule in pairs(d.abilityRules or{})do if name:lower()=='convertenergy'then
     local amount=tonumber((rule.activate or{}).SourceAmount)or 0
     if amount>0 and self.mass<200 and self.energy>amount+math.max(500,self.powerBankTarget or 0)then self:Ability(u,d,name,nil,'retail-surplus-energy-conversion')end
    end end
   end
  end
 end

end
