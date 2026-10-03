# RaceLab Design System v1 implementation

Implemented against `racelab-v1-reference.png`, after inspecting the existing application and the approved reference. The original reference under the misspelled `docs/desing` directory was preserved; a copy is available at the requested `docs/design` location.

## Architecture and decisions

- The application remains React + strict TypeScript + Vite, with Tauri 2 and Rust. Styling remains plain CSS with centralized tokens. Navigation still uses the existing reducer and keyboard shortcuts; Home is added without a routing dependency.
- Application-level hooks retain ownership of polling. Presentation components read existing stores, and instrument regions own no network, parsing or recording logic. The new Home workspace subscribes to coarse readiness facts.
- Geist Sans and Geist Mono variable fonts are bundled locally with their SIL Open Font License. No font download is needed when the application runs. Telemetry uses Sans with tabular figures; technical strings use Mono.
- The monochrome D2-C mark replaces the slash mark in the shell, browser favicon and Windows assets. All four small optical SVG masters are exact. The ICO contains independently generated 16/20/24/32px frames rather than resized copies. The 16px frame has a pixel-level regression test.
- The shell uses a quiet navigation rail, flat status hierarchy and text tabs. Regions use small luminance differences and rules. Buttons are neutral; cyan identifies focus, selection and the shared cursor. Telemetry colors are separate semantic tokens.
- Small content uses `#89959E` instead of the approximate tertiary target `#7E8A93` to maintain WCAG AA contrast on every approved surface. The target tertiary color remains available for decoration.
- Core Drive, Driver Input and Tyre Readout are separate components suitable for future overlay composition. Existing FH6 and F1 view models retain responsibility for formatting, units, availability and freshness.
- Session history uses dense flat rows with full recovery reasons. Analysis places factual insights before evidence and adds one synchronized cursor across every existing evidence lane, with keyboard control and a text inspector.
- Settings uses six information groups without inventing preference controls. Diagnostics retains its connection, pipeline, adapter, capture and optional F1 development tools.
- F1 recording integration was added concurrently by other work during this implementation. Per the user's explicit scope clarification, those shared-file edits are preserved but their functionality and regression fixes are left for a separate integration pass. This redesign does not author their backend, storage, polling or recording UI integration.

## Components introduced

`Region`, `StatusIndicator`, `CoreDrive`, `DriverInput`, `TyreReadout`, `SessionRow`, `SharedTimeline`, and `HomeWorkspace`. Existing `AppShell`, `Sidebar`, `TopBar`, `Readout`, control bars, tabs, session panels and settings/diagnostics regions supply the rest of the shared vocabulary.

## Files created or edited for the redesign

| Area | Files |
| --- | --- |
| Font and visual tokens | `src/styles/fonts.css`, `src/styles/tokens.css`, `src/styles/base.css`, `src/styles/shell.css`, `src/styles/live.css`, `src/styles/sessions.css`, `src/styles/views.css`, `src/assets/fonts/Geist.woff2`, `src/assets/fonts/GeistMono.woff2`, `src/assets/fonts/OFL.txt` |
| Branding | `src/components/brand/Brand.tsx`, `public/favicon.svg`, `index.html`, `scripts/generate-brand-icons.py`, `src-tauri/icons/mark-{16,20,24,32}.svg`, `src-tauri/icons/icon.svg`, `src-tauri/icons/icon.ico`, `src-tauri/icons/icon.png`, `src-tauri/icons/32x32.png`, `src-tauri/icons/128x128.png`, `src-tauri/icons/128x128@2x.png` |
| Shell and navigation | `src/main.tsx`, `src/App.tsx`, `src/views/navigation.ts`, `src/components/AppShell.tsx`, `src/components/shell/Sidebar.tsx`, `src/components/shell/Icon.tsx`, `src/components/Region.tsx`, `src/components/StatusIndicator.tsx` |
| Home and Live | `src/workspaces/HomeWorkspace.tsx`, `src/components/live/CoreDrive.tsx`, `src/components/live/DriverInput.tsx`, `src/components/live/TyreReadout.tsx`, `src/components/live/Readout.tsx`, `src/views/live/OverviewTab.tsx`, `src/views/live/f1/F1OverviewTab.tsx`, `src/views/live/f1/F1DynamicsTab.tsx` |
| Sessions and Analysis | `src/components/SharedTimeline.tsx`, `src/views/sessions/SessionRow.tsx`, `src/views/sessions/SessionList.tsx`, `src/views/sessions/SessionTimeline.tsx`, `src/views/sessions/SummaryTab.tsx` |
| Settings | `src/workspaces/SettingsWorkspace.tsx` |
| Review and verification | `review/brand.tsx`, `review/mock-backend.ts`, `scripts/validate-design.mjs`, `tests/brand-optical.test.mjs`, `tests/release-config.test.mjs`, `tests/design-tokens.test.mjs`, `tests/dashboard-architecture.test.mjs`, `tests/live-tabs.test.mjs`, `tests/settings-diagnostics.test.mjs`, `tests/browser-keyboard.test.mjs`, `tests/support/shell.mjs` |
| Reference and evidence | `docs/design/racelab-v1-reference.png`, this report, `docs/design/validation/*.png`, `docs/design/validation/results.json` |

