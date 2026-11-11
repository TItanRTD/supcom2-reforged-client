"""Reproduce the reported AI4 line 109 panic without Lua string methods."""
from pathlib import Path
from lupa.lua51 import LuaRuntime
import re
root=Path(__file__).resolve().parent
factory="""{Unit={factory={BlueprintId='factory',Categories={'UEF','STRUCTURE','FACTORY','SELECTABLE'},Economy={MassValue=100,EnergyValue=100,BuildableCategory={'UEF MOBILE LAND'}}},tank={BlueprintId='tank',Categories={'UEF','MOBILE','LAND','SELECTABLE'},Economy={MassValue=100,EnergyValue=100}}}}"""
old=root/'payload/resources/native/ai/evidence-v4/catalog.lua'
new=root/'payload/resources/native/ai/evidence-v5/catalog.lua'
lua=LuaRuntime();lua.execute('debug.setmetatable("",nil)')
lua.execute('local f=assert(loadstring(...,"@/lua/system/reforged_ai_catalog.lua"));f()',old.read_text())
try:
 lua.execute('Build('+factory+')')
except Exception as error:
 assert ':109:'in str(error) and ('token'in str(error)or'sub'in str(error)),error
 print('Reproduced AI4 native string-method failure at catalog.lua:109 (same reported call site).')
else:raise AssertionError('Reported failure was not reproduced')
lua=LuaRuntime();lua.execute('debug.setmetatable("",nil)');lua.execute(new.read_text())
lua.execute('local d=Build('+factory+');assert(d.factory.outputs.land==true and d.factory.productionLayer=="land")')
for p in new.parent.glob('*.lua'):
 assert not re.search(r':(?:sub|lower|upper|find|match|gsub|gmatch|rep|format|byte|len)\(',p.read_text()),p
print('AI5 producer classification succeeds without string methods; all AI5 runtime sources pass the same compatibility gate.')
