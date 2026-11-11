-- Rebuild after every selected unit, weapon, projectile and research pass.
local catalog=setmetatable({}, {__index=getfenv(1)})
doscript('/lua/system/reforged_ai_catalog.lua',catalog)
function Install(all)
 for id,d in pairs(catalog.Build(all))do all.Unit[id].ReforgedAI=d end
end
