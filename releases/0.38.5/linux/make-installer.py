#!/usr/bin/env python3
"""Wrap the verified Linux bundle in a per-user, self-extracting installer."""
from hashlib import file_digest
from pathlib import Path
import os
import subprocess

root = Path(__file__).resolve().parents[1]
version = '0.38.5'
bundle = f'SupCom2-Reforged-{version}-Linux-x86_64'
archive = root / 'build' / (bundle + '.tar.xz')
output = root / 'final' / f'SupCom2-Reforged-{version}-Linux-x86_64-Setup.run'
with archive.with_suffix('.tmp').open('wb') as stream:
    tar = subprocess.Popen(['tar', '-C', str(root / 'build'), '--owner=0', '--group=0',
                            '--numeric-owner', '-cf', '-', bundle], stdout=subprocess.PIPE)
    packed = subprocess.run(['xz', '-T2', '-3'], stdin=tar.stdout, stdout=stream)
    tar.stdout.close()
    assert tar.wait() == 0 and packed.returncode == 0
archive.with_suffix('.tmp').replace(archive)
with archive.open('rb') as stream:
    checksum = file_digest(stream, 'sha256').hexdigest()

header = '''#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == --help ]]; then
    printf '%s\\n' 'Supreme Commander 2 Reforged VERSION for Linux x86-64' \\
        'Run this installer as your regular user. No sudo is needed.' \\
        'Usage: bash INSTALLER.run [--extract DIRECTORY]'
    exit 0
fi
if [[ $# -gt 0 && ( $# -ne 2 || $1 != --extract ) ]]; then
    printf '%s\\n' 'Use --help for installer options.' >&2
    exit 2
fi
for command in tail awk sha256sum tar xz mktemp; do
    command -v "$command" >/dev/null || { printf 'Required command missing: %s\\n' "$command" >&2; exit 1; }
done
payload=$(awk '/^__REFORGED_PAYLOAD__$/ {print NR+1; exit}' "$0")
[[ $payload =~ ^[0-9]+$ ]] || { printf '%s\\n' 'Installer payload is missing.' >&2; exit 1; }
printf '%s\\n' 'Checking the installer...'
actual=$(tail -n +"$payload" "$0" | sha256sum)
[[ ${actual%% *} == CHECKSUM ]] || { printf '%s\\n' 'Installer checksum failed. Download it again.' >&2; exit 1; }
if [[ ${1:-} == --extract ]]; then
    [[ ! -e $2 ]] || { printf '%s\\n' 'Extraction directory must not already exist.' >&2; exit 1; }
    mkdir -p -- "$2"
    tail -n +"$payload" "$0" | tar -xJf - -C "$2" --no-same-owner
    printf '%s\\n' 'Extracted the Reforged installer.'
else
    stage=$(mktemp -d "${TMPDIR:-/tmp}/supcom2-reforged.XXXXXXXX")
    trap 'rm -rf -- "$stage"' EXIT
    printf '%s\\n' 'Installing Supreme Commander 2 Reforged...'
    tail -n +"$payload" "$0" | tar -xJf - -C "$stage" --no-same-owner
    "$stage/BUNDLE/install.sh"
fi
exit 0
__REFORGED_PAYLOAD__
'''.replace('VERSION', version).replace('CHECKSUM', checksum).replace('BUNDLE', bundle)
temporary = output.with_suffix('.tmp')
with temporary.open('wb') as stream, archive.open('rb') as payload:
    stream.write(header.encode('utf-8'))
    while chunk := payload.read(8 * 1024 * 1024):
        stream.write(chunk)
os.chmod(temporary, 0o755)
temporary.replace(output)
print(output.name, output.stat().st_size, 'bytes')
