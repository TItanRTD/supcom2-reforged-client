-- Install the fair Reforged presets on the exact retail brain implementation.
-- Human and Custom AI initialization retain retail economy and behavior.
local retailAI=import('/lua/sim/reforged_ai_controller.lua')
local retailBrain=AIBrain
AIBrain=Class(retailBrain){
    OnCreateAI=function(self,planName)
        local setup=ScenarioInfo.ArmySetup[self.Name]
        local level=setup and not setup.Civilian and ScenarioInfo.type=='skirmish'and retailAI.Level(setup.AIPersonality)
        if not level then return retailBrain.OnCreateAI(self,planName)end
        self.ReforgedAILevel=level
        self.ReforgedAIPersonality=setup.aiarchetype
        local neutral={AIPersonality='Custom',aitype='Normal',aiarchetype='Balanced',
            aibuildbonus='0',airesourcebonus='0',aivetbonus='0',aiintel='None',aitargetpreference='Strongest'}
        local saved={}
        for key,value in pairs(neutral)do saved[key]=setup[key];setup[key]=value end
        local ok,message=pcall(retailBrain.OnCreateAI,self,planName)
        for key in pairs(neutral)do setup[key]=saved[key]end
        if not ok then error(message)end
    end,
    SetupCheat=function(self,...)
        if not self.ReforgedAILevel then return retailBrain.SetupCheat(self,...)end
    end,
    ApplyCheatBuffs=function(self,...)
        if not self.ReforgedAILevel then return retailBrain.ApplyCheatBuffs(self,...)end
    end,
    InitializeSkirmishManagers=function(self,...)
        if self.ReforgedAILevel then return retailAI.Start(self)end
        return retailBrain.InitializeSkirmishManagers(self,...)
    end,
    InitializeSkirmishSystems=function(self,...)
        if self.ReforgedAILevel then return retailAI.Start(self)end
        return retailBrain.InitializeSkirmishSystems(self,...)
    end,
}
