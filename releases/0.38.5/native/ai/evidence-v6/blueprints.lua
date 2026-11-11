-- Blueprint-loader context has doscript, not import. Metadata contains only
-- public static capabilities; current ownership/research is checked at use.
local describe=setmetatable({}, {__index=getfenv(1)})
doscript('/lua/system/reforged_ai_catalog.lua',describe)
function Install(all)
    local descriptions=describe.Build(all)
    for id,d in pairs(descriptions)do all.Unit[id].ReforgedAI=d end
end
