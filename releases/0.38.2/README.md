# Reforged 0.38.2 startup repair

Reforged Balance could abort while RuleInit loaded the unit blueprint hooks.
The Orion and Javelin binding hooks used `import` before that function existed
in the blueprint VM. They now load their pure data helpers through `doscript`
with an environment inheriting the blueprint globals. Historical replay
composition applies the same loading repair while retaining recorded unit data.

The server publishes a new `0382` Reforged Balance compiler identity and retains
old patch files, research publications and the selected ladder patch. The AI
behavior is unchanged by this repair.

`startup.patch` applies to the distributed 0.38.1 source layout. The repository
root remains the older source snapshot. Retail game files, native artwork and
other game-derived fixtures are not included.

The regression test reproduces the old failure at roster line 647 with `import`
absent, then loads the complete extension chain and registers its blueprints.
Live and replay registration pass; Orion mesh/beam and Javelin mesh/bomb bindings
are asserted. Vanilla Plus registration and stock-profile isolation also pass.
The final archive build is checked for all three presets, including custom
research at HUD scale 2.5. These are Lua and packaging tests, not native matches.

Use the separate 0.38.2 installer and server overlay for distribution. The tests
require the inspected retail files and release layout, as documented in the
0.38.1 source update.
