-- Reforged HUD and contextual input. New orders use synchronized SimCallbacks.
-- Income is supplied per simulation tick, as documented by the shipped economy.lua.
local UIUtil = import('/lua/ui/uiutil.lua')
local Group = import('/lua/maui/group.lua').Group
local Bitmap = import('/lua/maui/bitmap.lua').Bitmap
local Button = import('/lua/maui/button.lua').Button
local Build = import('/lua/ui/game/reforged_build.lua')
local Stats = import('/lua/ui/game/reforged_stats.lua')
local Observer = import('/lua/ui/game/reforged_observer.lua')
local ResearchNotices = import('/lua/ui/game/reforged_research_notices.lua')
local Layout = import('/lua/ui/game/reforged_layout.lua')
local nativeHudOK,NativeHud=pcall(import,'/lua/ui/game/reforged_nativehud.lua')
local scale = Layout.scale or 1
local GameMain = import('/lua/ui/game/gamemain.lua')
local Controls=import('/lua/ui/game/reforged_controls.lua')
local Perf=import('/lua/ui/game/reforged_performance.lua')
local converterOK,Converters=pcall(import,'/lua/ui/game/reforged_converterui.lua')
local active = false
local version = '0.38.4'
local researchColor = 'ffd99412'
local rootPath = '/textures/ui/common/pc/ingame/hud/'
local palettes = {
    [1] = {name='uef', color='ff66c7ff'},
    [2] = {name='cybran', color='ffff7070'},
    [3] = {name='illuminate', color='ff5ad082'},
}

local function finite(value)
    return type(value) == 'number' and value == value and value > -math.huge and value < math.huge
end

function ResearchPerMinute(economy, frequency)
    if type(economy) ~= 'table' or type(economy.income) ~= 'table' then return nil end
    local income = economy.income.RESEARCH
    if not finite(income) or income < 0 or not finite(frequency) or frequency <= 0 or frequency > 1000 then return nil end
    local value = income * frequency * 60
    if not finite(value) or value > 9999999 then return nil end
    return value
end

function FormatGameTime(seconds)
    if not finite(seconds) or seconds < 0 or seconds > 9999999 then return '--:--:--' end
    seconds = math.floor(seconds)
    return string.format('%02d:%02d:%02d', math.floor(seconds / 3600), math.floor(seconds / 60) % 60, seconds % 60)
end

function FactionPalette(armies, focus)
    if type(armies) == 'table' and type(armies.armiesTable) == 'table' then
        local army = armies.armiesTable[focus]
        if type(army)=='table' then
            local faction=Layout.FactionName(army.faction or army.Faction)
            for _,p in ipairs(palettes) do if p.name==faction then return p end end
        end
    end
    -- No viewed army, e.g. an observer before selecting a POV. Never a Random theme.
    return {name='neutral', color='ffa0b1c1'}
end

local economyDX,economyDY=0,0
local boundsReady=setmetatable({},{__mode='k'})
local function bounds(control, left, top, width, height)
    -- Retail Control.ResetLayout starts with circular edge/size dependencies.
    -- Assign four independent bounds before evaluating any layout getter.
    if not boundsReady[control] then
        control.Left:Set(left) control.Top:Set(top)
        control.Width:Set(width) control.Height:Set(height)
        if control.Right and control.Bottom then control.Right:Set(left+width);control.Bottom:Set(top+height)end
        boundsReady[control]=true
        return
    end
    if control.Left()~=left then control.Left:Set(left)end
    if control.Top()~=top then control.Top:Set(top)end
    if control.Width()~=width then control.Width:Set(width)end
    if control.Height()~=height then control.Height:Set(height)end
    -- Drawing uses the edges too. Repair stale native/texture edge constants,
    -- even when cached Left/Top/Width/Height have not changed.
    if control.Right and control.Bottom then
        if control.Right()~=left+width then control.Right:Set(left+width)end
        if control.Bottom()~=top+height then control.Bottom:Set(top+height)end
    end
end
local function place(control, left, top, width, height)
    scale=Layout.GetScale and Layout.GetScale() or scale
    if control._rfEconomy then left=left+economyDX;top=top+economyDY end
    left,top,width,height=Layout.Transform(control,left,top,width,height)
    bounds(control,math.floor(left*scale),math.floor(top*scale),math.floor(width*scale),math.floor(height*scale))
end

function Destroy()
    if active then
        local previous = active
        active = false
        if Build.RestoreKeys then Build.RestoreKeys() end
        Observer.Restore()
        Controls.Restore()
        previous.root:Destroy()
    end
end

function SelectionChanged()
    if Controls.SelectionChanged then Controls.SelectionChanged()end
    if active and active.build then
        local ok,message=pcall(active.build.SelectionChanged,active.build)
        if not ok then WARN('Reforged selection refresh unavailable: '..tostring(message)) end
    end
end

