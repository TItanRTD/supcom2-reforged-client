-- Delegate the exact selected weapon class; observe returned OWN projectiles.
local launch=DefaultProjectileWeapon and DefaultProjectileWeapon.CreateProjectileAtMuzzle
if type(launch)=='function'then
 DefaultProjectileWeapon.CreateProjectileAtMuzzle=function(self,...)
  local projectile=launch(self,...)
  if projectile then pcall(function()
   local unit=self.unit
   local brain=unit and unit:GetAIBrain()
   local controller=brain and brain.ReforgedAIController
   if controller and controller.OnProjectileLaunch and unit:GetArmy()==controller.army then
    projectile.ReforgedAIProjectileController=controller
    controller:OnProjectileLaunch(unit,self:GetBlueprint().Label,projectile:GetEntityId())
   end
  end)end
  return projectile
 end
end
