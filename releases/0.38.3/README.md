# Reforged 0.38.3

This release integrates the archive AI handoff and the follow-up implementation register under a new `evidence-ai-4` ruleset revision. Reforged Balance also includes the 0.38.2 Orion/Javelin blueprint startup repair. The Windows and Linux installers contain the same AI sources.

The controller services urgent local fights before background construction and production. It keeps executable work when a replacement cannot be submitted, retains damaged heavy units until they recover, and evaluates current weapon layers, minimum ranges, earned buffs and native command restrictions. Ground-only forces cannot satisfy bomber defense. Local group membership, allied missions, fighter cover and pending ability payments have separate lifetimes.

Research planning uses the active tree's alternative prerequisite semantics, confirms purchases before adding them to spending, and keeps active research prices. Factory outputs follow native build permission, including legal foreign units and mobile producers. Experimental plans look for a compatible gantry. Naval construction can start from a legal coastal site without an existing ship. Scripted parents, unselectable pods, Jackhammer deployment, Cicada costs, Hunker and Overcharge have explicit handling. Guarded teleport/jump orders reserve the entire admitted local group's cost.

Private projectile callbacks record a returned native projectile and a later impact separately. Target identity/health are never inspected from an impact callback. These events do not claim damage or kill attribution. Perception still requires the current army's native vision gate; radar uses only reported recon data and associations learned while visible. Income and veterancy bonuses remain disabled.

## Verification

- 87 Lua 5.1 contracts pass for retail + IWBP, Vanilla Plus, Reforged Balance and an edited tree: 348 checks. These execute generated blueprint hooks and actual controller/adapter modules against controlled native API fixtures.
- The blueprint loader runs without an `import` global, including the Orion and Javelin bindings.
- Final indexed archive checks cover all presets, edited research, HUD scaling and archive safety limits.
- Server migration upgrades all three active presets once. It preserves custom research, old patch files, pinned ladder selection and restart identity.
- Historical no-AI-revision gameplay keeps the 0.38.2 simulation hashes. Old AI2/AI3 sources are retained separately. AI4 sources are pinned by a source manifest; future changes require a new revision.
- Installer extraction verifies owned files and checksums. Linux installation is tested in isolated XDG directories. Linux Steam/Proton bridge tests use controlled launch adapters.

These are automated source and packaging checks. Live Windows and Proton matches were not run here. The handoff's 54 native playtest cases remain a playtest checklist, not completed evidence. Native zero-cap module accounting, capture/gift identity lifetimes, coastal navigation, real ability dispatch/animation and combat effectiveness need those sessions. Naval numerical balance is unchanged. No native API is invented when an issuing function is unavailable; the controller retains ordinary movement instead.

## Applying the update

Install the new client. Upgrade the community server with the matching server update so newly created games receive the AI4 patch. Existing ladder patch selection is preserved deliberately; an administrator must select the new published patch when the ladder should use it. Existing games and replays keep their selected historical ruleset.

The server ZIP contains the server overlay and changed client/native builder sources relative to 0.38.2. It is not a complete checkout of every prior native payload. The repository root remains the older source snapshot; this release folder is a source update. The separately distributed Reforged resources, packaging dependencies and a supported Steam game installation are prerequisites. Retail game archives, raw game-derived fixtures, artwork, executables and credentials are excluded from GitHub.

## Reproducing checks

With the separately supplied retail inputs and handoff fixture JSON in the paths used by the test scripts:

```sh
node test-ai-assembly.cjs
PYTHONPATH=/path/to/lupa/python python3 test-ai-runtime.py
node test-patch-migration.cjs
AI_REVISION=evidence-ai-4 node test-interface-build.cjs
AI_REVISION=evidence-ai-4 node test-interface-transition.cjs
node test-server.cjs
node test-linux-steam.cjs
node test-map-install.cjs
```

Generate the profile catalog after native edits and before the transition check. Packaging scripts expect the original staged layout (`work-0383`, the previous release layout, and `orion-tooling`); paths are documented directly in those scripts.
