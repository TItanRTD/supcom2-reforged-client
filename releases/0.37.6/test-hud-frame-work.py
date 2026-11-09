"""Check bounds publication cadence and range detail using actual HUD Lua."""
from pathlib import Path
import os
from lupa.lua51 import LuaRuntime

root = Path(__file__).resolve().parents[1]
hud = Path(os.environ.get('S2R_NATIVE', root / 'payload/resources/native')) / 'hud'
lua = LuaRuntime()
lua.execute(r'''
now=0; mode='reforged'; revision=0; calls=0; refreshes=0; nativeReady=false; styles={}
function GetSystemTimeSeconds() return now end
function LOG() end
function UIConstructionOnQueueChanged() refreshes=refreshes+1 end
function GetRolloverInfo(_,name,value)
 if name=='rf_queue_color' then assert(nativeReady);styles[#styles+1]=value;return true end
 calls=calls+1
 return nativeReady
end
local layout={
 GetMode=function() return mode end,GetRevision=function() return revision end,
 GetScale=function() return 1 end,NativeRect=function() return 1,2,3,4 end
}
function import() return layout end
Controls={{name='one'},{name='two'}}
''')
lua.execute((hud / 'reforged_nativehud.lua').read_text())
lua.execute(r'''
Update(1920,1080);assert(calls==2 and #styles==0 and refreshes==0)
calls=0;nativeReady=true
for frame=0,59 do now=frame/60;Update(1920,1080)end
assert(calls==8 and refreshes==0 and #styles==1 and styles[1]==1)
mode='classic';revision=revision+1
Update(1920,1080);assert(calls==10 and refreshes==0 and #styles==2 and styles[2]==0)
Update(2560,1440);assert(calls==12 and refreshes==0)
-- At startup, the native scene may still be unavailable on the first
-- layout pass. Retry the bounds promptly once the scene is ready.
nativeReady=false
Update(3840,2160);assert(calls==14 and refreshes==0)
nativeReady=true
Update(3840,2160);assert(calls==16 and refreshes==0)
Update(3840,2160);assert(calls==16 and refreshes==0)
''')
# Run the real bootstrap wrapper with the native callback substituted.
lua = LuaRuntime()
lua.execute(r"""
queueEvents=0; nativeRefreshes=0; attached=false; gameUIHidden=false
function LOG() end
function WARN(message) error(message) end
function GetGameParent() return {} end
function UIConstructionOnQueueChanged() nativeRefreshes=nativeRefreshes+1 end
function doscript()
    CreateUI=function() end
    OnQueueChanged=function(queue)
        assert(queue=='queue-data')
        queueEvents=queueEvents+1
    end
end
function import() return {Create=function() attached=true end} end
""")
lua.execute((hud / 'bootstrap.lua').read_text())
lua.execute(r"""
CreateUI(false)
assert(attached and nativeRefreshes==0)
OnQueueChanged('queue-data')
assert(queueEvents==1 and nativeRefreshes==0)
gameUIHidden=true
OnQueueChanged('queue-data')
assert(queueEvents==2 and nativeRefreshes==1)
""")
# Exercise the internal geometry chooser without mocking the chooser itself.
lua = LuaRuntime()
lua.execute(r'''
local geometry={Finite=function(n)return type(n)=='number' and n==n and math.abs(n)<math.huge end}
function import(path)
 if path=='/lua/ui/game/reforged_geometry.lua' then return geometry end
 return {}
end
zoom=1
view={Project=function(_,p)return{p[1]*zoom,p[3]*zoom}end}
ring={center={1,0,1},radius=100}
''')
lua.execute((hud / 'reforged_controls.lua').read_text() + '\nTestRingDetail=ringDetail\n')
lua.execute(r'''
zoom=0.1;assert(TestRingDetail(view,ring)==16)
zoom=1;assert(TestRingDetail(view,ring)==32)
zoom=16;assert(TestRingDetail(view,ring)==64)
view.Project=function()return nil end
assert(TestRingDetail(view,ring)==64)
''')
print('Unchanged native bounds publish four times per simulated second, with immediate HUD and resolution changes. Queue refresh follows game notifications. Range detail scales with screen footprint.')