The working tree contained substantial F1 work before this task and received further concurrent edits. The table describes this redesign's contributions, not every file currently reported by Git.

## Functionality retained

The redesign changes no Rust packet decoding, game adapter, UDP ingress behavior, recording format, retention/recovery logic, database/storage schema, telemetry calculation or IPC/public data contract. Existing game detection, freshness handling, automatic recording, session controllers, analysis lifecycle, storage controls and exact diagnostic errors remain in place. Concurrent backend and frontend integrations are preserved.

## Validation

- `pnpm check` and `pnpm build` pass. The review harness also passes its separate strict TypeScript check. Fonts are emitted as local production assets; no styling or charting dependency was added.
- Frontend regression suite: 447 tests passed before the final concurrent F1 integration. The new pixel-level ICO test also passes. Later working-tree results, including failures attributable to concurrent recording work, are recorded below.
- Rust regression suite: 383 passed, zero failed, five intentionally ignored workload/scale checks. Restart, alternate-port restart, bind-conflict reporting, capture restart, recording/recovery, retention, session analysis and adapter tests pass.
- Windows: `pnpm tauri dev` successfully builds and opens the application. `scripts/send-test-udp.ps1` sent 20 packets of 128 bytes to port 20440 at 10 Hz; the native Diagnostics view showed 20 packets, 2,560 bytes, the correct source/size and matching hex preview. Unknown test packets remained distinct from accepted telemetry.
- A separate installed RaceLab instance subsequently occupied port 20440. The isolated validation instance surfaced the bind failure in the shell. Direct native stop/restart was not completed because window control was repeatedly interrupted; automated ingress restart tests and real-browser listener-control tests passed. Other applications and the installed RaceLab instance were left intact.
- Real-browser layout/keyboard checks cover all Live tabs, broad signed values, all FH6 session tabs and recovery states, all Diagnostics tabs, storage controls, status disclosure, focus restoration and reduced motion. A long capped analysis retained bounded output and painted its Events tab in approximately 74 ms.
- `scripts/validate-design.mjs` verifies nine views at each of 960×640, 1280×720 and 1920×1080: 27 screenshots, no document overflow and no console errors. It checks local Geist, the exact sidebar mark, minimum hero size, one cursor spanning every lane, aligned cursor endpoints and keyboard scrubbing. Large windows add working space while primary telemetry sizes remain stable.
- Formatting checks on redesigned files and `git diff --check` pass. Existing tests were preserved; assertions changed where approved navigation, brand or region behavior changed. Expectations belonging to the concurrent recording integration are left intact for its owner.

## Visual evidence

| Resolution | Contact sheet |
| --- | --- |
| 960×640 | [All views](validation/contact-sheet-960x640.png) |
| 1280×720 | [All views](validation/contact-sheet-1280x720.png) |
| 1920×1080 | [All views](validation/contact-sheet-1920x1080.png) |

Full screenshots and machine-readable checks are in [validation](validation/results.json). Screenshots use the dev-only harness and production components. FH6 review values are existing illustrative fixtures; F1 player readings come from real captured, decoder-pinned fixtures. They are visual evidence, not a claim that a game was running.

## Remaining limitations

- The existing analysis API returns persisted event/segment intervals, not continuous frame samples or reference laps. The shared timebase operates on that truthful evidence. Continuous speed/RPM/gear traces, reference overlays and A/B lap comparison remain unavailable rather than fabricated. Supporting them requires a separately approved data API.
- FH6 canonical gear and lap delta remain unavailable where the existing adapter has not established them. F1 context, wear, weather, flags and other readings appear only where current view models expose data. Game colors do not reskin the shell.
- A real driving session and an installed release build have not been visually verified in this task. Native raw UDP and development launch were verified; adapter/recording correctness is additionally covered by captured-fixture and Rust regression tests.
- Concurrent F1 recording changes may add capabilities after this report's validation snapshot. They are outside the redesign's backend ownership.

## Final integration rerun

A subsequent non-browser working-tree run had 425 tests: 423 passed and two failed because the concurrent F1 work changed the old recording-unavailable text and removed the old “F1 is not recorded” session note. A narrowly attempted recorder integration in the sidebar and polling-owner test was removed after the user explicitly confirmed original scope. The original polling-owner expectation therefore also detects the new concurrent F1 recorder hook until that integration's owner updates its tests. No tests were deleted, skipped or weakened to conceal these differences.

The production build passes with the preserved shared-file changes. Rust's final working-tree run passes 383 tests with five intentionally ignored checks. The original redesign regression run and visual artifacts remain available for the separate F1 integration pass.

The final scoped working-tree rerun reports 422 passing and 3 failing non-browser tests; all failures are the three concurrent F1 recording integration differences listed above. The 36 final design/token/release/icon tests pass. The refreshed 27-screen visual matrix passes. Counts are also saved in [test-results.json](validation/test-results.json).
