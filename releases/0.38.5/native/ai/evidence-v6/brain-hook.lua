-- Appended AFTER the retained retail/research AIBrain wrappers, in both base
-- and DLC. Human/campaign/Custom initialization keeps its original lifecycle.
local rfController=import('/lua/sim/reforged_ai_controller.lua')
local rfResources=import('/lua/sim/reforged_ai_resources.lua')
local previousRFBrain=AIBrain
local function failed(self,phase,message)
    pcall(import('/lua/sim/reforged_ai_trace.lua').NativeLog,'RF_AI_INIT_FAILED|army='..tostring(self:GetArmyIndex())..'|phase='..phase..'|detail='..string.sub(tostring(message),1,512))
    error(message)
end
AIBrain=Class(previousRFBrain){
    OnCreateHuman=function(self,planName)
        previousRFBrain.OnCreateHuman(self,planName)
        if ScenarioInfo.type=='skirmish'then rfResources.Apply(self)end
    end,
    OnCreateAI=function(self,planName)
        local setup=ScenarioInfo.ArmySetup[self.Name]
        local level=setup and not setup.Civilian and ScenarioInfo.type=='skirmish'and rfController.Level(setup.AIPersonality)
        if level then
            self.ReforgedAILevel=level
            self.ReforgedAIPersonality=setup.aiarchetype
            -- Feed neutral values through the ORIGINAL initialization body,
            -- retaining shared callbacks, restrictions and research setup.
            local saved={};local fields={'AIPersonality','aitype','aiarchetype','aibuildbonus','airesourcebonus','aivetbonus','aiintel','aitargetpreference'}
            for _,key in ipairs(fields)do saved[key]=setup[key]end
            setup.AIPersonality='Custom';setup.aitype='Normal';setup.aiarchetype='Balanced'
            setup.aibuildbonus='0';setup.airesourcebonus='0';setup.aivetbonus='0';setup.aiintel='None';setup.aitargetpreference='Strongest'
            local ok,message=pcall(previousRFBrain.OnCreateAI,self,planName)
            for _,key in ipairs(fields)do setup[key]=saved[key]end
            if not ok then failed(self,'retail-initialization',message)end
            rfResources.Apply(self)
            local good,message=pcall(rfController.Validate,self)
            if not good then failed(self,'neutral-validation',message)end
        else
            -- Custom retains build/veterancy/intel controls, with its former
            -- income field replaced by the common per-slot rule.
            if setup and not setup.Civilian and ScenarioInfo.type=='skirmish'then setup.airesourcebonus='0'end
            previousRFBrain.OnCreateAI(self,planName)
            if setup and not setup.Civilian and ScenarioInfo.type=='skirmish'then rfResources.Apply(self)end
        end
    end,
    SetupCheat=function(self,...)
        if not self.ReforgedAILevel then return previousRFBrain.SetupCheat(self,...)end
    end,
    ApplyCheatBuffs=function(self,unit)
        if not self.ReforgedAILevel then return previousRFBrain.ApplyCheatBuffs(self,unit)end
    end,
    InitializeSkirmishManagers=function(self,...)
        if self.ReforgedAILevel then return rfController.Start(self)end
        return previousRFBrain.InitializeSkirmishManagers(self,...)
    end,
    InitializeSkirmishSystems=function(self,...)
        if self.ReforgedAILevel then return rfController.Start(self)end
        return previousRFBrain.InitializeSkirmishSystems(self,...)
    end,
}
