# Reforged 0.37.7 source update

- Clear hidden build slots on Classic tier changes and use Units and Factory Add-ons for factories.
- Refresh construction prices in both HUDs when applicable cost research completes.
- Draw native Jump Jet and Teleport boundaries with a translucent terrain overlay while aiming.
- Add Caster recognition to player profiles, the lobby, and replay scoreboards.
- Show the canyon banner on the leaderboard and refresh the results as filters change.

## Source layout

These patches apply to the 0.37.6 release build tree. They cover the shipped JavaScript, Lua, and assembly changes, with regression fixtures in a separate patch. The root TypeScript project builds the earlier public snapshot.

The build also requires the 0.37.6 frozen interface provider, a regenerated profile catalog, native integration resources, the five range textures, the Caster badge artwork, the leaderboard banner, and a supported game installation. The release packages carry the asset updates. Rebuild the overlay payload from the included x86 source and regenerate the interface archive and profile catalog together.

The regression fixtures cover Classic slot visibility and research cost updates, site filter changes, and Caster badge serialization. Native Windows gameplay still needs a playtest.
