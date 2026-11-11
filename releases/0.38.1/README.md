# Reforged 0.38.1 launch hotfix

Reforged Balance could fail before the game started with `Expanded archive exceeds limit`.
The complete final archive contains about 458 MiB after decompression, exceeding the
448 MiB roster bound. The roster-only expanded limit is now 512 MiB. The 144 MiB
compressed cap, 16 MiB per-entry cap, entry-count bound, CRC checks and path validation remain.

`hotfix.patch` applies to the distributed 0.38.0 builder/client source layout.
The repository root remains the older source snapshot described in its README.
This update does not contain game binaries, game-derived fixtures or native artwork.
`advance.cjs` records how the old generator is frozen for replay reconstruction.

The Linux folder includes the Steam/Proton bridge and packaging scripts used by
the native preview, including the new single-file `.run` installer. It installs
per-user, verifies its embedded payload and creates the application menu entry.
It requires the separate release payload and official Electron runtime to build.

## Validation

The final indexed archive, including TOC mapping and ZIP verification, passed for
all three gameplay presets. Reforged Balance was also checked with published
research at the maximum 2.5 HUD scale. The 1.125-scale reproduction expands to
479,774,849 bytes; the published-research/2.5 build expands to 480,205,329 bytes.
The regression fixture fails under the previous archive reader and passes under
the corrected reader. Invalid paths and CRCs are still rejected.

The tests require the separately supplied release layout and inspected retail
`ui.scd`, `lua.scd`, `toc.win.bdf` and `ui.scd.enc`. Paths can be provided with
`NATIVE_ASSETS`, `PACKAGED_APP` and `RETAIL_INPUTS`. These proprietary fixtures are
not included in this repository. Run `node test-interface-build.cjs` and
`node test-interface-transition.cjs` from the release source layout.

This hotfix does not change the AI, weapons, costs or research rules. The dense
AI handoff is a separate integration. Live Steam/Proton multiplayer testing is
still pending; installer tests do not establish game compatibility.
