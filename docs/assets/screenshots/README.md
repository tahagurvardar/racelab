# Portfolio screenshots

These captures render the v2.0.0 production UI components through the existing
development-only review harness. The UI components are unchanged from the release tag.

| File                  | Source state                                     |
| --------------------- | ------------------------------------------------ |
| `f1-telemetry.png`    | Checked-in F1 driving capture replay             |
| `session-history.png` | Deterministic multi-game session history         |
| `f1-lap-detail.png`   | Deterministic F1 session and lap records         |
| `forza-telemetry.png` | Illustrative Forza review fixture                |
| `f1-overlay.png`      | Actual standalone overlay UI using the F1 replay |

Workspace images are 1280×720; the overlay uses its native 440×210 window size.
The fixture clock is fixed. The unreadable-session warning is an intentional
review fixture. These images do not establish fresh live game telemetry,
native click-through behavior, or a new real recording. The overlay has no
fabricated game background. No personal data is included.

## Reproduce

Run `pnpm install --frozen-lockfile`, then `node scripts/capture-portfolio.mjs`.
The existing browser helper uses installed Chrome or Edge (or
`RACELAB_TEST_BROWSER`). No runtime dependency is added. The capture checks
console errors, viewport overflow, release version, and visible privacy markers.

`capture-manifest.json` records scenarios, dimensions, provenance, and SHA-256
hashes. Browser traces, videos, reports, and raw telemetry are not portfolio
assets. Existing design-review evidence remains unchanged.
