from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from hashlib import file_digest

root=Path(__file__).resolve().parent
app=root/'app'
native=root/'payload/resources/native'
prior=root.parent/'work-0385/payload/resources/native'
out=root/'final/SupCom2-Reforged-0.38.6-Server-Update.zip'
notes=(root/'RELEASE.md').read_text()
with ZipFile(out,'w',ZIP_DEFLATED,compresslevel=6) as bundle:
    bundle.writestr('README.md',notes)
    for sub in ['dist/node/server','dist/node/shared','dist/web']:
        for p in sorted((app/sub).rglob('*')):
            if p.is_file():
                bundle.write(p,'server-overlay/'+p.relative_to(app).as_posix())
    for sub in ['hud','lobby','ai']:
        for p in sorted((native/sub).rglob('*')):
            if not p.is_file():continue
            dest=p.relative_to(native)
            baseline=prior/dest
            if baseline.is_file() and baseline.stat().st_size==p.stat().st_size:
                with baseline.open('rb') as a,p.open('rb') as b:
                    if file_digest(a,'sha256').digest()==file_digest(b,'sha256').digest():continue
            bundle.write(p,'builder-source/native/'+dest.as_posix())
    bundle.write(native/'profile-catalog.json.gz','builder-source/native/profile-catalog.json.gz')
    for f in ['native-lobby.js','profile-catalog.js','replay-version.js','map-install.js','main.js','preload.js','linux-steam.js','steam-runtime.js','native-host.js','hud-preferences.js']:
        bundle.write(app/'dist/node/desktop'/f,'builder-source/desktop/'+f)
    for p in sorted((root/'linux').iterdir()):
        if p.is_file():
            bundle.write(p,'builder-source/linux/'+p.name)
    for f in ['advance.cjs','catalog.cjs','test-linux-steam.cjs','test-interface-build.cjs','test-interface-transition.cjs','test-cache-recovery.cjs','test-archive-progress.cjs','test-managed-interface.cjs','test-preparation-monitor.cjs','test-blueprint-startup.cjs','test-blueprint-startup.py','test-patch-migration.cjs','test-ai-assembly.cjs','test-ai-runtime.py','ai-contracts.lua','ai-opening-sim.lua','opening-results.json','test-lua-compat.py','RELEASE.md','IMPLEMENTATION_STATUS.csv','package.cjs','setup.nsi','server-package.py','test-server.cjs','test-map-install.cjs','verify-installer.py']:
        bundle.write(root/f,'builder-source/patch-0386/'+f)
with ZipFile(out) as bundle:
    assert bundle.testzip() is None
    assert len(bundle.namelist())==len(set(bundle.namelist()))
    assert b"CLIENT_VERSION = '0.38.6'" in bundle.read('server-overlay/dist/node/shared/model.js')
    assert b'launch timeout' in bundle.read('server-overlay/dist/node/server/data/public-changelog.json')
    assert not any(n.endswith(('lua.scd','SupremeCommander2.exe','Game.prefs')) for n in bundle.namelist())
print(out.name,out.stat().st_size,'bytes')
