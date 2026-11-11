-- Bounded simulation diagnostics. Presentation/export only; no order decisions
-- depend on LOG, focus, wall clock or whether diagnostics are being collected.
local function finite(v)return type(v)=='number'and v==v and math.abs(v)<math.huge end
local function encode(v)
    if type(v)=='boolean'then return v and'true'or'false'end
    if finite(v)then return string.format('%.4f',v)end
    if type(v)~='string'then return end
    return string.gsub(string.sub(v,1,160),'[^%w_.:%-]',function(c)return string.format('%%%02X',string.byte(c))end)
end
-- Retail LOG passes each accumulated line to a printf-style logger, without
-- formatting arguments. Percent-encoded diagnostic values must remain data.
-- pcall cannot catch the CRT invalid-parameter termination caused by %n/etc.
function NativeLog(line)
    LOG((string.gsub(line,'%%','%%%%')))
end
function Create(army,emit,ticksPerSecond)
    assert(finite(army)and army==math.floor(army)and army>=1 and army<=16,'invalid diagnostic army')
    assert(type(emit)=='function','missing diagnostic sink')
    ticksPerSecond=ticksPerSecond or 10
    assert(finite(ticksPerSecond)and ticksPerSecond>=1 and ticksPerSecond<=100,'invalid diagnostic tick rate')
    local seq,bucket,count,dropped,lastTick=0,-1,0,0,-1
    local state={}
    function state:Event(tick,event,fields)
        if not finite(tick)or tick<lastTick or tick<0 or tick~=math.floor(tick)
            or type(event)~='string'or not string.match(event,'^[a-z][a-z%-]+$')or #event>40 or type(fields)~='table'then return false end
        lastTick=tick
        -- At most thirty-two detail records per simulation second per army. A new
        -- bucket reports dropped detail; controller progress is unaffected.
        local second=math.floor(tick/ticksPerSecond)
        if second~=bucket then bucket=second;count=0 end
        if count>=32 then dropped=dropped+1;return false end
        local keys={}
        local reserved={v=true,army=true,seq=true,tick=true,event=true,dropped=true,truncated=true}
        for k in pairs(fields)do if type(k)=='string'and not reserved[k]and string.match(k,'^[a-z][a-zA-Z0-9]*$')and #k<=32 then keys[#keys+1]=k end end
        table.sort(keys)
        local record={'RF_AI','v=1','army='..army,'seq='..(seq+1),'tick='..tick,'event='..event}
        if dropped>0 then record[#record+1]='dropped='..dropped end
        local bytes=#table.concat(record,'|');local truncated=#keys>24
        for i=1,math.min(24,#keys)do local k=keys[i];local value=encode(fields[k])
            if value then local field=k..'='..value
                if bytes+#field+1>3900 then truncated=true;break end
                record[#record+1]=field;bytes=bytes+#field+1
            end
        end
        if truncated then record[#record+1]='truncated=true'end
        seq=seq+1;count=count+1;dropped=0
        local ok=pcall(emit,table.concat(record,'|'))
        return ok
    end
    return state
end
