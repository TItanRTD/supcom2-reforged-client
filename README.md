# Supreme Commander 2 Reforged Client

Reforged is an independent community project for Supreme Commander 2. The
Windows client provides multiplayer lobbies, matchmaking, a map browser, a
replay library, and balancing.

This repository is a source snapshot of client version **0.33.6**. It contains
the Electron desktop code, renderer, and shared and local server code used by
the client. This snapshot supports source review, compilation, and tests.

The [0.37.6 source update](releases/0.37.6/README.md) includes the build menu,
HUD, and replay scoreboard changes with regression tests.

The [0.37.7 source update](releases/0.37.7/README.md) includes ability ranges,
construction prices, Caster recognition, and leaderboard changes.

The [0.37.8 source update](releases/0.37.8/README.md) fixes the Jump Jet and
Teleport range indicators.

The [0.38.1 source update](releases/0.38.1/README.md) fixes the archive size
check that blocked Reforged Balance launches and adds the Linux installer source.

The [0.38.2 source update](releases/0.38.2/README.md) repairs the Orion and
Javelin blueprint startup hooks and includes an import-free startup regression.

The [0.38.3 source update](releases/0.38.3/README.md) integrates the AI handoff,
local combat and recovery, active research planning, and versioned replay rules.

The playable client requires the separately distributed Reforged installer,
its native integration resources, and a supported Steam installation of
Supreme Commander 2. The installer, native gameplay payloads, game-derived
fixtures and artwork, and production deployment files are excluded. The
Reforged playtest still handles installer access. See the [project
website](https://supcom2reforged.com/) for project information.

## Build and test

Use Node.js 24.15 or a newer 24.x release. From the repository root, run:

```sh
npm ci --ignore-scripts
npm test
```

The tests compile the desktop, renderer, and supporting code, then exercise
Steam lobby links, local map parsing, and replay library behavior using
synthetic fixtures.

## License

The project code is available under the [MIT license](LICENSE).
[Vendored dependency notices](src/server/vendor/LICENSES.txt) apply to their
respective dependencies.

Supreme Commander 2 © 2010 Square Enix, Inc. All rights reserved. SUPREME
COMMANDER is a registered trademark of Square Enix, Inc. Reforged is an
independent community project and is not affiliated with Square Enix or Gas
Powered Games.
