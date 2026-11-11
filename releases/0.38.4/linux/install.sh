#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
[[ $data_home = /* && $data_home != *[$'\r\n"$`\\%']* ]] ||
    { printf '%s\n' 'Use a standard absolute XDG_DATA_HOME path.' >&2; exit 1; }
base=$data_home/supcom2-reforged
version=0.38.4
destination=$base/$version
applications=$data_home/applications
mkdir -p -- "$base" "$applications"
[[ ! -L $base && ! -L $destination ]] || { printf '%s\n' 'Choose a regular Reforged installation directory.' >&2; exit 1; }
if [[ -e $base/current && ! -L $base/current ]]; then
    printf '%s\n' 'The Reforged current path is already occupied.' >&2
    exit 1
fi

stage=$(mktemp -d "$base/.install.XXXXXXXX")
entry=$(mktemp "$applications/.supcom2-reforged.XXXXXXXX")
trap 'rm -rf -- "$stage"; rm -f -- "$entry"' EXIT
if [[ ! -e $destination ]]; then
    cp -a -- "$source_dir/client" "$stage/client"
    mv -T -- "$stage/client" "$destination"
elif [[ ! -f $destination/.reforged-linux-release ]] ||
     [[ $(<"$destination/.reforged-linux-release") != "$version" ]]; then
    printf '%s\n' 'This version folder does not belong to Reforged.' >&2
    exit 1
fi
ln -s -- "$version" "$stage/current"
mv -Tf -- "$stage/current" "$base/current"
cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=Supreme Commander 2 Reforged
Exec="$base/current/supcom2-reforged"
Icon=$base/current/resources/branding/icon.png
Terminal=false
Categories=Game;StrategyGame;
EOF
chmod 644 "$entry"
mv -T -- "$entry" "$applications/supcom2-reforged.desktop"
printf '%s\n' 'Installed Supreme Commander 2 Reforged.' 'Open it from your application menu.'
