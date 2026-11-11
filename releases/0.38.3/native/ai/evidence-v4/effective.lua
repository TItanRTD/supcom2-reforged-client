-- Shared effective weapons. Owned runtime state is separate from enemy potential.
local function copy(v)if type(v)~='table'then return v end;local r={}for k,x in pairs(v)do r[k]=copy(x)end;return r end
local function safe(fn,...)local ok,v=pcall(fn,...);if ok then return v end end
function Distance(a,b)return math.sqrt((a[1]-b[1])^2+(a[3]-b[3])^2)end
function Buff(value,affects)
 local add,mult,ceil,floor=0,1,nil,nil
 for _,v in pairs(affects or{})do local count=v.Count or 1;add=add+(v.Add or 0)*count;mult=mult+(v.Mult or 0)*count
  if v.Ceil and(not ceil or ceil<v.Ceil)then ceil=v.Ceil end
  if v.Floor and(not floor or floor>v.Floor)then floor=v.Floor end
 end
 local result=(value+add)*math.max(0,mult)
 if floor and result<floor then result=floor end;if ceil and result>ceil then result=ceil end;return result
end
function Matches(flags,expression,id)
 if not expression or expression==''then return true end
 -- A union of intersections, with explicit category exclusions.
 for branch in string.gmatch(expression,'[^+|]+')do
  local good,positive=true,false
  for token in string.gmatch(branch,'%S+')do local negative=token:sub(1,1)=='-';local key=negative and token:sub(2)or token
   local found=flags[key]==true or id and string.lower(key)==string.lower(id)
   if negative and found or not negative and not found then good=false end
   if not negative then positive=true end
  end
  if good and positive then return true end
 end
 return false
end
local function enabled(w,brain)
 if #w.requires>0 then for _,id in ipairs(w.requires)do if brain:HasResearched(id)then return true end end;return false end
 return not w.initiallyDisabled
