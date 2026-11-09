# Reforged 0.37.6 source update

- Classic factories have Units and Factory Add-ons tabs. ACUs and engineers keep Basic, Advanced, and Experimental.
- The researched Illuminate Tactical Missile Launcher appears on Combat page one. The Common grid reserves space for both Light Point Defense and the Anti-Air Tower.
- Reforged uses faction-colored queue art when the engine next updates the queue. Classic uses white queue art.
- New Reforged replay companions preserve available match-start Forge Ratings and player badges. The scoreboard places badges between the faction icon and the player name.

## Reviewing or applying the changes

The patches are the application and HUD changes from the 0.37.5 release build tree. Their paths are relative to that tree, with the application under `app` and integration resources under `payload/resources/native`. They include the JavaScript used by the release and the authored Lua and assembly changes. The root TypeScript project builds the earlier public snapshot.

The installer build also requires the game integration resources, an exact frozen 0.37.5 interface provider, a regenerated interface catalog, and a supported local game installation. The published patches contain source and tests. Retail game data, compiled integration payloads, artwork, executables, and deployment files are distributed separately.

The tests here exercise replay metadata with synthetic players, verify the optional x86 scoreboard return, and check that the HUD leaves queue refreshes to game notifications. They run from the release build tree with its existing runtime and test dependencies.
