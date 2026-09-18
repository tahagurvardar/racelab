# ADR 0001: Capture before parser

Status: Accepted

## Context
RaceLab targets multiple racing games whose telemetry packets differ by title and version. Guessing an FH6 binary layout before observing real traffic risks baking incorrect assumptions into the core.

## Decision
V0.1 treats every UDP datagram as opaque bytes and records only transport-level metadata plus a short hex preview. The game-specific parser begins only after real traffic is captured and documented.

## Consequences
- V0.1 can be completed before the game finishes downloading.
- The UDP subsystem remains reusable across games.
- Parser tests can later be built from captured fixtures.
- Initial UI is intentionally simple.
