# RaceLab release preparation — 2026-10-04

Historical 1.1.0 candidate report. Superseded by
[v2.0.0 stable validation](../V2.0.0-RELEASE-VALIDATION.md): F1 and Overlay
live-game acceptance passed and F1 is enabled by default in production.
The version and pending-gate statements below describe that earlier candidate.

This pass prepares the existing shared tree for release. It introduces no
product feature, redesign, version bump, backend contract change or networking
workaround. Continuous telemetry traces and reference-lap comparison remain
future analysis-API work.

## Packaging and repository audit

- Version remains **1.1.0** in package.json, Cargo.toml, tauri.conf.json and
  app-version.ts. The existing release test requires a deliberate decision to
  change it. Current UI labels use that version; historical release documents
  retain their historical versions.
- No generated executables, libraries, installers, build directories, logs,
  private recordings or debug backups are tracked. Keep `dist/`, `node_modules/`,
  `src-tauri/target/` and temporary validation output out of the release commit.
  Existing reviewed fixture binaries and design screenshots are intentional
  evidence, not disposable debug files.
- Added `.rlframes` and `.rlf1` ignore rules and strengthened the existing privacy
  test to include F1 recordings.
- Current production UI/assets contain no obsolete slash-logo paths, temporary
  test/debug text or blanket claim that F1 recording is unsupported. The
  “not recorded” message for FH6 recording ownership remains correct, as do
  disabled-build and missing-command errors. Historical design reports are
  retained as evidence of earlier stages.
- Geist Sans and Geist Mono remain bundled local variable WOFF2 assets, with no
  runtime font download. Built font hashes match their source assets. Fixed a
  shipping-license gap by copying the complete, unchanged SIL OFL to
  `public/licenses/Geist-OFL.txt`; Vite copies it into dist and Tauri embeds it.
  Font and license asset paths were confirmed in the release executable.
- The app executable embeds every approved ICO frame byte for byte, including
  the locked 16px optical master used for native title/taskbar icons. Installer
  resource inspection initially found the default NSIS icon. Explicit installer
  and uninstaller ICO configuration fixes that packaging gap; rebuilt installer
  resource frames match the approved ICO byte for byte. Uninstaller selection is
  verified through configuration; this pass does not install/uninstall the app.
- All 23 locked style/font/brand/icon/reference assets retain their previous
  hashes. No locked layout, typography, colors or telemetry hierarchy changed.

## Changes belonging to this pass

- `.gitignore`: exclude recording files.
- `public/licenses/Geist-OFL.txt`: ship the existing font license.
- `src-tauri/tauri.conf.json`: select the approved installer/uninstaller ICO.
- `tests/design-tokens.test.mjs`: guard the packaged license.
- `tests/release-config.test.mjs`: strengthen recording privacy and guard NSIS icons.
- `scripts/validate-design.mjs`: optional output directory so final screenshots
  need not overwrite committed historical validation evidence.
- This report and the accompanying release validation results.

The pre-existing `overlay_windows.rs` test edit was preserved. Concurrent QA
also changed `SessionList.tsx` to keep a selected row visible after list resizing
and updated `V2.0-OVERLAY-V1.md`; those changes were preserved and included in
final validation, rather than replaced or claimed as release-preparation work.

## Final validation

| Check                                  | Final result                                                   |
| -------------------------------------- | -------------------------------------------------------------- |
| Frontend full suite, serial            | 500 passed, 0 failed, 0 skipped                                |
| Rust normal full suite                 | 388 passed, 0 failed, 5 existing ignored checks                |
| Design/icon/release guards             | 38 passed; all original 36 preserved, 2 packaging guards added |
| Production build and review TypeScript | Passed                                                         |
| Prettier and Rust formatting checks    | Passed                                                         |
| Windows NSIS build                     | Passed; executable metadata is 1.1.0                           |
| Screenshot matrix                      | 69 passed: 23 scenarios at each requested size                 |
| Locked assets                          | All 23 hashes unchanged                                        |

The final matrix covers Home, generic/FH6/F1 Live, Sessions, FH6 analysis,
Settings, Diagnostics/F1 Diagnostics, all four F1 session tabs, long/missing
data, recording ownership and all six recorder phases. It verifies the shared
cursor against the current analysis API. There were no console errors,
document overflows or clipped F1 session evidence. Browser tests also cover
keyboard focus and the concurrent selected-row visibility fix.

Visual review found no design regression. Screenshot differences from the
earlier integration evidence include rolling dates/day groups and list scroll
positions; 32 of 69 images remain pixel-identical. Styles and optical masters
are unchanged. Every candidate source hash remained unchanged throughout the
final frontend and refreshed screenshot runs.

Machine-readable [release results](release-preparation/results.json) and
[screenshot results](release-preparation/screenshots.json) are retained. The
69 full screenshots and three contact sheets were generated in the temporary
validation directory, rather than added as duplicate historical assets.

The preliminary frontend run had 499 passes and one 20-second browser render
timeout in the 960×640 F1 Sessions case while compilation was also running.
The final full suite ran serially after packaging and passed; checks and timeouts are
unchanged. The five existing ignored Rust checks remain explicit: paced UDP
load, duration diagnosis, receiver controls requiring those traces, the
ten-minute recorder soak, and recovery requiring a real sessions directory.

## Release gates and limits

- The release candidate must be frozen and its outstanding shared-tree changes
  reviewed/committed before tagging. No commit or tag is made by this pass.
- The existing `v1.1.0` tag predates this candidate. Publishing these changes as
  a new release requires a deliberate version/tag decision; the pinned version
  has not been changed or silently reused for a new tag.
- **F1 is still disabled by default in release builds.**
  `F1_ENABLED_IN_RELEASE` remains false. Debug builds enable it; release builds
  require the existing explicit environment opt-in. Real-game Phase D lifecycle
  acceptance remains pending as documented in
  [the F1 recording report](../V2.0-PHASE-D-F1-RECORDING.md).
  Automated fixtures and real-file persistence tests do not satisfy that gate.
- The overlay already present in the shared tree also retains its documented
  live-game acceptance gate; see [its report](../V2.0-OVERLAY-V1.md).
- Final screenshots exercise production components with the isolated review
  backend. They are layout evidence, not a claim of newly captured game sessions.
- No continuous traces, reference-lap comparisons, new analysis contracts or
  UDP port workarounds were added.
