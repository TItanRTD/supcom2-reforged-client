-- Per-weapon layers, minimum range and local usable support, over known contacts.
local effective=import('/lua/sim/reforged_ai_effective.lua')
function Decide(actor,contacts,catalog,allocated)
 local d,p=actor.description,actor.position
 local localContacts=effective.Local(contacts,p,96,200)
 local best,score,danger=nil,nil,0
 for _,c in ipairs(localContacts)do local enemy=catalog[c.blueprint]
  if enemy and not enemy.scriptManaged then
   local separation=effective.Distance(p,c.position)
   local max=effective.WeaponRange(enemy,d.currentLayer or d.physicalLayer,c.currentLayer or enemy.physicalLayer,d.flags)
   if max>0 and separation<=max+8 then danger=danger+math.max(20,enemy.mass)*(c.confidence or 1)end
   if c.current and c.channel=='vision'and c.age<=2 then
    local target={};for k,v in pairs(enemy)do target[k]=v end;target.currentLayer=c.currentLayer
    local hit,range,min,w=effective.CanHit(d,target,separation,true)
    if hit or range>0 and separation>=min and separation<=range+12 then
     local value=math.max(20,enemy.mass)*(1+(1-(c.health or 1)))*(enemy.roles.commander and(c.health or 1)<.35 and 4 or enemy.roles.siege and 2 or 1)
      /(10+separation)/(1+(allocated[c.id]or 0)/math.max(40,enemy.mass))
     if not score or value>score or value==score and c.id<best.id then best=c;score=value end
    end
   end
  end
 end
 if danger>0 and(actor.health<.3 or actor.health<.65 and danger>math.max(80,actor.localSupport or 0)*1.4)then return{kind='withdraw',position=actor.home,reason='local-threat-withdrawal',danger=danger}end
 if best then
  local enemy=catalog[best.blueprint];local range=effective.WeaponRange(d,best.currentLayer or enemy.physicalLayer,nil,enemy.flags,true)
  local enemyRange=effective.WeaponRange(enemy,d.currentLayer or d.physicalLayer,best.currentLayer or enemy.physicalLayer,d.flags)
  local separation=effective.Distance(p,best.position)
  if d.physicalLayer~='Air'and range>enemyRange+3 and separation<range*.7 and danger>0 then return{kind='kite',target=best,reason='preserve-earned-compatible-range',danger=danger}end
  allocated[best.id]=(allocated[best.id]or 0)+d.mass
  return{kind='focus',target=best,reason='visible-compatible-weapon-target',danger=danger}
 end
end
