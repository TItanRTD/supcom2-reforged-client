"""Run the packaged hook chain with RuleInit's import-free Lua environment.

Native registration callbacks are modeled using supplied retail blueprint data.
This is a startup/registration test, not an engine playtest.
"""
import json
from pathlib import Path
from zipfile import ZipFile
from lupa.lua51 import LuaRuntime

root=Path(__file__).resolve().parent
fixtures=json.loads((root/'build/startup-fixtures.json').read_text())
units=json.loads((root.parent/'ai-handoff/SupCom2-Reforged-Complete-AI-Handoff/studies/10-land-air-decisions/inputs/units.json').read_text())
with ZipFile(root.parent/'orion-base/retail/uncompiled_lua.scd') as archive:
    projectiles={name.replace('\\','/').lower().removeprefix('uncompiled'):archive.read(name).decode()
                 for name in archive.namelist() if name.lower().endswith('_proj.bp')}

def table(lua,value):
    if isinstance(value,dict):return lua.table_from({k:table(lua,v) for k,v in value.items()})
    if isinstance(value,list):return lua.table_from([table(lua,v) for v in value])
    return value

def run(which,expect_failure=False):
    lua=LuaRuntime()
    lua.globals().files=table(lua,fixtures[which])
    lua.globals().unitData=table(lua,units)
    lua.globals().projectileData=table(lua,projectiles)
    lua.execute('''
        assert(import == nil)
        all={Unit=unitData,Mesh={},Weapon={},Projectile={},RawAnim={}}
        function LOG() end
        function Sound(v)return v end
        function ModBlueprints() end
        local loaded={}
        local source
        function doscript(file,env)
            file=file:lower():gsub('\\\\','/')
            if file=='/lua/system/rf026_blueprints_original.lua' then return end
            local code=assert(files[file:sub(2)], 'Missing packaged dependency '..file)
            local chunk=assert(loadstring(code,'@'..file))
            setfenv(chunk,env or getfenv(2))
            local old=source;source=file
            local result=chunk();source=old
            loaded[file]=true
            return result
        end
        function UnitBlueprint(bp) all.Unit[bp.BlueprintId]=bp end
        function MeshBlueprint(bp) all.Mesh[bp.BlueprintId]=bp end
        function WeaponBlueprint(bp) all.Weapon[bp.BlueprintId]=bp end
        function ProjectileBlueprint(bp)
            bp.Source=bp.Source or source
            all.Projectile[bp.Source]=bp
        end
        function RawAnimBlueprint(bp) for id,v in pairs(bp)do all.RawAnim[id]=v end end
        for id,bp in pairs(all.Unit) do
            bp.BlueprintId=id
            local faction=id:sub(2,2)=='i' and 'illuminate' or id:sub(2,2)=='c' and 'cybran' or 'uef'
            bp.Source='/units/'..faction..'/'..id..'/'..id..'_unit.bp'
        end
        for path,code in pairs(projectileData)do
            source=path
            assert(loadstring(code,'@'..path))()
        end
        for path,code in pairs(files)do
            if path:match('%.bp$') and path:match('^projectiles/')then
                source='/'..path
                assert(loadstring(code,'@'..path))()
            end
        end
    ''')
    try:
        lua.execute("doscript('/lua/system/blueprints.lua',getfenv(1))")
    except Exception as error:
        if expect_failure:
            assert 'reforged_unit_handoff_03711.lua:647' in str(error) and 'import' in str(error), str(error)
            print('Reproduced 0.38.1 startup failure at Orion binding line 647 with import absent.')
            return
        raise
    assert not expect_failure, 'Old fixture unexpectedly loaded'
    lua.execute('ModBlueprints(all)')
    if which!='plus':
        lua.execute('''
            local orion=assert(all.Unit.rfihp01)
            local gun=assert(all.Weapon[orion.Weapons[1]])
            assert(gun.BeamLifetime==3 and gun.TurretBoneMuzzle=='Muzzle01')
            assert(all.Mesh[orion.Display.MeshBlueprint].LODs[1].MeshName:find('rf03718_orion'))
            local javelin=assert(all.Unit.rfujv01)
            local bomb=assert(all.Weapon[javelin.Weapons[1]])
            assert(bomb.Damage==1300 and bomb.DamageRadius==9)
            assert(bomb.ProjectileId=='/projectiles/uef/ucarpetbomb01/rf03721_javelincharge_proj.bp')
            assert(javelin.Display.UniformScale==.245)
            assert(all.Mesh[javelin.Display.MeshBlueprint].LODs[1].MeshName:find('rf03721_javelin'))
            assert(import==nil)
        ''')
    print(which,'startup and complete registration chain passed without import.')

run('before',True)
for profile in ['after','replay','plus']: run(profile)
