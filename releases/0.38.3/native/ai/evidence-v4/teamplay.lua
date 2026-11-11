-- Simulation-local explicit declarations by participating AI controllers.
-- No enemy brains, team-wide wallet, foreign commands or human commitments.
local records={};local removed={}
local function copy(x)
    if type(x)~='table'then return x end
    local r={};for k,v in pairs(x)do r[k]=copy(v)end;return r
end
function Publish(army,record,now)
    records[army]={at=now,data=copy(record)};removed[army]=nil
end
function Remove(army,now)records[army]=nil;removed[army]=now end
function Allies(army,now,isAlly)
    local result={}
    for id,r in pairs(records)do
        if id~=army and isAlly(army,id)and now>=r.at and now-r.at<=8 then
            local d=copy(r.data);d.army=id;d.age=now-r.at;result[#result+1]=d
        end
    end
    table.sort(result,function(a,b)return a.army<b.army end);return result
end
function Role(army,own,allies)
    if #allies==0 then return'solo'end
    local airOwner,airScore=army,(own.airFactories or 0)*4+(own.readyAir or 0)/200
    for _,a in ipairs(allies)do
        local score=(a.airFactories or 0)*4+(a.readyAir or 0)/200
        if score>airScore or score==airScore and a.army<airOwner then airOwner=a.army;airScore=score end
    end
    if airOwner==army then return'air_cover'end
    if (own.readySupport or 0)>200 and (own.readySupport or 0)>(own.readyGround or 0)*.5 then return'support'end
    return'ground'
end
function Request(army,home,threat,now)
    return{id=tostring(army)..':'..math.floor(now/10),owner=army,position=copy(home),needed=math.max(100,threat),
        created=now,deadline=now+25,expires=now+8,kind='defend-ally'}
end
-- Exactly one lowest-ID eligible helper takes a request. A helper will still
-- validate its own ready units, route and local safety before acknowledging.
function SelectRequest(army,own,allies,now)
    if own.emergency then return end
    local function eligible(a,r)
        if a.emergency or(a.availableGround or 0)<r.needed*1.25 or a.declined==r.id then return false end
        if a.home and a.groundSpeed then
            local distance=math.sqrt((a.home[1]-r.position[1])^2+(a.home[3]-r.position[3])^2)
            if distance/math.max(.1,a.groundSpeed)>r.deadline-now then return false end
        end
        return true
    end
    for _,ally in ipairs(allies)do local r=ally.request
        if r and r.expires>=now and r.deadline>now and r.owner==ally.army then
            local winner=army
            for _,other in ipairs(allies)do
                if other.army~=ally.army and eligible(other,r)and other.army<winner then winner=other.army end
            end
            if winner==army and eligible(own,r)then return copy(r)end
        end
    end
end
function Commitment(request,army,units,now)
    local chosen,total={},0
    for _,u in ipairs(units)do
        if u.complete and u.free and u.reachable and u.arrival<=request.deadline-now and u.health>=.5 then
            chosen[#chosen+1]=u.id;total=total+u.mass
            if total>=request.needed then break end
        end
    end
    if total<request.needed then return nil,'insufficient-ready-on-time-help'end
    return{plan=request.id,owner=request.owner,helper=army,unitIds=chosen,mass=total,expires=math.min(request.expires,now+5),
        deadline=request.deadline,position=copy(request.position),state='acknowledged'}
end
function Valid(commitment,allies,now)
    if not commitment or now>commitment.expires then return false end
    for _,a in ipairs(allies)do if a.army==commitment.owner and a.request and a.request.id==commitment.plan and a.request.expires>=now then return true end end
    return false
end
