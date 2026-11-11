-- Reforged 0.30.0 pure knowledge policy; engine effects belong to the native adapter.
local function finite(n)return type(n)=='number'and n==n and n>-math.huge and n<math.huge end
local function identifier(id)return type(id)=='string'and #id>0 and #id<=64 and string.match(id,'^[%w_:.%-]+$')end
local function vector(p,width,height)
    if type(p)~='table'then return end
    local x,y,z=p[1],p[2],p[3]
    if finite(x)and finite(y)and finite(z)and x>=0 and x<=width and z>=0 and z<=height and math.abs(y)<=10000 then return{x,y,z}end
end
local roles={land=true,air=true,naval=true,structure=true,engineer=true,commander=true,unknown=true}
function Create(width,height,capacity)
    assert(finite(width)and width>0 and width<=16384 and finite(height)and height>0 and height<=16384,'Invalid map bounds')
    capacity=capacity or 2048
    assert(type(capacity)=='number'and capacity==math.floor(capacity)and capacity>=1 and capacity<=4096,'Invalid contact capacity')
    local records={}local aliases={}local count=0;local clock=0
    local state={}
    local function time(now)
        if not finite(now)or now<clock then return false end
        clock=now;return true
    end
    local function remove(id)if records[id]then records[id]=nil;count=count-1 end;for key,a in pairs(aliases)do if a.id==id then aliases[key]=nil end end end
    local function ttl(record)return record.stationary and 120 or 20 end
    local function prune(now)
        local expired={}
        for id,r in pairs(records)do if now-r.updated>=ttl(r)then expired[#expired+1]=id end end
        for _,id in ipairs(expired)do remove(id)end
    end
    function state:Associate(id,radarId,now)
        if not identifier(id)or not identifier(radarId)or not records[id]or records[id].channel~='vision'or records[id].updated~=now then return false end
        local previous=aliases[radarId]
        if previous and previous.id~=id then aliases[radarId]=nil end
        if records[radarId]then remove(radarId)end
        aliases[radarId]={id=id,at=now};return true
    end
    function state:Resolve(id,now)
        local a=aliases[id];if a and now-a.at<=20 and records[a.id]then return a.id end;return id
    end
    function state:Observe(packet,now)
        if type(packet)~='table'or not identifier(packet.id)or not time(now)then return false,'invalid-packet'end
        local id,channel=packet.id,packet.channel
        if channel=='radar'or channel=='sonar'then local alias=aliases[id]
            if alias and now-alias.at<=20 and records[alias.id]then id=alias.id else aliases[id]=nil end
        end
        local previous=records[id]
        if channel=='lost'then
            if not previous then return false,'unknown-contact'end
            -- A loss event carries NO new position, blueprint or health.
            previous.current=false;previous.channel='memory';previous.health=nil
            return true
        end
        if channel~='vision'and channel~='radar'and channel~='sonar'then return false,'unobserved'end
        if packet.event=='destroyed'then
            if channel~='vision'then return false,'unobserved-destruction'end
            remove(id);return true
        elseif packet.event=='no-longer-hostile'then
            -- The adapter must establish current vision and native ownership.
            -- Forgetting hostility does not imply a kill or grant new research.
            if channel~='vision'then return false,'unobserved-ownership'end
            remove(id);return true
        elseif packet.event~=nil then return false,'invalid-event'end
        local position=vector(packet.position,width,height)
        if not position then return false,'invalid-position'end
        -- Do not even read sensitive members of a radar/sonar packet. A native
        -- blip might expose its source internally without revealing it to a player.
        local blueprint,role,health,stationary
        if channel=='vision'then
            blueprint=packet.blueprint
            if blueprint~=nil and(type(blueprint)~='string'or #blueprint>48 or not string.match(blueprint,'^[a-z][a-z0-9_]+$'))then return false,'invalid-blueprint'end
            role=packet.role
            if role~=nil and not roles[role]then return false,'invalid-role'end
            health=packet.health
            if health~=nil and(not finite(health)or health<0 or health>1)then return false,'invalid-health'end
            stationary=packet.stationary==true
        end
        prune(now)
        previous=records[id]
        if not previous and count>=capacity then return false,'capacity'end
        local r=previous or{}
        if not previous then count=count+1;records[id]=r end
        r.position=position;r.channel=channel;r.current=true;r.updated=now;r.health=health
        if channel=='vision'then
            r.blueprint=blueprint;r.role=role or'unknown';r.stationary=stationary;r.visualAt=now
            r.layer=({Land=true,Air=true,Water=true,Sub=true,Seabed=true})[packet.layer]and packet.layer or nil
        end
        return true
    end
    function state:Snapshot(now)
        if not time(now)then return nil,'invalid-time'end
        prune(now)
        local result={}
        for id,r in pairs(records)do
            local age=now-r.updated
            result[#result+1]={id=id,position={r.position[1],r.position[2],r.position[3]},channel=r.channel,current=r.current,
                updated=r.updated,age=age,confidence=math.max(0,1-age/ttl(r)),blueprint=r.blueprint,role=r.role or'unknown',
                classificationSource=r.blueprint and(r.channel=='vision'and'vision'or'memory')or'unknown',
                visualAt=r.visualAt,currentLayer=r.channel=='vision'and r.layer or nil,health=r.channel=='vision'and r.health or nil,stationary=r.stationary==true}
        end
        table.sort(result,function(a,b)return a.id<b.id end)
        return result
    end
    return state
end
