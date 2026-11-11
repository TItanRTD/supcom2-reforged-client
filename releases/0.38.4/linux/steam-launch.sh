#!/usr/bin/env bash
# Steam prepends this launcher to its normal Proton command.
set -u
umask 077
mailbox=$1
shift
request=$mailbox/request
claim=$mailbox/request.$$.claimed
if [[ ! -O $request || ! -f $request || -L $request ]] || ! mv -T -- "$request" "$claim" 2>/dev/null; then
    exec "$@"
fi
trap 'rm -f -- "$claim"' EXIT
pass_through() {
    rm -f -- "$claim"
    exec "$@"
}
mapfile -d '' -t fields < "$claim"
if (( ${#fields[@]} < 4 )); then
    pass_through "$@"
fi
expires=${fields[0]} original=${fields[1]} replacement=${fields[2]} status=${fields[3]}
if [[ ! $expires =~ ^[0-9]{10}$ || $expires -lt $(date +%s) ||
      ${status%/*} != "$mailbox" || ! -O $status || ! -d $status || -L $status ]]; then
    pass_through "$@"
fi
fail() {
    printf '%s\n' "$1" > "$status/error"
    exit 125
}
[[ -f $original && -f $replacement ]] || fail 'The selected or prepared SupCom 2 executable is missing.'
command=("$@")
game_index=-1
for i in "${!command[@]}"; do
    value=${command[i]}
    [[ ${value,,} = */supremecommander2.exe && $value -ef $original ]] || continue
    (( game_index == -1 )) || fail 'Steam supplied more than one SupCom 2 executable.'
    game_index=$i
done
(( game_index >= 0 )) || fail 'Steam did not supply the selected game executable. Enable Proton for SupCom 2 and check the installation selected in Reforged.'
command[game_index]=$replacement
command+=("${fields[@]:4}")
cd -- "${replacement%/*}" || fail 'Could not open the prepared game folder.'
printf '%s\n' "$$" > "$status/started.tmp"
mv -T -- "$status/started.tmp" "$status/started"
"${command[@]}"
code=$?
printf '%s\n' "$code" > "$status/exit.tmp"
mv -T -- "$status/exit.tmp" "$status/exit"
exit "$code"
