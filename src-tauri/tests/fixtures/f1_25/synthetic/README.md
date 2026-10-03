# SYNTHETIC F1 25 fixtures

**These files were not captured from a game.** They are written field by
field, in the order of the official "Data Output from F1 25 Game" v3 struct
definitions, by `src-tauri/tests/f1_synthetic`, with fixed values chosen so
that every field is distinct. They exist because Phase D needs packet types
(Session, Event, Participants, Final Classification, Car Damage, Session
History, Tyre Sets, Time Trial, Lap Positions) that the real Time Trial
captures in the parent folder do not contain.

What they prove: each Phase D decoder reads the specification's layout at
the specification's size. What they do not prove: that the installed game
sends these values, or sends these packets in the situations RaceLab expects.
That is still MANUAL ACCEPTANCE PENDING (see
`docs/V2.0-PHASE-D-F1-RECORDING.md`).

- The session UID is ASCII `SYNTHET!`, never the real fixtures' `RACELAB!`.
- `manifest.json` holds each file's SHA-256; a Node test checks it.
- `tests/f1_25_packets_d.rs` checks that every file is byte-for-byte its
  writer's output, is its specification size and is accepted by the Phase A
  classifier. Regenerate with
  `RACELAB_WRITE_SYNTHETIC_FIXTURES=1 cargo test --test f1_25_packets_d`.

| File                            | ID | Size | Content                                     |
| ------------------------------- | -: | ---: | ------------------------------------------- |
| `id01-session.bin`              |  1 |  753 | Race at Silverstone, 5 laps, light cloud    |
| `id03-event-penalty.bin`        |  3 |   45 | PENA: time penalty, pit lane speeding, 5 s  |
| `id03-event-speed-trap.bin`     |  3 |   45 | SPTP: 318.25 km/h, overall fastest          |
| `id04-participants.bin`         |  4 | 1284 | 20 active cars, names "Driver N"            |
| `id08-final-classification.bin` |  8 | 1042 | Player P1 from grid 22, two stints          |
| `id10-car-damage.bin`           | 10 | 1041 | Per-car distinct percentages                |
| `id11-session-history.bin`      | 11 | 1460 | Two completed laps and a partial third      |
| `id12-tyre-sets.bin`            | 12 |  231 | Twenty sets, set 3 fitted                   |
| `id14-time-trial.bin`           | 14 |  101 | Player, personal best and rival sets        |
| `id15-lap-positions.bin`        | 15 | 1131 | Three laps of positions                     |