end
function Researched(d,brain,definitions,buffs)
 local result=copy(d);local affects={}
 local ids={};for id in pairs(definitions or{})do ids[#ids+1]=id end;table.sort(ids)
 for _,id in ipairs(ids)do local research=definitions[id]
  if brain:HasResearched(id)and Matches(d.flags,research.CATS,d.id)then
   for _,buffId in ipairs(research.Buffs or{})do local b=buffs and buffs[buffId]
    for kind,value in pairs(b and b.Affects or{})do affects[kind]=affects[kind]or{};affects[kind][buffId]={Count=1,Add=value.Add,Mult=value.Mult,Floor=value.Floor,Ceil=value.Ceil}end
   end
  end
 end
 result.airRange=0;result.groundRange=0
 for _,w in ipairs(result.weapons or{})do
  w.enabled=enabled(w,brain);w.maxRange=Buff(w.maxRange,affects.WeaponRange);w.damage=Buff(w.damage,affects.Damage);w.rate=Buff(w.rate,affects.RateOfFire)
  -- A deployable gun is potential capability, not a currently ready weapon.
  if w.enabled or d.scripted=='deploy-cannon'then result.airRange=math.max(result.airRange,w.airRange>0 and w.maxRange or 0);result.groundRange=math.max(result.groundRange,w.groundRange>0 and w.maxRange or 0)end
 end
 result.speed=Buff(result.speed,affects.MoveSpeed);return result
end
function Owned(d,unit,brain)
 local r=copy(d);r.currentLayer=safe(function()return unit:GetCurrentLayer()end)or d.physicalLayer
 local affects=unit.Buffs and unit.Buffs.Affects or{}
 r.speed=Buff(d.baseSpeed or d.speed,affects.MoveSpeed);r.airRange=0;r.groundRange=0
 local stunned=safe(function()return unit:IsUnitState('Stunned')end)==true
 r.stunned=stunned;r.ready=not stunned and unit:GetFractionComplete()>=1 and not unit:IsDead()
 r.halfBaked=unit.HalfBakeThread~=nil
 for i,w in ipairs(r.weapons or{})do
  -- Use the unmodified selected blueprint, then actual owned buff stacks once.
  local base=(d.baseWeapons or d.weapons)[i]or w
  w.maxRange=Buff(base.maxRange,affects.WeaponRange);w.damage=Buff(base.damage,affects.Damage);w.rate=Buff(base.rate,affects.RateOfFire)
  w.enabled=enabled(base,brain)
  if r.scripted=='deploy-cannon'then w.enabled=safe(function()return unit:IsUnitAbilityState('Deploy','Activated')end)==true end
  local native=safe(function()return unit:GetWeapon(w.label or w.index)end)
  if native and type(native.IsEnabled)=='function'then local value=safe(native.IsEnabled,native);if type(value)=='boolean'then w.enabled=value end end
  if w.enabled then r.airRange=math.max(r.airRange,w.airRange>0 and w.maxRange or 0);r.groundRange=math.max(r.groundRange,w.groundRange>0 and w.maxRange or 0)end
 end
 return r
end
function Command(unit,d,cap)
 if not d or not d.controlled or d.scriptManaged or unit:IsDead()or unit:GetFractionComplete()<1 then return false end
 if safe(function()return unit:IsUnitState('Stunned')end)==true then return false end
 if type(unit.TestCommandCaps)~='function'then return false end
 return safe(unit.TestCommandCaps,unit,cap)==true
end
function WeaponRange(d,targetLayer,sourceLayer,targetFlags,readyOnly)
 local max,min,best=0,0,nil
 sourceLayer=sourceLayer or d.currentLayer or d.physicalLayer
 for _,w in ipairs(d.weapons or{})do
  local legal=(not readyOnly or w.enabled~=false)and w.layers[sourceLayer]and w.layers[sourceLayer][targetLayer]
  if legal and targetFlags then
   legal=Matches(targetFlags,w.only)and not(w.disallow and Matches(targetFlags,w.disallow))
  end
  if legal and w.maxRange>max then max=w.maxRange;min=w.minRange;best=w end
 end
 if(not readyOnly or d.scripted=='pods'and d.ready~=false)and(d.scriptedRange or 0)>max and targetLayer~='Air'then return d.scriptedRange,0,nil end
 return max,min,best
end
function CanHit(d,enemy,distance,readyOnly)
 local layer=enemy.currentLayer or enemy.physicalLayer or(enemy.layer=='air'and'Air'or enemy.layer=='naval'and'Water'or'Land')
 local source=d.currentLayer or d.physicalLayer
 for _,weapon in ipairs(d.weapons or{})do
  if(not readyOnly or weapon.enabled~=false)and weapon.layers[source]and weapon.layers[source][layer]and Matches(enemy.flags,weapon.only)and not(weapon.disallow and Matches(enemy.flags,weapon.disallow))and distance>=weapon.minRange and distance<=weapon.maxRange then return true,weapon.maxRange,weapon.minRange,weapon end
 end
 local max,min,w=WeaponRange(d,layer,nil,enemy.flags,readyOnly)
 return max>0 and distance>=min and distance<=max,max,min,w
end
-- Select by distance before applying a cap. One pass, bounded retained candidates.
function Local(contacts,position,limit,radius)
 local result={};limit=limit or 96
 for _,c in ipairs(contacts or{})do local dist=Distance(c.position,position)
  if not radius or dist<=radius then
   local at=#result+1
   for i,r in ipairs(result)do if dist<r.distance or dist==r.distance and c.id<r.contact.id then at=i;break end end
   if at<=limit then table.insert(result,at,{contact=c,distance=dist});if #result>limit then table.remove(result)end end
  end
 end
 local out={}for _,r in ipairs(result)do out[#out+1]=r.contact end;return out
end
function Exposure(position,contacts,catalog,actorLayer)
 local total=0
 for _,c in ipairs(Local(contacts,position,96,180))do local d=catalog[c.blueprint]
  if d and not d.scriptManaged then
   local range=WeaponRange(d,actorLayer or'Land',c.currentLayer or d.physicalLayer)
   range=math.max(range,actorLayer~='Air'and(d.scriptedRange or 0)or 0)
   local dist=Distance(position,c.position)
   if range>0 and dist<range+6 then total=total+math.max(20,d.mass)*(c.confidence or 1)*(1-dist/math.max(1,range+6))end
  elseif not d and c.channel=='radar'and Distance(position,c.position)<45 then total=total+40*(c.confidence or 1)end
 end
 return total
end
function Index(contacts,size)
 local grid={size=size or 64,cells={}}
 for _,c in ipairs(contacts or{})do local x,z=math.floor(c.position[1]/grid.size),math.floor(c.position[3]/grid.size);local key=x..':'..z
  grid.cells[key]=grid.cells[key]or{};grid.cells[key][#grid.cells[key]+1]=c
 end
 return grid
end
function Query(grid,position,radius,limit)
 local found={};local size=grid.size
 for x=math.floor((position[1]-radius)/size),math.floor((position[1]+radius)/size)do
  for z=math.floor((position[3]-radius)/size),math.floor((position[3]+radius)/size)do
   for _,c in ipairs(grid.cells[x..':'..z]or{})do found[#found+1]=c end
  end
 end
 return Local(found,position,limit or 96,radius)
end
