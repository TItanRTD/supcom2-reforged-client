# Reforged 0.38.4

Fixed the startup crash reported from 0.38.3 in `reforged_ai_catalog.lua:109`. The call chain failed while classifying factory outputs, before the simulation's AI controller started. The supplied log identifies Vanilla Plus with `evidence-ai-4`; the same new catalog is shared by all three presets.

The new code used string method syntax such as `token:sub(...)`. The game's blueprint VM does not provide those methods. It requires functional calls such as `string.sub(token, ...)`. Earlier tests used a Lua 5.1 string metatable and missed this difference.

The correction replaces string method calls throughout the new AI runtime, including category matching, ability selection and producer classification. It is published as `evidence-ai-5`. The previous AI4 source files and existing gameplay patch identities remain unchanged. New active presets receive AI5 when the server upgrades. The administrator's pinned ladder patch is preserved.

## Validation

`test-lua-compat.py` removes the Lua string method metatable and reproduces the old catalog failure at line 109. The corrected catalog classifies the same producer successfully. A compatibility gate rejects string method syntax in every AI5 Lua source.

`test-ai-runtime.py` now executes the generated import-free blueprint chain and actual AI modules in two fresh environments: normal Lua 5.1 and the restricted string API. Each runs 87 contracts across retail + IWBP, Vanilla Plus, Reforged Balance and an edited research tree: 696 checks. This includes the previously added combat, payment, command replacement, production and projectile callback checks.

Final archive generation, server migration/restart and replay-to-game transition checks are also run. Historical no-AI-revision and AI4 simulation hashes are compared with 0.38.3. Installer extraction checks owned file hashes and version metadata; the Linux installer is installed in isolated XDG directories.

These reproduce the reported compatibility failure and verify the corrected source and packaging. They are not a live Windows or Proton match. Native gameplay qualification from the larger AI handoff remains pending.

## Install

Install the 0.38.4 client and upgrade the community server with the matching server update so newly created games receive AI5. Existing ladder selection stays pinned until an administrator selects the corrected published patch. The Linux `.run` installer runs with Bash as a regular user; no sudo is required.

The server ZIP includes its deployment overlay and changed client/native builder sources relative to 0.38.3. The GitHub release folder is a source update to the existing snapshot, not a complete export of all historical native resources. Separately distributed Reforged resources, packaging dependencies and a supported Steam game installation remain prerequisites. Game archives, raw retail fixtures, artwork, executables and credentials are excluded from GitHub.

With the original staged layout and supplied retail inputs:

```sh
PYTHONPATH=/path/to/lupa/python python3 test-lua-compat.py
node test-ai-assembly.cjs
PYTHONPATH=/path/to/lupa/python python3 test-ai-runtime.py
node test-patch-migration.cjs
AI_REVISION=evidence-ai-5 node test-interface-build.cjs
AI_REVISION=evidence-ai-5 node test-interface-transition.cjs
node test-server.cjs
```

The scripts retain their staged `work-0384`, `work-0383` and `orion-tooling` paths. Generate the profile catalog after native edits and before testing transitions.
