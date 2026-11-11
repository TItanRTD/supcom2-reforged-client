-- Target identity/health/position are never queried by this private telemetry.
local impact=Projectile and Projectile.OnImpact
if type(impact)=='function'then
 Projectile.OnImpact=function(self,targetType,targetEntity,...)
  local controller=self.ReforgedAIProjectileController
  if controller and controller.OnProjectileImpact then pcall(controller.OnProjectileImpact,controller,self:GetEntityId(),targetType)end
  return impact(self,targetType,targetEntity,...)
 end
end
