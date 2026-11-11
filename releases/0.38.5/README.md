# Reforged 0.38.5

Fixed an AI opening stall observed in the supplied 0.38.4 Vanilla Plus match. Both Reforger controllers started and continued building mexes, but repeatedly reported `unverified-candidate-route` and `map-analysis-incomplete`. Neither built a factory before the match ended. No controller exception was logged.

The opening adapter recorded an unresolved land-route result while the incremental terrain scan was still running. It subsequently skipped that route because a route table already existed, even though the table was unvalidated. The opening validator kept rejecting it, and the infrastructure planner depended on a completed opening plan. This made a temporary deferral permanent.

AI6 retries unvalidated routes after terrain sampling and route budgets advance. Public ground-grid estimates retain their provenance separately from the amphibious commander's native route. A completed coarse search can inform the opening family without claiming native movement proof.

If analysis is still unresolved after eight seconds, an affordable, native-legal local factory quote can seed a temporary opening. The factory uses the ordinary placement and payment path. The temporary opening is reviewed and replaced when public map analysis succeeds. It does not invent enemy positions or movement capabilities. This also permits local production when a map has no usable public start markers.

## Validation

The new opening lifecycle suite runs the actual generated AI modules with controlled feedback for paid construction, completed children, unit production, movement and ordinary income. It exercises all three presets and factions across flat terrain, a water gap, missing start markers and deferred route budgets: 36 corrected cases. Three controls run the previous AI5 controller against the same environment and reproduce zero factories and an unresolved opening.

The corrected cases start a paid factory and produce completed combat units. On normal/deferred routes they also issue military movement and replace the temporary opening with a map-selected plan. The water controls preserve the distinction between commander reachability and the public ground-grid estimate.

These are 180-second controlled simulations, not playback of the supplied replay or execution of the native game. Construction costs are debited on submission in the fixture, rather than modeling the engine's entire payment/queue implementation. Terrain, path and native command adapters are explicit fixtures. No claim of measured competitive strength follows from these checks.

The existing 696 checks across normal Lua 5.1 and the restricted native string API also pass. Final indexed archives, custom research, server migration/restart and replay-to-game transitions are checked. Old no-AI-revision, AI4 and AI5 simulation hashes and source files are preserved. Installer extraction checks owned files and version metadata; the Linux installer is installed in isolated XDG directories. A live match retest remains necessary.

## Install and source

Install the 0.38.5 client and matching community server update so new games receive `evidence-ai-6`. The selected ladder patch remains pinned until an administrator selects the new publication. Historical patch files are retained.

The server ZIP contains its deployment overlay and changed client/native builder sources relative to 0.38.4. The GitHub release folder is a source update to the existing snapshot. Separately distributed native resources, packaging dependencies and a supported Steam installation remain prerequisites. Retail archives, raw game-derived fixtures, artwork, executables and credentials are excluded from GitHub.

With the original staged layout and supplied retail inputs:

```sh
node test-ai-assembly.cjs
PYTHONPATH=/path/to/lupa/python python3 test-ai-runtime.py
AI_SUITE=opening PYTHONPATH=/path/to/lupa/python python3 test-ai-runtime.py
PYTHONPATH=/path/to/lupa/python python3 test-lua-compat.py
node test-patch-migration.cjs
AI_REVISION=evidence-ai-6 node test-interface-build.cjs
AI_REVISION=evidence-ai-6 node test-interface-transition.cjs
```

Scripts retain their staged `work-0385`, `work-0384` and `orion-tooling` paths. Generate the profile catalog after native edits and before testing transitions. The Linux `.run` installer runs with Bash as a regular user.
