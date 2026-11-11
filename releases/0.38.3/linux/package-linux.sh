#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
version=0.38.3
bundle=SupCom2-Reforged-$version-Linux-x86_64
stage=$root/build/$bundle
mkdir -p "$stage/client"
electron=$root/build/electron-v45.2.3-linux-x64.zip
printf '%s  %s\n' a87fe741f6d121285117e574da6c9a2e65210d410123bbc04713b099add0263b "$electron" | sha256sum -c -
if [[ ! -x $stage/client/supcom2-reforged ]]; then
    unzip -q "$electron" -d "$stage/client"
    mv "$stage/client/electron" "$stage/client/supcom2-reforged"
fi
cp "$root/payload/resources/app.asar" "$stage/client/resources/app.asar.tmp"
mv "$stage/client/resources/app.asar.tmp" "$stage/client/resources/app.asar"
if [[ ! -d $stage/client/resources/native ]]; then
    cp -al "$root/payload/resources/native" "$stage/client/resources/"
fi
mkdir -p "$stage/client/resources/"{linux,branding}
install -m 0755 "$root/linux/steam-launch.sh" "$stage/client/resources/linux/"
install -m 0755 "$root/linux/install.sh" "$stage/"
cp "$root/linux/README.md" "$stage/"
python3 - "$root/payload/resources/branding/icon.ico" "$stage/client/resources/branding/icon.png" <<'PY'
from PIL import Image
from sys import argv
Image.open(argv[1]).save(argv[2])
PY
printf '%s\n' "$version" > "$stage/client/.reforged-linux-release"
if [[ ${1:-} != '--stage-only' ]]; then
    out=$root/final/$bundle.tar.xz
    trap 'rm -f "$out.tmp"' EXIT
    tar -C "$root/build" --owner=0 --group=0 --numeric-owner -cf - "$bundle" | xz -T2 -3 > "$out.tmp"
    mv "$out.tmp" "$out"
fi
