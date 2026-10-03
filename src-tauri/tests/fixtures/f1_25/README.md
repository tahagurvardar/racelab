# Real F1 25 regression fixtures

Sixteen real F1 25 UDP datagrams, four snapshots × four decoded packet types
(Lap Data 2, Car Telemetry 6, Car Status 7, Motion Ex 13), captured from the
user's installed game. Settings were UDP Format 2025 and 20 Hz; the header
reads `packetFormat` 2025, `gameYear` 25, `packetVersion` 1, game version
1.26. The mode was Time Trial and the player car index is 0.

Each snapshot was taken with RaceLab's development fixture capture
(`RACELAB_F1_CAPTURE=1`), which writes the four latest packets of one frame.

| Snapshot     | Frame | Session time | What the player was doing                       |
| ------------ | ----: | -----------: | ----------------------------------------------- |
| `stationary` |   641 |     32.169 s | In the garage, neutral, 0 km/h                  |
| `driving`    |  1655 |     82.970 s | Full throttle, 4th, 170 km/h, slight right steer |
| `braking`    |  1848 |     92.579 s | Full brake, 2nd, 59 km/h, steering right        |
| `high-speed` |  3382 |    169.142 s | 292 km/h in 8th, braking (0.82) after a straight |

## Redaction

`sessionUID` (bytes 7..14) is replaced with ASCII `RACELAB!` by
`cargo run --example f1_fixture -- sanitize`. No other byte is changed; the
review compared every file with its original. The files contain no names,
since Participants packets were not captured.

Retained as captured: the user's own Time Trial lap and sector times and lap
distances, and the Time Trial personal-best and rival ghost cars in slots 1
and 7. Those slots are numbers only, with no identity attached. They are kept
because they give the player-index tests real non-player data in other slots.
`manifest.json` holds each file's SHA-256 digest, and a Node test checks it.

## Review (2026-10-03)

Decoded with `f1_fixture inspect` and cross-checked across packets. The
findings below are pinned in `tests/f1_25_real.rs`.

- **Speed, two ways.** Car Telemetry gives 0 / 170 / 59 / 292 km/h. Motion
  Ex local velocity z × 3.6 gives 0 / 170.1 / 59.4 / 292.9 km/h. The two
  packets are decoded independently.
- **Wheel order, every corner.**
  - Front vs rear: wire slots 2–3 show the higher tyre pressures
    (24.2 vs 21.3 psi) and the hotter brakes. Under throttle, wire slots 0–1
    carry the positive longitudinal (drive) force and the positive slip
    ratio, so 0–1 are the driven rear wheels.
  - Left vs right: braking with steer +0.76 (right lock) loads FL/RL to
    3648/3473 against FR/RR at 1405/312. Turning right loads the outside
    (left) wheels, so slot 0 is rear left and slot 2 is front left.
  - Together these confirm the specification's RL, RR, FL, FR order.
- **Steering sign.** Positive steer matches a positive front wheels angle
  and right-turn load transfer. That agrees with the specification's
  "1.0 (full lock right)".
- **LapData `driverStatus` / `gridPosition`.** Decoded in specification
  order, `driver_status` is "in garage" (0) while stationary and "flying
  lap" (1) in all three driving snapshots, and `grid_position` is 0
  throughout. The reported swap would read "in garage" at 170 km/h, so
  **specification order is confirmed for the player car in Time Trial on game
  1.26**. Race-start grid positions were not tested.

Values reported verbatim and not "corrected":

- `max_gears` = 9.
- Tyre surface and inner temperatures are identical at 97 °C on all four
  tyres while driving, and 70 °C in the garage.
- In the garage, suspension velocity is ≈ 794 / 942 with zero vertical
  force.
- The high-speed snapshot has all suspension velocities exactly 0, and its
  packets were 441 ms old when captured; the others were 51–77 ms.
- The ghost cars in slots 1 and 7 read 427 / 447 km/h at max RPM. These are
  non-player values and have not been validated.
- `lap_distance_m` is −5272.5 m before the line was crossed, which the
  specification allows.
