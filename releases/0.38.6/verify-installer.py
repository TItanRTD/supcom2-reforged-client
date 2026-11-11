from pathlib import Path
from hashlib import file_digest
import json
import os
import subprocess
import sys

import pefile

base = Path(__file__).resolve().parent
setup = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else base / 'final/SupCom2-Reforged-0.38.6-Setup.exe'
output = setup.parent.parent / ('verified-' + setup.parent.name)
tooling = base.parent / 'orion-tooling'
subprocess.run([
    str(tooling / '7zip/usr/lib/7zip/7z'), 'x', '-y', '-bb0', '-bso0',
    '-o' + str(output), str(setup),
], check=True)
manifest, = output.rglob('owned-files.json')
payload = manifest.parents[2]
plan = json.loads(manifest.read_text())
assert plan['version'] == '0.38.6'
assert manifest.read_bytes() == (base / 'payload/resources/installer/owned-files.json').read_bytes()
actual = {p.relative_to(payload).as_posix() for p in payload.rglob('*') if p.is_file() and p != manifest}
expected = {entry['path'] for entry in plan['files']}
assert actual == expected and expected <= set(plan['owned'])
for entry in plan['files']:
    with (payload / entry['path']).open('rb') as stream:
        assert file_digest(stream, 'sha256').hexdigest() == entry['sha256'], entry['path']
assert 0 < setup.stat().st_size < 512 * 1024 * 1024
for file in [setup, payload / 'Supreme Commander 2 Reforged.exe']:
    pe = pefile.PE(str(file), fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']])
    info, = pe.VS_FIXEDFILEINFO
    assert (info.FileVersionMS, info.FileVersionLS, info.ProductVersionMS, info.ProductVersionLS) == (38,393216,38,393216)
    if file == setup:
        assert pe.OPTIONAL_HEADER.DATA_DIRECTORY[4].Size == 0
    pe.close()
subprocess.run([str(tooling / 'node/node_modules/.bin/asar'), 'extract',
                str(payload / 'resources/app.asar'), str(output / 'app')], check=True)
app = output / 'app'
assert json.loads((app / 'package.json').read_text())['version'] == '0.38.6'
assert "CLIENT_VERSION = '0.38.6'" in (app / 'dist/web/shared/model.js').read_text()
assert "CLIENT_VERSION = '0.38.6'" in (app / 'dist/node/shared/model.js').read_text()
assert "ROSTER_COMPILER='0382'" in (app / 'dist/node/server/gameplay.js').read_text()
assert "ACTIVE_AI='evidence-ai-6'" in (app / 'dist/node/server/gameplay.js').read_text()
assert (payload / 'resources/native/ai/evidence-v6/operations.lua').is_file()
assert (output / '$PLUGINSDIR/modern-wizard.bmp').read_bytes() == (base / 'build/modern-wizard.bmp').read_bytes()
assert (output / '$PLUGINSDIR/UAC.dll').is_file()
subprocess.run(['node', str(base / 'test-server.cjs')], env={**os.environ,'PACKAGED_APP':str(app)}, check=True)
assert (payload / 'resources/native/hud/unit-handoff-03721/assets.zip').is_file()
with setup.open('rb') as stream:
    print('Installer SHA-256',file_digest(stream,'sha256').hexdigest())
print('Verified',len(actual),'extracted files, full installer metadata, server, and packaged Javelin assets.')