function Create(parent, pc)
    Destroy()
    if not parent then return end
    local frame=GetFrame(0)
    if Layout.Resize then scale=Layout.Resize(frame.Width(),frame.Height()) end
    Observer.Begin()
    _G.ReforgedIsObserving=Observer.IsObserving
    _G.ReforgedPlayerView=Observer.PlayerView
    _G.ReforgedInspectionSelection=Observer.Selection
    _G.ReforgedSetInspectionSelection=Observer.SetSelection
    local root=Group(parent,'Reforged HUD')
    local state={root=root,failed=false,accents={},visible=true}
    active=state
    root:DisableHitTest() root.Depth:Set(240)
    state.controls=Controls.Create(root)
    if UIUtil.UIRP_PostGlow then root:SetRenderPass(UIUtil.UIRP_PostGlow) end
    local function bitmap(texture,name)
        local c=Bitmap(root,rootPath..texture) c:DisableHitTest()
        if name then c:SetName(name) end
        c.Depth:Set(root.Depth()+1)
        if UIUtil.UIRP_PostGlow then c:SetRenderPass(UIUtil.UIRP_PostGlow) end
        return c
    end
    local function text(value,size,name)
        local c=UIUtil.CreateText(root,value,math.floor(size*scale),'Arial Bold')
        if Layout.RegisterText then Layout.RegisterText(c,size) end
        c:SetColor('ffe7edf3') c:SetDropShadow(false) c:SetClipToWidth(true) c:DisableHitTest()
        if name then c:SetName(name) end
        c.Depth:Set(root.Depth()+10)
        if UIUtil.UIRP_PostGlow then c:SetRenderPass(UIUtil.UIRP_PostGlow) end
        return c
    end
    state.resources={}
    for _,key in ipairs({'mass','energy'}) do
        state.resources[key]={icon=bitmap('r23i_'..key..'.dds','Reforged '..key..' icon'),value=text('--',20,'Reforged '..key..' stored'),rate=text('-- /s',20,'Reforged '..key..' rate')}
        state.resources[key].icon.Depth:Set(root.Depth()+3)
        -- Maui's shipped alignment methods keep short rates/totals centred in equal slots.
        for _,field in ipairs({'value','rate'}) do
            state.resources[key][field]:SetCenteredHorizontally(true)
            state.resources[key][field]:SetCenteredVertically(true)
        end
    end
    state.economyBox=bitmap('r23e.dds','Reforged economy background')
    state.researchBox=bitmap('r23u.dds','Reforged research background')
    state.minimapBox=bitmap('r23mw.dds','Reforged minimap header')
    state.minimapFrame=bitmap('r23mx.dds','Reforged minimap frame')
    state.ordersBox=bitmap('r23p.dds','Reforged orders background')
    state.clockBox=bitmap('r23p.dds','Reforged clock background')
    state.header=text('',11,'Reforged economy caption')
    state.massDivider=bitmap('r23b_mass.dds','Reforged mass divider')
    state.energyDivider=bitmap('r23b_energy.dds','Reforged energy divider')
    state.massDivider.Depth:Set(root.Depth()+3) state.energyDivider.Depth:Set(root.Depth()+3)
    state.rateLabel=text('R/min',14)
    state.rate=text('--',18,'Reforged research income')
    state.pointsBadge=bitmap('r23u.dds','Reforged research points badge')
    state.points=text('--',24,'Reforged research points')
    state.researchTrack=bitmap('r23b_track.dds','Reforged research progress track')
    state.researchFill=bitmap('r23b_energy.dds','Reforged research progress fill')
    state.researchTrack.Depth:Set(root.Depth()+13);state.researchFill.Depth:Set(root.Depth()+14)
    state.researchIcon=bitmap('r23i_research.dds','Reforged research icon')
    state.incomeIcon=bitmap('r23i_research.dds','Reforged research income icon')
    state.incomeIcon.Depth:Set(root.Depth()+3)
    state.centerCaption=bitmap('r23_logo.dds','Reforged central logo')
    if converterOK and Converters.Create then
        local ok,value=pcall(Converters.Create,root)
        if ok then state.converters=value else WARN('Reforged converter controls unavailable: '..tostring(value))end
    end
    state.researchCaption=text('Research',16,'Reforged research caption')
    state.rateLabel:SetColor(researchColor) state.rate:SetColor(researchColor) state.points:SetColor(researchColor) state.researchCaption:SetColor(researchColor)
    state.points:SetColor('ffffe1a6')
    state.minimapCaption=text('Minimap',14,'Reforged map name')
    state.minimapCaption:SetColor('fff1f5f8') state.minimapCaption:SetDropShadow(true)
    state.ordersCaption=text('Unit Orders',11)
    state.clock=text('--:--:--',18,'Reforged clock')
    state.researchButton=Button(root,rootPath..'r23ru.dds',rootPath..'r23rd.dds',rootPath..'r23ro.dds',rootPath..'r23ru.dds')
    state.researchButton:SetName('Reforged research button') state.researchButton.Depth:Set(root.Depth()+5)
    if UIUtil.UIRP_PostGlow then state.researchButton:SetRenderPass(UIUtil.UIRP_PostGlow) end
    state.researchButton.OnClick=function() if Observer.IsObserving() then Observer.ToggleResearch() elseif type(ConExecute)=='function' then ConExecute('ToggleResearchMenu') end end
    state.researchButton.OnRolloverEvent=function(self,event)
        state.researchCaption:SetColor(event=='enter' and 'ffffc94a' or researchColor)
        state.points:SetColor(event=='enter' and 'ffffc94a' or researchColor)
    end
    state.points:SetColor(researchColor)
    state.pointsBadge:Hide() -- the points share the continuous economy plate
    state.clockBox:Hide() state.clock:Hide()
    -- The retail native HUD reuses the Lua MiniMap WorldView. Its legacy
    -- window is hidden after provider creation; give the view a visible HUD
    -- parent, while retaining its native camera, rendering and click handling.
    state.minimapView=false
    local replayOK,replayModule=pcall(import,'/lua/ui/game/reforged_replay.lua')
    if replayOK then state.replay=replayModule.Create(root) end
    state.info=Stats.Create(root)
    state.interfaceHud=import('/lua/ui/game/reforged_interfacehud.lua').Create(root)
    local economyControls={state.economyBox,state.centerCaption,state.massDivider,state.energyDivider,state.rate,state.researchIcon,state.incomeIcon,state.researchCaption,state.points,state.researchButton,state.interfaceHud.cap,state.interfaceHud.capIcon}
    for _,r in pairs(state.resources)do for _,c in pairs(r)do economyControls[#economyControls+1]=c end end
    for _,c in ipairs(economyControls)do c._rfEconomy=true;c._rfPanel='economy' end
    _G.ReforgedClosePanels=function()return Observer.CloseTransient() or state.info.CloseTransient and state.info:CloseTransient() or false end
    state.comparison=Observer.Create(root)
    state.researchNotices=ResearchNotices.Create(root)
    state.commandBlock=Group(root,'Reforged read-only orders')
    state.commandBlock.Depth:Set(root.Depth()+100)
    state.commandBlock.HandleEvent=function(_,e)return Observer.IsObserving() and (e.Type=='ButtonPress' or e.Type=='ButtonRelease' or e.Type=='ButtonDClick') end
    for i=1,5 do state.accents[i]=bitmap('r23_neutral.dds','Reforged accent '..i) end
    state.accents[1]._rfEconomy=true
    for _,c in ipairs({state.minimapBox,state.minimapFrame,state.minimapCaption,state.accents[4]})do c._rfPanel='minimap'end
    for _,c in ipairs({state.ordersBox,state.ordersCaption,state.commandBlock,state.accents[3]})do c._rfPanel='orders'end
    state.accents[1]._rfPanel='economy';state.accents[2]._rfPanel='build';state.accents[5]._rfPanel='details'
    state.researchTrack._rfPanel='economy';state.researchFill._rfPanel='economy' 
    state.build=Build.Create(root)
    local polish=import('/lua/ui/game/rf_polish_renderer.lua')
    local polishOK,polishError=pcall(polish.Create,root)
    if not polishOK then WARN('S2R_POLISH_CREATE|'..tostring(polishError)) end
    local function installKeys()
        if not Build.InstallKeys then state.keysReady=true;return end
        local ok,ready,why=pcall(Build.InstallKeys);state.keysReady=ok and ready==true
        local problem=not state.keysReady and tostring(ok and why or ready)or nil
        if problem and problem~=state.keyProblem then WARN('Reforged hotkeys deferred: '..problem)end
        state.keyProblem=problem
    end
    installKeys()
    local function update()
        Observer.Begin()
        if not state.keysReady then installKeys()end
        local frame=GetFrame(0)
        local physicalWidth,physicalHeight=frame.Width(),frame.Height()
        if not finite(physicalWidth)or not finite(physicalHeight)or physicalWidth<=0 or physicalHeight<=0 then return end
        if Layout.Resize then scale=Layout.Resize(physicalWidth,physicalHeight) end
        local classic=Layout.IsClassic and Layout.IsClassic()
        if nativeHudOK then NativeHud.Update(physicalWidth,physicalHeight)end
        local w,h=physicalWidth/scale,physicalHeight/scale
        economyDX,economyDY=Layout.EconomyOffset(w,h)
        -- Keep the container in physical frame coordinates. Dividing then
        -- flooring after multiplication loses a pixel at some high resolutions.
        bounds(root,0,0,physicalWidth,physicalHeight)
        -- The PC provider's gameUIHidden flag only retires the legacy Lua UI.
        local nis=type(GameMain.IsNISMode)=='function' and GameMain.IsNISMode()
        if (GetCurrentUIState()~='game' and not Observer.IsObserving()) or nis then
            Observer.CancelInspection()
            Observer.ClearSelectionMarkers()
            Controls.Close()
            if state.converters then state.converters:Hide()end
            if state.visible then root:Hide() state.visible=false end
            return
        end
        if not state.visible then root:Show() state.visible=true if state.build.ParentShown then state.build:ParentShown() else state.build.dirty=true end end
        local left=math.floor(w/2)-Layout.economy.converterCenter
        local function E(c,x,y,width,height) if classic then return end;place(c,left+math.floor(x*Layout.economy.width/Layout.economy.designWidth),math.floor(y*Layout.economy.height/Layout.economy.designHeight),math.floor(width*Layout.economy.width/Layout.economy.designWidth),math.floor(height*Layout.economy.height/Layout.economy.designHeight)) end
        if not classic then place(state.economyBox,left,0,Layout.economy.width,Layout.economy.height)end
        -- One row, mirrored around the circle; unused storage tracks are absent.
        -- Author one half, reflect it around the circle center: identical gaps.
        local resourceSlots={icon={28,4,30,30},rate={64,8,72,26},value={164,8,68,26}}
        for key,c in pairs(state.resources) do
            for name,q in pairs(resourceSlots) do
                E(c[name],key=='mass' and q[1] or (2*Layout.economy.converterCenter*Layout.economy.designWidth/Layout.economy.width)-q[1]-q[3],q[2],q[3],q[4])
            end
        end
        E(state.massDivider,148,8,3,24)
        E(state.energyDivider,473,8,3,24)
        -- The attached research ledge is part of the plate, not a second rectangle.
        state.researchBox:Hide()
        local mapFrame=Layout.minimap.frame
        place(state.minimapBox,mapFrame[1],mapFrame[3],192,24)
        place(state.ordersBox,Layout.orders.left,h-Layout.orders.bottom-Layout.orders.height,Layout.orders.width,Layout.orders.height)
        place(state.header,left+12,2,160,16)
        E(state.researchIcon,450,43,22,22) E(state.centerCaption,290,42,44,44)
        state.rateLabel:Hide()
        E(state.incomeIcon,616,8,24,24) E(state.rate,644,10,72,22)
        E(state.researchCaption,474,44,62,22) E(state.points,545,40,28,30)
        local mapRect=Layout.minimap.caption
        place(state.minimapCaption,mapRect[1],mapRect[2],mapRect[3],mapRect[4])
        local expanded=true
        if type(UIIsConstructionEnabled)=='function' then
            local good,enabled,nativeExpanded=pcall(UIIsConstructionEnabled)
            if good and type(nativeExpanded)=='boolean' then expanded=nativeExpanded end
        end
        if not(type(SessionIsReplay)=='function'and SessionIsReplay())and type(UIIsConstructionEnabled)=='function'then
            local r=Layout.minimap.viewport
            local ok,applied=pcall(UIIsConstructionEnabled,'RF:Mini',Layout.MinimapPhysical(r))
            if applied~=state.minimapApplied then state.minimapApplied=applied;LOG('S2R_MINIMAP_BOUNDS|native-scene-applied='..tostring(ok and applied)..'|width='..tostring(math.floor((r[2]-r[1])*scale)))end
        end
        local minimapOK,minimapModule=pcall(import,'/lua/ui/game/minimap.lua')
        local mini=minimapOK and type(minimapModule)=='table' and type(minimapModule.controls)=='table' and minimapModule.controls.miniMap
        if type(SessionIsReplay)=='function'and SessionIsReplay()then
            if not state.replayMap then state.replayMap=import('/lua/ui/game/reforged_replaymap.lua').Create(root);state.replayMap.onToggle=function()state.beat()end end
            if mini then mini:Hide()end
            mini=nil
            expanded=state.replayMap.expanded~=false
            state.replayMap:Update(expanded,Observer.Snapshot())
        elseif state.replayMap then state.replayMap:Update(false,{})end
        if Layout.SetMinimapExpanded and Layout.SetMinimapExpanded(expanded)and nativeHudOK then NativeHud.Update(physicalWidth,physicalHeight)end
        if mini then
            if state.minimapView~=mini then
                mini:SetParent(root) mini.Depth:Set(root.Depth()+2)
                -- Preserve the WorldView's engine render pass; HUD plates use PostGlow.
                state.minimapView=mini;mini._rfPanel='minimap'
                -- Load screens also render Maui frames. Do not run the stock
                -- camera reset until the simulation and game UI are both ready.
                local originalFrame=mini.OnFrame
                local rendered=0 local initialized=false local resetDone=false
                if mini.EnableHitTest then mini:EnableHitTest() end
                if mini.GetsGlobalCameraCommands then mini:GetsGlobalCameraCommands(false) end
                mini:SetNeedsFrameUpdate(true)
                mini.OnFrame=function(self,elapsed)
                    -- The native HUD writes viewport edges during its own update.
                    -- Reapply all four edges on rendered frames, not only UI beats.
                    local r=Layout.minimap.viewport
                    place(self,r[1],r[3],r[2]-r[1],r[4]-r[3])
                    self.Right:Set(math.floor(r[2]*scale)) self.Bottom:Set(math.floor(r[4]*scale))
                    if initialized or self:IsHidden() or self.Width()<=0 or self.Height()<=0 then return end
                    local ok,seconds=pcall(GetGameTimeSeconds)
                    local paused=false
                    if type(SessionIsPaused)=='function' then local good,value=pcall(SessionIsPaused) paused=good and value==true end
                    if not ok or not finite(seconds) or (seconds<=0 and not paused) or GetCurrentUIState()~='game' then return end
                    if originalFrame then originalFrame(self,elapsed) end
                    self.OnFrame=state.minimapOnFrame
                    rendered=rendered+1
                    if rendered<2 then return end
                    if not resetDone then
                        if not originalFrame then self:CameraReset() end
                        originalFrame=nil resetDone=true
                    end
                    -- Reset uses the engine's minimap camera. Explicitly fit its
                    -- map extent after loading; never change WorldCamera.
                    local fitted=false
                    if type(GetCamera)=='function' and (self._cameraName=='MiniMap'or self._cameraName=='ReforgedMiniMap') then
                        local fine,camera=pcall(GetCamera,self._cameraName)
                        if fine and camera and type(camera.GetMaxZoom)=='function' and type(camera.SetZoom)=='function' then
                            local good,zoom=pcall(camera.GetMaxZoom,camera)
                            if good and finite(zoom) and zoom>0 then fitted=pcall(camera.SetZoom,camera,zoom,0) end
                        end
                    end
                    -- A stock callback may remove itself; keep only this geometry
                    -- owner installed so frame/viewport/input stay in agreement.
                    self.OnFrame=state.minimapOnFrame
                    initialized=fitted or type(GetCamera)~='function'
                    if not initialized then return end -- Camera extents may arrive after the first game frame.
                    LOG('Reforged minimap: game-ready camera reset; full-map zoom='..tostring(fitted)..'; viewport='..tostring(self.Width())..'x'..tostring(self.Height()))
                end
                state.minimapOnFrame=mini.OnFrame
                LOG('Reforged minimap: attached retail WorldView; waiting for game-ready rendered frames.')
            end
            local r=Layout.minimap.viewport
            place(mini,r[1],r[3],r[2]-r[1],r[4]-r[3])
            -- Native BE3E20 assigns Right and Bottom constants when it lays out
            -- the stock minimap. Width/Height alone cannot update those edges.
            -- Keep the render viewport, camera aspect and hit rectangle equal.
            mini.Right:Set(math.floor(r[2]*scale))
            mini.Bottom:Set(math.floor(r[4]*scale))
            if expanded then mini:Show() else mini:Hide() end
        end
        -- Keep frame and caption in one Maui layer; a later native translucent
        -- frame used to darken the caption almost to black.
        local miniArt=(expanded and 'r23mx.dds' or 'r23mn.dds')..':'..tostring(classic)
        if state.miniArt~=miniArt then
            state.miniArt=miniArt
            state.minimapFrame:SetTexture(rootPath..(expanded and 'r23mx.dds' or 'r23mn.dds'))
            -- Mirror the frame art, never the map image or its camera/input.
            state.minimapFrame:SetUV(classic and 1 or 0,0,classic and 0 or 1,1)
            state.minimapBox:SetUV(classic and 1 or 0,0,classic and 0 or 1,1)
        end
        place(state.minimapFrame,mapFrame[1],mapFrame[3],mapFrame[2]-mapFrame[1],expanded and(mapFrame[4]-mapFrame[3])or 24)
        if expanded then state.minimapCaption:Show() else state.minimapCaption:Hide() end
        if not state.mapName or state.mapName=='Minimap' then
            local good,info=pcall(function() return SessionGetScenarioInfo() end)
            if good and type(info)=='table' then
                local name=info.name or info.mapName or info.MapName or (type(info.ScenarioInfo)=='table' and info.ScenarioInfo.name)
                if type(name)=='string' and name~='' then
                    if type(LOC)=='function' then local ok,value=pcall(LOC,name) if ok then name=value end end
                    if type(name)=='string' then state.mapName=string.sub(name,1,100) end
                end
            end
            state.mapName=state.mapName or 'Minimap'
        end
        state.minimapCaption:SetText(state.mapName)
        place(state.ordersCaption,Layout.orders.left+8,h-Layout.orders.bottom-Layout.orders.height+8,280,18)
        if not classic then E(state.researchButton,447,40,133,26)end
        if not classic then place(state.accents[1],left,0,Layout.economy.width,Layout.economy.height)end
        place(state.accents[2],Layout.build.left+4,h-Layout.build.bottom-Layout.build.height+16,248,2)
        place(state.accents[3],Layout.orders.left+4,h-Layout.orders.bottom-Layout.orders.height,324,2)
        place(state.accents[4],mapFrame[1],mapFrame[3]+22,190,2)
        place(state.accents[5],Layout.details.left+4,h-Layout.details.bottom-Layout.details.height,264,2)
        local selectedOk,selected=pcall(Observer.Selection)
        local hasSelection=selectedOk and type(selected)=='table' and next(selected)~=nil
        local viewedOwner=Observer.ViewedOwner(selectedOk and selected or {})
        local observing=Observer.IsObserving()
        place(state.commandBlock,Layout.orders.left,h-Layout.orders.bottom-Layout.orders.height-98,Layout.orders.width,Layout.orders.height+98)
        if observing then state.commandBlock:Show() else state.commandBlock:Hide() end
        if hasSelection and not observing then state.accents[2]:Show() state.accents[3]:Show() state.accents[5]:Show() state.ordersCaption:Show() state.ordersBox:Show()
        else state.accents[2]:Hide() state.accents[3]:Hide() state.accents[5]:Hide() state.ordersCaption:Hide() state.ordersBox:Hide() end
        local palette={name='neutral',color='ffa0b1c1'}
        local identityOk,identity=pcall(function() return FactionPalette(GetArmiesTable(),Observer.IsObserving() and viewedOwner or GetFocusArmy()) end)
        if identityOk then palette=identity end
        if palette.name~=state.palette then
            state.palette=palette.name state.build:SetPalette(palette) if state.info.SetPalette then state.info:SetPalette(palette) end
        end
        local style=(classic and'classic:'or'reforged:')..palette.name
        if state.layoutStyle~=style then
            state.layoutStyle=style
            state.researchIcon.Depth:Set(root.Depth()+(classic and 6 or 1))
            state.economyBox:SetTexture(rootPath..(classic and'rfc_economy.dds'or'r23e.dds'))
            state.ordersBox:SetTexture(rootPath..(classic and'rfc_orders.dds'or'r23p.dds'))
            for i=1,5 do state.accents[i]:SetTexture(rootPath..(i==1 and not classic and'r23a_'or'r23_')..palette.name..'.dds')end
            -- SetTexture may restore the bitmap's intrinsic dimensions.
            -- Re-pin changed art in this update, including the first frame.
            if not classic then place(state.economyBox,left,0,Layout.economy.width,Layout.economy.height);place(state.accents[1],left,0,Layout.economy.width,Layout.economy.height)end
            place(state.ordersBox,Layout.orders.left,h-Layout.orders.bottom-Layout.orders.height,Layout.orders.width,Layout.orders.height)
            place(state.accents[2],Layout.build.left+4,h-Layout.build.bottom-Layout.build.height+16,248,2)
            place(state.accents[3],Layout.orders.left+4,h-Layout.orders.bottom-Layout.orders.height,324,2)
            place(state.accents[4],mapFrame[1],mapFrame[3]+22,190,2)
            place(state.accents[5],Layout.details.left+4,h-Layout.details.bottom-Layout.details.height,264,2)
        end
        local rate,economy=nil,nil
        if observing then
            economy=Observer.Economy(viewedOwner)
            rate=economy and economy.income.RESEARCH
        elseif palette.name~='neutral' then
            local ok,value=pcall(GetEconomyTotals)
            if ok then
                economy=value
                local fine,result=pcall(function() return ResearchPerMinute(economy,GetSimTicksPerSecond()) end)
                if fine then rate=result end
            end
        end
        for key,c in pairs(state.resources) do
            local field=string.upper(key)
            local stored=type(economy)=='table' and type(economy.stored)=='table' and economy.stored[field]
            c.value:SetText(finite(stored) and string.format('%.0f',math.ceil(stored)) or '--')
            local input=type(economy)=='table' and type(economy.income)=='table' and economy.income[field]
            local use=type(economy)=='table' and economy[(finite(stored) and stored>0.5) and 'lastUseActual' or 'lastUseRequested']
            use=type(use)=='table' and use[field]
            local good,frequency=pcall(GetSimTicksPerSecond)
            if economy and economy.perSecond and finite(input) then c.rate:SetText(string.format('%.0f /s',input))
            elseif good and finite(frequency) and finite(input) and finite(use) then c.rate:SetText(string.format('%+.0f /s',(input-use)*frequency)) else c.rate:SetText('-- /s') end
            c.rate:SetColor(key=='mass' and 'ff45c35e' or 'ffefda2d')
            c.value:SetColor(classic and 'ffffffff' or(key=='mass' and 'ff45c35e' or 'ffefda2d'))
        end
        state.rate:SetText(rate and string.format('%+.1f /m',rate) or '-- /m')
        local points=type(economy)=='table' and type(economy.stored)=='table' and economy.stored.RESEARCH
        if points==math.huge then state.points:SetText('∞')
        elseif finite(points) and points>=0 then state.points:SetText(string.format('%.0f',math.floor(points)))
        else state.points:SetText('--') end
        local built,message=true,nil
        if observing then state.build.root:Hide() state.build.visible=false else built,message=pcall(state.build.Update,state.build) end
        if not built then
            state.build.root:Hide()
            -- A transient selection/blueprint failure must not leave the grid
            -- permanently hidden while its internal visibility flag stays true.
            state.build:ParentShown()
            if not state.buildFailed then WARN('Reforged build menu unavailable: '..tostring(message)) end
            state.buildFailed=true
        else state.buildFailed=false end
        local clockOk,seconds=pcall(GetGameTimeSeconds)
        if not observing and clockOk and finite(seconds) and seconds>=1 then
            local playtimeTick=math.floor(seconds*10)
            if not state.playtimeTick or playtimeTick-state.playtimeTick>=100 then
                state.playtimeTick=playtimeTick
                LOG('S2R_PLAYTIME|'..playtimeTick..'|')
            end
        end
        local samples=Observer.Samples()
        local selectionStart=Perf.Begin()
        if Perf.Peak then Perf.Peak('selected',#selected)end
        local infoOk,infoError=pcall(state.info.Update,state.info,w,h,FormatGameTime(clockOk and seconds or nil),state.build.visible,{observing=observing,owner=viewedOwner,playerView=Observer.PlayerView(),togglePlayerView=Observer.TogglePlayerView,selected=selected,samples=samples})
        Perf.Finish('selectionHud',selectionStart)
        if not infoOk then
            if not state.infoFailed then WARN('Reforged selection/scoreboard refresh unavailable: '..tostring(infoError)) end
            state.infoFailed=true
        else state.infoFailed=false end
        state.comparison:Update(w,h,state.info.model or {})
        local rows=state.info.model or {}
        local scoreboardRect=state.info.scoreboardRect
        if state.replay then state.replay:Update(w,h,FormatGameTime(clockOk and seconds or nil),scoreboardRect) end
        local replayRect=state.replay and state.replay.rect
        local audience=observing and -1 or GetFocusArmy()
        local noticeOK,noticeError=pcall(state.researchNotices.Update,state.researchNotices,physicalWidth,physicalHeight,rows,samples,audience,scoreboardRect,replayRect)
        if not noticeOK then
            state.researchNotices:Hide()
            if not state.noticeFailed then WARN('S2R_RESEARCH_NOTICES|'..tostring(noticeError)) end
        end
        state.noticeFailed=not noticeOK
        local controlsOK,controlsError=true,nil
        if not state.controls.FrameActive or not state.controls:FrameActive() then controlsOK,controlsError=pcall(state.controls.Update,state.controls,w*scale,h*scale)end
        if not controlsOK then
            Controls.Close()
            if not state.controlsFailed then LOG('S2R_OVERLAY_ERROR|'..tostring(controlsError))end
        end
        state.controlsFailed=not controlsOK
        local showEconomy=not observing or viewedOwner~=nil
        for _,control in ipairs({state.economyBox,state.centerCaption,state.massDivider,state.energyDivider,state.rate,state.researchIcon,state.incomeIcon,state.researchCaption,state.points,state.researchButton,state.accents[1]}) do if showEconomy then control:Show() else control:Hide() end end
        for _,resource in pairs(state.resources) do for _,control in pairs(resource) do if showEconomy then control:Show() else control:Hide() end end end
        if classic then state.centerCaption:Hide();state.incomeIcon:Hide()end
        if state.converters then
            local ok,visible=pcall(state.converters.Update,state.converters,w,h,observing and viewedOwner or GetFocusArmy(),selected,observing,showEconomy)
            if not ok then
                state.converters:Hide()
                if not state.converterFailed then WARN('Reforged converter display unavailable: '..tostring(visible))end
            elseif visible then state.centerCaption:Hide()end
            state.converterFailed=not ok
        end
        state.interfaceHud:Update(state,w,h,palette,showEconomy)
        local progress=finite(points)and points>=0 and points-math.floor(points)or nil
        local px=(classic and state.points or state.researchCaption).Left()/scale
        px=math.max(px,(state.researchIcon.Left()+state.researchIcon.Width())/scale+4)
        local right=classic and(state.points.Left()+state.points.Width())/scale or(state.researchButton.Left()+state.researchButton.Width())/scale-8
        local py=classic and(state.points.Top()+state.points.Height())/scale+1 or(state.researchButton.Top()+state.researchButton.Height())/scale-4
        local pw=math.max(1,right-px)
        -- These anchors already come from scaled physical controls. Convert
        -- back once before the shared panel transform places the progress bar.
        px,py=Layout.UntransformPoint('economy',px,py)
        pw=pw/Layout.PanelScale('economy')
        place(state.researchTrack,px,py,pw,2);place(state.researchFill,px,py,progress and pw*progress or 0,2)
        if showEconomy and progress then state.researchTrack:Show();if progress>0 then state.researchFill:Show()else state.researchFill:Hide()end
        else state.researchTrack:Hide();state.researchFill:Hide()end
        local panelTrace=style..':'..physicalWidth..'x'..physicalHeight..':'..tostring(Layout.GetRevision and Layout.GetRevision()or 0)
        if state.panelTrace~=panelTrace then
            state.panelTrace=panelTrace
            for name,c in pairs({economy=state.economyBox,orders=state.ordersBox,details=state.info.details and state.info.details.box,build=state.build.background})do
                pcall(function()
                    LOG('S2R_HUD_PANEL|layout='..(classic and'classic'or'reforged')..'|name='..name..'|rect='..c.Left()..','..c.Right()..','..c.Top()..','..c.Bottom()..'|size='..c.Width()..'x'..c.Height())
                end)
            end
        end
        if not state.reportedVisible then state.reportedVisible=true LOG('Reforged HUD '..version..': four-category build UI and telemetry active. Frame='..tostring(w)..'x'..tostring(h)..'; scale='..tostring(scale)..'; physical frame='..tostring(frame.Width())..'x'..tostring(frame.Height())..'; persistent selection; HUD layout='..(classic and'classic'or'reforged')..'; explicit native control retirement active.') end
    end
    state.beat=function()
        if active~=state then return end
        local started=Perf.Begin()
        local ok,message=pcall(update)
        Perf.Finish('hud',started)
        if not ok then root:Hide() state.visible=false if state.converters then state.converters:Hide()end if not state.failed then WARN('Reforged HUD temporarily unavailable: '..tostring(message)) end state.failed=true
        else state.failed=false end
    end
    state.layoutChanged=function()
        if active~=state then return end
        Controls.Close('HUD layout changed')
        local commandMode=import('/lua/ui/game/commandmode.lua')
        if commandMode.GetCommandMode and commandMode.GetCommandMode() and commandMode.EndCommandMode then commandMode.EndCommandMode(false)end
        local ok,input=pcall(import,'/lua/ui/game/rf_awareness_input.lua')
        if ok and input.Reset then input.Reset()end
        if state.build then state.build.root:Destroy()end
        state.build = Build.Create(root)
        local palette=FactionPalette(GetArmiesTable(),Observer.IsObserving() and Observer.ViewedOwner(Observer.Selection()) or GetFocusArmy())
        state.build:SetPalette(palette)
        if state.info.CloseTransient then state.info:CloseTransient()end
        if state.converters then state.converters:Hide()end
        if state.replayMap and state.replayMap.CancelInput then state.replayMap:CancelInput()end
        if state.replay and state.replay.CloseDialog then state.replay:CloseDialog()end
        state.beat()
    end
    _G.ReforgedHudLayoutChanged=state.layoutChanged
    local previousDestroy=root.OnDestroy
    root.OnDestroy=function(self)
        if _G.ReforgedHudLayoutChanged==state.layoutChanged then _G.ReforgedHudLayoutChanged=nil end
        GameMain.RemoveBeatFunction(state.beat)
        pcall(polish.Destroy)
        if state.replay and state.replay.Destroy then state.replay:Destroy()end
        if state.replayMap then state.replayMap:Destroy()end
        if state.converters then state.converters:Destroy()end
        Observer.Restore()
        Controls.Restore()
        if active==state then if Build.RestoreKeys then Build.RestoreKeys() end active=false end
        if previousDestroy then previousDestroy(self) end
    end
    GameMain.AddBeatFunction(state.beat) state.beat()
    -- A paused/windowed replay may resize between UI beats. Re-layout on the
    -- next rendered frame, without running the full statistics update every frame.
    if root.SetNeedsFrameUpdate then
        root:SetNeedsFrameUpdate(true)
        local lastWidth,lastHeight=frame.Width(),frame.Height()
        root.OnFrame=function()
            if active~=state then return end
            if state.replay and state.replay.Refresh then state.replay:Refresh()end
            if state.replayMap and state.visible then state.replayMap:CameraFrame()end
            if state.visible then
                local current=GetFrame(0)
                if current and GetCurrentUIState()=='game'and not (state.replay and state.replay.dialog)then
                    local ok,why=pcall(state.comparison.Frame,state.comparison,current.Width(),current.Height())
                    if not ok then
                        pcall(Observer.SuspendInspection)
                        pcall(Observer.ClearSelectionMarkers)
                        if not state.observerFrameFailed then WARN('S2R_OBSERVER_FRAME|'..tostring(why))end
                    end
                    state.observerFrameFailed=not ok
                else Observer.ClearSelectionMarkers()end
            end
            -- Native HUD owns another WorldView, independent of the optional
            -- minimap.lua Window. Give that real view this frame's physical
            -- hole bounds too; prepared desktop scale is not the live scale.
            if state.visible and not(type(SessionIsReplay)=='function'and SessionIsReplay())then
                local r=Layout.minimap.viewport;local factor=Layout.GetScale()
                pcall(UIIsConstructionEnabled,'RF:Mini',Layout.MinimapPhysical(r))
            end
            local current=GetFrame(0);if not current then return end
            local width,height=current.Width(),current.Height()
            if finite(width)and finite(height)and width>0 and height>0 and(width~=lastWidth or height~=lastHeight)then
                lastWidth=width;lastHeight=height;state.beat()
            end
        end
    end
    LOG('Reforged HUD '..version..': original simulation and native build validation retained.')
end
