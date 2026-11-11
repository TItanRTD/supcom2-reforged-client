passed=0
local function check(value,message)assert(value,message);passed=passed+1 end
local catalog=import('/lua/system/reforged_ai_catalog.lua')
local effective=import('/lua/sim/reforged_ai_effective.lua')
local planning=import('/lua/sim/reforged_ai_planning.lua')
local tasks=import('/lua/sim/reforged_ai_tasks.lua')
local frame=import('/lua/sim/reforged_ai_frame.lua')
local operations=import('/lua/sim/reforged_ai_operations.lua')
local trace={events={}}
function trace:Event(_,event,fields)self.events[#self.events+1]={event=event,fields=fields}end
local function bp(id,weapons,categories)
 return{BlueprintId=id,Categories=categories or{'UEF','MOBILE','LAND','SELECTABLE'},Economy={MassValue=100,EnergyValue=100},General={CommandCaps={RULEUCC_Move=true,RULEUCC_Attack=true,RULEUCC_Repair=true}},Weapons=weapons or{},Physics={MaxSpeed=4}}
end
local function weapon(label,range,layers,extra)
 local w={Label=label,Damage=10,MaxRadius=range,RateOfFire=1,FireTargetLayerCaps=layers or{Land='Land'}}
 for k,v in pairs(extra or{})do w[k]=v end;return w
end
local plain=bp('testtank',{weapon('Main',20)})
local description=assert(catalog.Describe(plain))
local mixed=assert(catalog.Describe(bp('mixed',{weapon('Intercept',60,{Land='Air'},{TargetType='RULEWTT_Projectile',TargetRestrictOnlyAllow='TACTICAL MISSILE'}),weapon('AA',25,{Land='Air'})},{'UEF','MOBILE','LAND','SELECTABLE','TACTICALMISSILEDEFENSE'})))
check(mixed.airRange==25 and mixed.tacticalInterceptRange==60,'Projectile interception must not mask real AA')
local intercept=assert(catalog.Describe(bp('pureinterceptor',{weapon('Intercept',60,{Land='Air'},{TargetType='RULEWTT_Projectile',TargetRestrictOnlyAllow='TACTICAL MISSILE'})})))
check(intercept.airRange==0 and not intercept.roles.aa,'Projectile-only weapon is not aircraft defense')
local water=assert(catalog.Describe(bp('mixedlayers',{weapon('LandGun',20,{Land='Land'}),weapon('Torpedo',45,{Water='Water|Sub|Seabed'})})))
check(effective.WeaponRange(water,'Land','Land')==20,'Water-only torpedo must not extend land range')
check(effective.WeaponRange(water,'Sub','Water')==45,'Underwater target compatibility retained')
local siege=assert(catalog.Describe(bp('siege',{weapon('Main',90,{Land='Land'},{MinRadius=30})})))
check(not effective.CanHit(siege,description,10,true),'Minimum range is enforced')
local b=Brain();b.researched.RANGE=true
local upgraded=effective.Researched(description,b,{RANGE={CATS='UEF MOBILE LAND',Buffs={'R'}}},{R={Affects={WeaponRange={Mult=.15}}}})
check(math.abs(upgraded.groundRange-23)<.00001,'Earned range applied to production capability')
upgraded.baseWeapons=description.weapons
local unit=Unit(1,plain,b);unit.Buffs={Affects={WeaponRange={R={Count=1,Mult=.15}}}}
check(math.abs(effective.Owned(upgraded,unit,b).weapons[1].maxRange-23)<.00001,'Owned buff applied once, not twice')
unit.states.Stunned=true
check(not effective.Owned(description,unit,b).ready,'Stunned early-release unit is not ready')
unit.states.Stunned=false;unit.HalfBakeThread={}
check(effective.Owned(description,unit,b).halfBaked,'Half-Bake instability remains explicit')
unit.capsDisabled=true
check(not effective.Command(unit,description,'RULEUCC_Attack'),'Current command restrictions override blueprint capability')
unit.capsDisabled=false
local contacts={}
for i=1,100 do contacts[#contacts+1]={id=tostring(i),position={200+i,0,200},channel='vision',current=true,age=0,confidence=1,blueprint='testtank'}end
contacts[#contacts+1]={id='nearby',position={21,0,20},channel='vision',current=true,age=0,confidence=1,blueprint='testtank'}
check(effective.Local(contacts,{20,0,20},96)[1].id=='nearby','Nearby contact survives prefix cap')
check(effective.Query(effective.Index(contacts),{20,0,20},100,1)[1].id=='nearby','Spatial query selects relevant contact before cap')
local task=tasks.Create(trace,1,10);b.units={unit};unit.HalfBakeThread=nil
local allowance=10
local function budget(n,checkOnly)if n>allowance then return false end;if not checkOnly then allowance=allowance-n end;return true end
task:SetBudget(budget)
check(task:Submit(unit,'move',nil,{30,0,20},'initial',0,function()IssueMove({unit},{30,0,20})end),'Initial task accepted')
local old=task:Current(unit).id;allowance=0;local clears=nativeCalls.clear
check(not task:Replace(unit,'move',nil,{40,0,20},'urgent',.1,function()IssueMove({unit},{40,0,20})end),'Replacement defers when budget is unavailable')
check(task:Current(unit).id==old and nativeCalls.clear==clears and unit.order.position[1]==30,'Budget deferral preserves executable order')
allowance=10
check(task:Replace(unit,'move',nil,{40,0,20},'urgent',.1,function()IssueMove({unit},{40,0,20})end),'Recent command cooldown does not strand replacement')
check(unit.order.position[1]==40 and task:Current(unit).id~=old,'Replacement commits clear and new task')
allowance=10
check(not task:Replace(unit,'move',nil,{50,0,20},'failed-adapter',.2,function()error('rejected adapter')end),'Throwing adapter is reported')
check(unit.order.position[1]==40,'Previous executable work restored on adapter failure')
local a=Unit(10,plain,b),Unit(11,plain,b)
local c=Unit(11,plain,b)
b.units={a,c};local production=tasks.Create(trace,1,10)
check(production:Submit(a,'produce','testtank',nil,'factory-a',0,function()end),'Producer A task')
check(production:Submit(c,'produce','testtank',nil,'factory-b',0,function()end),'Producer B task')
local child=Unit(12,plain,b,{21,0,20});child.fraction=.5;c.child=child;b.units={a,c,child}
production:Step(1,b.units)
check(production:Pending('testtank')==1,'Authoritative child assigned to its actual producer before fallback')
check(production:Current(a)~=nil and production:Current(c)~=nil,'Unfinished job remains observed')
child.fraction=1;production:Step(2,b.units)
check(production:Current(c)==nil and production:Current(a)~=nil,'Other producer cannot claim the authoritative child')
local chain=assert(planning.ResearchPath('ILA_TELEPORT',researchData,Brain()))
check(chain.points==17,'Teleport follows the cheaper legal alternative prerequisite path')
local owned=Brain();owned.researched.ILB_CHROMEHEALTH=true
local earned=assert(planning.ResearchPath('ILA_TELEPORT',researchData,owned))
check(earned.points==8,'Owned alternative unlock removes remaining route cost')
local alternate=assert(planning.ResearchPath('GOAL',{GOAL={COST=1,PREREQUISITES='CYCLE,LEGAL'},CYCLE={COST=1,PREREQUISITES='GOAL'},LEGAL={COST=2}},Brain()))
check(alternate.points==3,'Cyclic alternative does not block an independently legal branch')
local team=import('/lua/sim/reforged_ai_teamplay.lua')
local request={id='request',owner=3,position={20,0,20},needed=100,deadline=25,expires=8}
local helper=team.SelectRequest(2,{availableGround=500,readyGround=500},{{army=1,availableGround=0,readyGround=500},{army=3,request=request}},0)
check(helper and helper.id=='request','Busy lower-ID ally cannot block a free helper')
local knowledge=import('/lua/sim/reforged_ai_knowledge.lua');local memory=knowledge.Create(256,256,128)
memory:Observe({id='42',channel='vision',position={20,0,20},blueprint='testtank',layer='Land'},0)
check(memory:Associate('42','radar-77',0),'Recon identity association is learned during vision')
memory:Observe({id='radar-77',channel='radar',position={21,0,20}},1)
local snapshot=memory:Snapshot(1)
check(#snapshot==1 and snapshot[1].id=='42' and snapshot[1].health==nil,'Vision-to-radar does not duplicate threat or reveal health')
memory:Observe({id='42',channel='vision',event='no-longer-hostile'},2)
check(#memory:Snapshot(2)==0,'Visible ownership change removes stale hostility')
local State={};local helpers={path=function()return true end,log=function()end,submit=function()return false end,contestedField=function()end,count=function()return 0 end}
operations.Attach(State,helpers)
local function state(own,catalogue,enemy)
 local brain=Brain();brain.units=own;for _,u in ipairs(own)do u.brain=brain end
 local self=setmetatable({targets={},brain=brain,army=1,profile={ordersPerSecond=12,decisionSeconds=.5,level='reforger'},orders=0,now=0,own=own,catalog=catalogue,productionCatalog=catalogue,
  contacts=enemy or{},map={ownStart={20,0,20},width=256,height=256,massSites={},candidateStarts={}},teamAssigned={},scouted={},tasks=tasks.Create(trace,1,10)}, {__index=State})
 frame.PrepareOwn(own,brain);self:RefreshOperations();self.tasks:SetBudget(function(n,checkOnly)return self:ReserveCalls(n,checkOnly)end)
 return self
end
local ground=bp('ground',{weapon('Gun',30)});ground.ReforgedAI=catalog.Describe(ground)
local aa=bp('aa',{weapon('AA',30,{Land='Air'})});aa.ReforgedAI=catalog.Describe(aa)
local bomber=bp('bomber',{weapon('Bomb',30,{Air='Land'})},{'UEF','MOBILE','AIR','SELECTABLE'});bomber.ReforgedAI=catalog.Describe(bomber)
local enemy={{id='enemy',position={35,0,20},blueprint='bomber',confidence=1,current=true,channel='vision',age=0}}
local units={};for i=1,10 do units[i]=Unit(i,ground,Brain())end
local cat={ground=ground.ReforgedAI,aa=aa.ReforgedAI,bomber=bomber.ReforgedAI}
local s=state(units,cat,enemy);local incoming,defense=s:DomainPressure()
check(incoming.Air>0 and defense.Air==0,'Ground-only tanks cannot satisfy bomber defense')
units={};for i=1,10 do units[i]=Unit(i,aa,Brain())end
s=state(units,cat,enemy);incoming,defense=s:DomainPressure()
check(defense.Air>0,'Pure AA provides bomber protection without a ground gun')
local cloakBP=all.Unit.ucx0104d1;local cloak=Unit(201,cloakBP,Brain())
local cloakCat={ucx0104d1=cloakBP.ReforgedAI}
s=state({cloak},cloakCat,{});s.mass=1000;s.energy=700
check(not s:Ability(cloak,frame.Describe(cloak,cloakCat),'StealthField',nil,'test'),'Cicada cannot activate below actual 1250 energy cost')
s.energy=1500
check(s:Ability(cloak,frame.Describe(cloak,cloakCat),'StealthField',nil,'test'),'Cicada funded activation submitted')
check(s.energy==250 and select(2,s:AbilityReserved())==1250,'Pending support activation reserves actual cost')
check(not s:Ability(cloak,frame.Describe(cloak,cloakCat),'StealthField',nil,'test'),'Pending activation cannot be submitted twice')
local wounded=Unit(301,all.Unit.uux0101,Brain());wounded.hp=10
s=state({wounded},{uux0101=all.Unit.uux0101.ReforgedAI},{})
check(s.recovery['301']~=nil and #s.groups==0,'Damaged Fatboy remains in recovery after arriving home')
wounded.hp=80;s.now=5;s:RefreshOperations()
check(s.recovery['301']==nil and #s.groups==1,'Recovered health allows deliberate rejoin')
local scoutBP=bp('recon',{}, {'CYBRAN','MOBILE','AIR','SELECTABLE'});scoutBP.Intel={RadarRadius=100};scoutBP.General.CommandCaps.RULEUCC_Attack=nil
check(catalog.Describe(scoutBP).roles.scout,'Recon purpose does not require SCOUT category')
local pod=bp('uix0116',{weapon('PodGun',30,{Air='Land'})},{'ILLUMINATE','MOBILE','AIR','SELECTABLE','INSIGNIFICANT'})
check(catalog.Describe(pod).scriptManaged and not catalog.Describe(pod).controlled,'Script-owned Wilfindja pod is not directly commanded')
local free=bp('freelegitimate',{weapon('Gun',20)});free.Economy.MassValue=0;free.Economy.EnergyValue=0
check(catalog.Describe(free).controlled,'Selectable zero-cost assets are retained')
-- Run the actual controller entry point and research ledger, not a duplicate model.
local controller=import('/lua/sim/reforged_ai_controller.lua');local brain=Brain()
local acu=Unit(500,all.Unit.uul0001,brain);brain.units={acu}
local controlled=controller.Create(brain)
controlled.now=0;controlled.orders=0;controlled.mass=5000;controlled.energy=10000
controlled.SelectResearch=function()return'ULB_RANGE','test','ULB_RANGE','funded'end
local purchased=0;controlled.ResearchPurchased=function(_,_,points)purchased=purchased+points end
controlled:ResearchStep()
check(controlled.researchTask~=nil and controlled.researchSpent==0 and purchased==0,'Submitted research does not count as confirmed spending')
controlled.now=31;controlled:ResearchStep()
check(controlled.researchTask==nil and controlled.researchSpent==0 and purchased==0,'Timed-out research does not inflate income or doctrine budget')
controlled.lastResearch=-100;controlled.now=40;controlled:ResearchStep();brain.researched.ULB_RANGE=true;controlled.now=41;controlled:ResearchStep()
check(controlled.researchSpent==(researchData.ULB_RANGE.COST or 0) and purchased==researchData.ULB_RANGE.COST,'Confirmed research accounts for exactly the active price')
brain=Brain();acu=Unit(600,all.Unit.uul0001,brain);brain.units={acu};controlled=controller.Create(brain)
for i=1,12 do SetClock(i);controlled:Step();check(controlled.orders<=6,'Controller native-call allowance remains bounded')end
check(controller.Validate(brain),'Normal income, vision and veterancy fairness readback retained')
-- Exercise actual native adapters in controlled combat, without hidden reads.
helpers.submit=function(self,actor,kind,id,p,reason,issue,observe)return self.tasks:Submit(actor,kind,id,p,reason,self.now,issue,observe)end
local attacker=Unit(700,ground,Brain());local hostile=Unit(701,ground,Brain(),{40,0,20});hostile.brain.army=2
local contact={id='701',position={40,0,20},blueprint='ground',confidence=1,current=true,channel='vision',age=0,health=1}
s=state({attacker},cat,{contact});s.targets['701']=hostile;s.combatReads={};s.phase='urgent-tactics'
s:Micro()
check(attacker.order and attacker.order.kind=='attack'and attacker.order.target==hostile,'Combat micro issues a compatible visible attack')
local oldTask=s.tasks:Current(attacker).id;local beforeClear=nativeCalls.clear
s.now=.5;s.orders=0;s:RefreshOperations();s:Micro()
check(s.tasks:Current(attacker).id==oldTask and nativeCalls.clear==beforeClear,'Active same-target engagement preserves aim and salvo')
s.orders=6;s.now=3;s.microTargets[attacker]=nil;s:RefreshOperations();s:Micro()
check(s.urgent['700']~=nil and s.tasks:Current(attacker).id==oldTask,'Unserviced urgent jobs survive budget exhaustion without losing current work')
s.orders=0;s.now=3.5;s:Micro()
check(s.urgent['700']==nil,'Deferred urgent combat is serviced on the following allowance')
local gun=bp('forwardpd',{weapon('Gun',25)},{'CYBRAN','STRUCTURE','DEFENSE','SELECTABLE'});gun.Economy.MassValue=500
local pd=catalog.Describe(gun);local exposed=Unit(702,ground,Brain(),{80,0,80})
s=state({exposed},{ground=ground.ReforgedAI,forwardpd=pd},{{id='a',blueprint='forwardpd',position={85,0,80},confidence=1,current=true,channel='vision',age=0},{id='b',blueprint='forwardpd',position={55,0,80},confidence=1,current=true,channel='vision',age=0}})
s.map.ownStart={55,0,80};local escape=s:SafeRetreat(exposed,frame.Describe(exposed,s.productionCatalog))
check(escape and frame.Distance(escape,{55,0,80})>20,'Retreat avoids the second known forward defense instead of blindly choosing home')
local slow=bp('slow',{weapon('AA',20,{Air='Air'})},{'UEF','MOBILE','AIR','SELECTABLE'});slow.Air={MaxAirspeed=1};slow.ReforgedAI=catalog.Describe(slow)
local fighter=Unit(703,slow,Brain(),{20,0,20});s=state({fighter},{slow=slow.ReforgedAI},{})
check(s:FighterCover({20,0,20},2,'west')>0 and s:FighterCover({150,0,150},2,'east')==0,'Local fighter cover cannot be reused for an incompatible distant operation')
-- Group movement batches one native clear and one paid command for eligible members.
local blink=bp('blink',{weapon('Gun',30)});blink.General.CommandCaps.RULEUCC_Teleport=true;blink.General.MoveEnergyCost=100;blink.General.TeleportRange=70;blink.ReforgedAI=catalog.Describe(blink)
local members={};for i=1,4 do members[i]=Unit(710+i,blink,Brain(),{20+i,0,20})end
s=state(members,{blink=blink.ReforgedAI},{});s.mass=500;s.energy=500;s.phase='urgent-tactics'
local c0,m0=nativeCalls.clear,nativeCalls.move
check(s:GroupMobility(members[1],frame.Describe(members[1],s.productionCatalog),{kind='focus',target={position={80,0,20}}}),'Funded local offensive teleport group is submitted')
check(nativeCalls.clear-c0==1 and nativeCalls.move-m0==1 and s.energy==200,'Group teleport batches calls and reserves all three eligible unit costs')
check(s.tasks:Current(members[1])and s.tasks:Current(members[3])and not s.tasks:Current(members[4]),'Unaffordable or over-budget member remains outside the paid group')
s=state(members,{blink=blink.ReforgedAI},{});s.mass=500;s.energy=200
check(not s:GroupMobility(members[1],frame.Describe(members[1],s.productionCatalog),{kind='focus',target={position={80,0,20}}}),'Unfunded solo offensive teleport is refused')
-- Delegate native projectile creation/impact exactly; telemetry is separate evidence.
local savedLaunches=0;local savedImpacts=0;local telemetry=0
local projectile={GetEntityId=function()return'900'end}
local delegate={CreateProjectileAtMuzzle=function(self,bone,flag)savedLaunches=savedLaunches+1;check(bone=='Muzzle'and flag==7,'Launch arguments delegated intact');return projectile end}
local env=setmetatable({DefaultProjectileWeapon=delegate},{__index=_G})
local launch=assert(loadstring(string.match(files['lua/sim/defaultweapons.lua'],'(local launch=DefaultProjectileWeapon.*)')));setfenv(launch,env);launch()
local owner=Brain();owner.ReforgedAIController={army=1,OnProjectileLaunch=function(_,u,label,id)check(u==attacker and label=='Gun'and id=='900','Actual returned own projectile is traced');telemetry=telemetry+1 end,OnProjectileImpact=function(_,id,kind)check(id=='900'and kind=='Terrain','Impact traced separately');telemetry=telemetry+1 end};attacker.brain=owner
check(delegate.CreateProjectileAtMuzzle({unit=attacker,GetBlueprint=function()return{Label='Gun'}end},'Muzzle',7)==projectile and savedLaunches==1,'Native projectile return identity preserved')
local trap=setmetatable({}, {__index=function()error('Hidden impact target inspected')end})
local class={OnImpact=function(self,kind,target,flag)savedImpacts=savedImpacts+1;check(kind=='Terrain'and target==trap and flag==8,'Impact arguments delegated intact');return'saved-result'end}
env=setmetatable({Projectile=class},{__index=_G});local impact=assert(loadstring(string.match(files['lua/sim/projectile.lua'],'(local impact=Projectile.*)')));setfenv(impact,env);impact()
check(class.OnImpact(projectile,'Terrain',trap,8)=='saved-result'and savedImpacts==1 and telemetry==2,'Impact delegate return is preserved without hidden target inspection')
-- Actual controller production must accept a native-legal foreign unit.
brain=Brain();local factory=Unit(800,all.Unit.uub0001,brain);factory.legal.ucl0103=true;brain.units={factory};controlled=controller.Create(brain)
controlled.now=0;controlled.orders=0;controlled.mass=5000;controlled.energy=10000;controlled.own={factory};controlled.contacts={};controlled.productionCatalog=frame.ResearchedCatalog(brain,controlled.catalog);controlled.plan={factoryLayer='land'};controlled.groups={}
controlled.WorkerProduction=function()return nil end;controlled.DeploymentProduction=function()return false end;controlled.FactoryAddon=function()return false end;controlled.FighterCover=function()return 0 end
frame.PrepareOwn(controlled.own,brain);controlled.tasks:SetBudget(function(n,checkOnly)return controlled:ReserveCalls(n,checkOnly)end)
local builds=nativeCalls.build;controlled:ProductionStep()
check(nativeCalls.build==builds+1 and controlled.tasks:Current(factory).blueprint=='ucl0103','Foreign producer uses actual native build permission rather than starting faction')
-- A temporary defensive task must not erase a durable allied commitment.
local director=import('/lua/sim/reforged_ai_director.lua');local D={};director.Attach(D,helpers)
local ally={id='help',owner=2,position={80,0,20},needed=50,deadline=30,expires=8};team.Publish(2,{request=ally},0)
local savedAlly=IsAlly;IsAlly=function(a,b)return a==b or a==1 and b==2 end
local helperUnit=Unit(810,ground,Brain());s=state({helperUnit},{ground=ground.ReforgedAI},{});s.plan={};s.teamDeclaration={availableGround=100};s.teamTasks={};s.teamKnown={}
s.teamCommitment={plan='help',owner=2,helper=1,unitIds={'810'},mass=100,needed=50,expires=5,deadline=30,position={80,0,20}};s.teamAssigned['810']=true;s.teamTasks['810']='old-mission-task'
s.tasks:Submit(helperUnit,'move',nil,{20,0,25},'temporary-local-defense',0,function()IssueMove({helperUnit},{20,0,25})end)
D.TeamWork(s)
check(s.teamCommitment and s.teamAssigned['810'],'Temporary tactical task replacement preserves allied mission identity')
IsAlly=savedAlly
local mixedMinimum=catalog.Describe(bp('mixedminimum',{weapon('Siege',90,nil,{MinRadius=30}),weapon('CloseGun',20)}))
check(effective.CanHit(mixedMinimum,description,10,true),'A close legal secondary gun remains usable inside another weapon minimum range')
local fast=effective.Researched(description,b,{SPEED={CATS='UEF MOBILE LAND',Buffs={'S'}}},{S={Affects={MoveSpeed={Mult=.25}}}});fast.baseSpeed=description.speed
local runner=Unit(820,plain,b);runner.Buffs={Affects={MoveSpeed={S={Count=1,Mult=.25}}}}
check(effective.Owned(fast,runner,b).speed==5,'Owned speed stacks use the selected base speed exactly once')
local survivors={Unit(830,ground,Brain()),Unit(831,ground,Brain()),Unit(832,ground,Brain())};s=state(survivors,cat,{})
local groupId=s.groups[1].id;s.own={survivors[2],survivors[3]};frame.PrepareOwn(s.own,s.brain);s:RefreshOperations()
check(s.groups[1].id==groupId,'Local group retains its mission identity when its first member is lost')
local observed=knowledge.Create(256,256,64);observed:Observe({id='42',channel='vision',position={20,0,20},blueprint='ground'},0);observed:Associate('42','radar-77',0)
local radar={IsSeenNow=function()return false end,IsOnRadar=function()return true end,GetPosition=function()return{21,0,20}end,GetEntityId=function()return'77'end}
local hidden=setmetatable({GetBlip=function()return radar end},{__index=function(_,key)error('Hidden source read: '..key)end})
brain=Brain();brain.enemies={hidden};local sensor=Unit(840,ground,brain)
local records,handles=frame.Observe(brain,{sensor},observed,cat,1,0,{})
check(#records==1 and records[1].id=='42'and records[1].channel=='radar'and records[1].current and records[1].health==nil,'Adapter preserves the canonical radar hypothesis without hidden reads or duplicate loss events')
local many=knowledge.Create(256,256,64);local retained={}
for i=1,20 do
 local id=tostring(i);local target=Unit(id,ground,Brain(),{40+i,0,20});target.brain.army=2
 function target:GetBlip()return{IsSeenNow=function()return true end,GetEntityId=function()return'blip-'..id end}end
 many:Observe({id=id,channel='vision',position=target:GetPosition(),blueprint='ground'},0);retained[id]=target
end
records,handles=frame.Observe(brain,{},many,cat,1,0,retained,{'9'})
local current=false;for _,record in ipairs(records)do if record.id=='9'then current=record.current end end
local retainedCount=0;for _ in pairs(handles)do retainedCount=retainedCount+1 end
check(current and retainedCount==20,'Engaged handle is refreshed ahead of the rotating cap while unsampled handles remain retained')
check(all.Unit.uix0115.ReforgedAI.scriptedRange==100 and all.Unit.uix0102.ReforgedAI.scriptedRange==32,'Scripted parents use selected dummy/body-aim envelopes without pod double counting')
-- Research admission participates in the same actual-call allowance.
brain=Brain();controlled=controller.Create(brain);controlled.now=0;controlled.orders=6;controlled.mass=5000;controlled.energy=10000
controlled.SelectResearch=function()return'ULB_RANGE','test','ULB_RANGE','funded'end
local starts=0;brain.StartResearch=function()starts=starts+1 end;controlled:ResearchStep()
check(starts==0 and not controlled.researchTask,'Research cannot bypass an exhausted native-call allowance')
brain=Brain();local commander=Unit(850,all.Unit.uul0001,brain);brain.researched.UCA_OVERCHARGE=true
s=state({commander},{uul0001=all.Unit.uul0001.ReforgedAI},{});s.mass=1000;s.energy=5000;s.brain.researched.UCA_OVERCHARGE=true
check(s:Special(commander,frame.Describe(commander,s.productionCatalog),{kind='focus',target={blueprint='uul0001',position={30,0,20}}})and s.energy==3000,'Earned Overcharge reserves the selected 2000-energy price for an ACU firing window')
brain=Brain();commander=Unit(851,all.Unit.uul0001,brain);commander.abilities.ACU_Hunker=true;brain.researched.UCA_HUNKER=true
s=state({commander},{uul0001=all.Unit.uul0001.ReforgedAI},{});s.mass=1000;s.energy=5000;s.brain.researched.UCA_HUNKER=true;local calls=nativeCalls.ability;s:Micro()
check(nativeCalls.ability==calls+1 and s.microHeld[commander],'A safe recovered hunkered commander can leave Hunker without receiving movement or repair commands')
local deploy=Unit(852,all.Unit.uux0113d1,Brain());deploy.abilities.Deploy=true
s=state({deploy},{uux0113d1=all.Unit.uux0113d1.ReforgedAI},{});s.mass=1000;s.energy=5000
check(s:Special(deploy,frame.Describe(deploy,s.productionCatalog),{kind='withdraw',position={10,0,10}}),'Deployed Jackhammer issues undeploy before relocation')
check(s.abilityPending['852:Deploy'].expectedActive==false,'Undeploy waits for the inactive native state rather than treating the old active state as acknowledgement')
