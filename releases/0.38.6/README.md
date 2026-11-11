# Reforged 0.38.6

Fixed a launch-preparation timeout while checking a saved interface. The supplied 0.38.5 launch record reached saved-interface verification, then reported no progress for 91 seconds before the preparation worker's 90-second stall guard stopped it. The game process had not started.

The recovery path could reconstruct a chain of historical gameplay interfaces before reaching the existing clean-runtime fallback. Those expensive reconstructions did not report intermediate progress. This release checks only the requested interface during managed recovery. If its bytes differ, it requests the existing fresh-runtime path immediately instead of searching older versions.

The generated target is reused during that retry. The clean copy is verified and promoted back into the established executable directory. Previous prepared data remains in an owned archive, and the executable path used by firewall permissions is retained. Original Steam inputs are not edited. A valid current interface can be reused; the returned in-memory proof avoids another build during later launches in the same client session.

Packing and CRC verification now report progress after completed archive entries. These are actual work updates, not timer heartbeats. The 90-second no-progress and 240-second overall guards remain unchanged. Archive bounds, CRC checks and deterministic archive bytes are retained.

## Verification

- A regression executes the real old and new recognition control flow with deterministic builders. Three simulated 31-second old reconstructions reproduce the no-progress timeout. Managed recovery now requests a clean copy after one current-interface check, with the previous files unchanged.
- Current-interface and warm-proof controls verify bounded reuse. Changed restore backups remain protected. A verified control baseline still works when the optional catalog is unavailable.
- Real archive compression and CRC callbacks are checked against 0.38.5 for byte-identical output.
- A full Reforged Balance archive with edited research is prepared from an older AI6 interface through actual managed directory creation and promotion. The test verifies one target build, the retained old archive and user file, unchanged original game inputs, map filenames, stable directory and warm-cache reuse. Its synthetic executable is never executed.
- The real preparation monitor is tested with a virtual clock. Distinct completed-work updates keep a healthy worker alive. Silence and repeated identical messages still time out; stopped workers release ownership and overlapping writers are rejected.
- Final archive/profile checks cover all three presets and edited research. Replay-to-current transitions use the clean-copy path. Existing gameplay identities and AI6 remain unchanged. Installer extraction checks owned-file hashes and version metadata; the Linux installer is installed in isolated XDG directories.

These verify preparation and packaging, not a native multiplayer match. Retest launching on the affected PCs after installation.

## Update

Update the clients and room server to 0.38.6. Ranked matchmaking requires matching client/server release versions. Gameplay patches, research publications, AI6 and the selected ladder patch are preserved; no balance patch selection is required for this repair.

The server ZIP contains its deployment overlay and changed client/native builder sources relative to 0.38.5. The GitHub release folder is a source update to the existing snapshot. Separately distributed Reforged resources, packaging dependencies and a supported Steam game installation remain prerequisites. Retail archives, raw game-derived fixtures, artwork, executables and credentials are excluded from GitHub.

With the original staged layout:

```sh
node test-cache-recovery.cjs
node test-archive-progress.cjs
node test-preparation-monitor.cjs
node test-managed-interface.cjs
node test-patch-migration.cjs
AI_REVISION=evidence-ai-6 node test-interface-build.cjs
AI_REVISION=evidence-ai-6 node test-interface-transition.cjs
node test-ai-assembly.cjs
node test-server.cjs
```

The full archive tests require the supplied retail inputs. Scripts retain staged `work-0386`, `work-0385` and `orion-tooling` paths. Generate the profile catalog after native edits and before testing managed recovery. The Linux `.run` installer runs with Bash as a regular user.
