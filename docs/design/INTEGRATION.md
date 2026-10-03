# RaceLab v1 — F1 integration pass

The approved v1 design remains locked. This pass reconciles the latest shared
F1 recording implementation with its presentation and verifies the combined tree.
No styling, font, icon, navigation geometry or telemetry hierarchy was redesigned.

## The original three failures

| Test                                                                 | Cause                                                                                            | Resolution                                                                                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard-architecture.test.mjs`: telemetry polling is started once | Its allowlist knew five owners; Phase D added the shell-owned `useF1RecorderStatus` loop.        | Recognize the sixth owner and assert exactly one unconditional App invocation. Workspaces must still own no polling loop.                                                       |
| `f1-live.test.mjs`: F1 active with its own tabs                      | The assertion expected recording to be unavailable. Phase D now supplies actual recorder status. | Preserve the shared-tree correction to assert the idle recorder. Added coverage verifies candidate, recording, grace, ending, disabled and failure states.                      |
| `f1-live.test.mjs`: Sessions and Settings render isolation           | It expected the obsolete “F1 is not recorded” note. Phase D exposes unified FH6/F1 history.      | Preserve the shared-tree correction and render-isolation assertions; mixed history, filters, F1 detail and recorder render isolation have additional behavior/browser coverage. |

The locked redesign's final non-browser run was 425 tests: 422 passed, three
failed. At the start of this pass, two corrections had already landed in the
shared tree: 425 tests, 424 passed, one failed. Those corrections were retained.

An initial expanded full run also caught an obsolete setup-copy assertion and
four instances of a browser geometry false positive. The setup assertion now
checks the two-game instructions. The latest shared browser checker measures
visible text nodes, excluding the visually hidden best-lap accessibility label;
visible cell bounds, overlap, clipping and focus checks remain enforced.
No test was removed or skipped to conceal a regression.

A later concurrent run had 478 passes and one browser render-startup timeout;
the same scenario passed earlier. Final validation runs the complete frontend
suite with `--test-concurrency=1` to avoid contention between validation browsers.

## Files reconciled

Direct edits in this pass:

- `src/components/shell/Sidebar.tsx`: REC follows the actual recording owner,
  including F1, through the existing indicator and a coarse store subscription.
- `src/telemetry/f1-recording.ts`: shared recorder presentation for exact phase,
  write-error and status-read failure messages using existing semantic tones.
- `src/telemetry/shell-view-model.ts` and
  `src/views/live/f1/F1OverviewTab.tsx`: consume that presentation without
  subscribing surrounding instruments to recorder duration ticks.
- `src/views/DiagnosticsView.tsx`: remove obsolete copy claiming F1 telemetry
  cannot reach Live or Sessions.
- `tests/dashboard-architecture.test.mjs`, `tests/f1-sessions.test.mjs`,
  `tests/product-states.test.mjs`, `tests/support/shell.mjs`: owner, lifecycle,
  error and setup checks; reset active-game state to prevent fixture leakage.
- `review/mock-backend.ts`: development-only recorder-phase/error scenarios,
  preserving the shared F1 fixtures and unified session responses.
- `scripts/validate-design.mjs`: an integration matrix in a separate output
  directory, keeping the approved redesign validation artifacts intact.
- This report and `integration/` validation evidence.

Preserved and exercised the shared F1 implementation in `src/App.tsx`,
`src/state/stores.ts`, `src/hooks/use-f1-recorder-status.ts`, `src/f1-sessions.ts`,
`src/session-controller.ts`, `src/session-state.ts`, `src/hooks/use-sessions.ts`,
`src/views/sessions/SessionList.tsx`, `src/views/sessions/F1SessionDetail.tsx`,
`src/workspaces/SessionsWorkspace.tsx`, `src/components/shell/TopBar.tsx`,
`src/components/FirstRunGuide.tsx`, `src/workspaces/HomeWorkspace.tsx`,
`review/f1-session-fixtures.ts`, `tests/f1-live.test.mjs` and
`tests/browser-f1-sessions.test.mjs`. Files were reconciled in place.

## Integrated functionality and boundaries

F1 recording has a single shell-level polling owner. Global REC names the game
that owns recording even when Live presents the other game. The sidebar uses
the same ownership decision. Live and status details show recorder phases and
exact failure reasons; status-read errors no longer present cached status as
current. Recorder ticks do not rerender history, session detail or telemetry.

Sessions combines both games, supports game filters and a pinned F1 recording
row, and refreshes on completion. F1 details reuse the existing tabs, fact lists,
tables, badges and alerts for Summary, Laps, Events and Data. Selection generations
reject obsolete responses, and F1 selection opens no FH6 analysis polling lane.
Authoritative Session History laps remain distinct from provisional Lap Data.

No Rust/backend code was changed by this integration pass. Listener behavior,
packet decoding, recording formats, recovery, retention, telemetry calculations,
and the existing Phase D contracts were retained. Phase D's already-required
`f1_sessions` listing, `get_f1_session`, `get_f1_recorder_status`, multi-game envelope
and decimal-string UID are documented in
[V2.0-PHASE-D-F1-RECORDING.md](../V2.0-PHASE-D-F1-RECORDING.md).

## Validation and visual findings

- TypeScript production and review-harness checks pass; production build passes.
- Full frontend suite: 480 passed, zero failed, zero skipped. Includes the original
  responsive/keyboard checks and nine F1 session browser checks.
- Design/token/release/icon subset: all 36 pass, including pixel verification of
  the locked 16px ICO optical master.
- Rust suite: 383 passed, zero failed, five existing intentionally ignored
  workload checks. Includes all 24 F1 recording/persistence tests and four F1
  stress tests, with real temporary files, recovery, retention and ownership.
- Hashes of all 23 locked styles/font/brand/icon/reference assets are unchanged.
- [69 screenshot results](integration/results.json): 23 scenarios at each of
  960×640, 1280×720 and 1920×1080. Covers Home, generic/FH6/F1 Live, Sessions,
  FH6 Analysis/shared cursor, Settings, Diagnostics/F1 Diagnostics, four F1
  detail tabs, long and missing data, recording ownership and six recorder phases.
  Zero console errors or document overflow. F1 detail tables/alerts remain within
  their workspace. Keyboard cursor endpoints share the same timebase across lanes.
- No visual geometry regressions were found. Recording indicators, failure
  presentation and obsolete Diagnostics wording were corrected using existing
  styles. Narrow Sessions retains the locked stacked layout and scrolls to show
  detail; wide Sessions retains its master/detail layout.

Machine-readable [test results](integration/test-results.json) and
[locked asset hashes](integration/locked-assets.json) accompany this report.

Contact sheets: [960×640](integration/contact-960x640.png),
[1280×720](integration/contact-1280x720.png),
[1920×1080](integration/contact-1920x1080.png).

Native validation used the rebuilt Windows debug executable and the existing
verified Vite server. `pnpm tauri dev --no-watch` initially encountered an occupied
Vite port 1420; launching the compiled application against that server required
no configuration change. Both configured UDP listeners then bound normally.
The earlier redesign's occupied-UDP-port error remains an expected environmental
result; no networking workaround was introduced.

The native Connection view received all 20 test datagrams (128 B each, 2,560 B,
zero receive errors), showed their source and hex preview, stopped/restarted
without closing the app, then received all ten packets in a second burst.
[Native UDP capture](integration/native-udp.jpg).

Four committed real F1 player packet fixtures were replayed unchanged to the
configured F1 port. Diagnostics accepted all four and decoded them; native Live
showed 170 km/h, gear 4 and 11,024 rpm with the existing hierarchy.
[Native F1 Live capture](integration/native-f1-live.jpg).
These are fixture-replay checks, not a newly captured game session.

## Remaining limitations

The current analysis API exposes FH6 summary/event bins, not continuous sample
traces or reference-lap comparisons. The shared cursor stays within that API.
F1 Summary/Laps/Events/Data show persisted facts; no F1 continuous analysis,
reference-lap comparison or fabricated traces were added. Those require future
analysis-API work.

Real-game Phase D race lifecycle acceptance is still pending as documented by
the F1 implementation. Its automated persistence tests use synthetic packets
and real files; the captured Time Trial player fixtures do not establish full
race start/end, pause, classification or tyre/damage acceptance. The existing
F1 release gate is unchanged. Five explicitly ignored long-running Rust workload
checks were not run. No new dependency, commit, release or tag was introduced.
