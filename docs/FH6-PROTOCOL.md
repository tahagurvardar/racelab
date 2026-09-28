# FH6 adapter — contract and limits (V0.5.1 baseline, V0.8 expansion)

This adapter implements the **user-supplied 324-byte FH6 Car Dash contract** and validates it against six local real-game captures. Packet size alone cannot authenticate the sending game. The parser is explicitly FH6-specific; transport remains game-agnostic and unchanged. All multibyte fields are little endian, read individually without packed-struct alignment or unsafe casts. Unsupported lengths return a structured error before any indexed reads.

## Exact implemented offsets

| Field | Offset(s), bytes | Type | Treatment |
|---|---|---|---|
| isRaceOn | 0 | s32 | 0 inactive, 1 active; other values rejected |
| timestampMs | 4 | u32 | Preserved and checked per source |
| engineMaxRpm / engineIdleRpm / currentEngineRpm | 8 / 12 / 16 | f32 | Canonical engine RPM |
| acceleration X/Y/Z | 20 / 24 / 28 | f32 | Canonical vector, no axis transform |
| velocity X/Y/Z | 32 / 36 / 40 | f32 | Canonical vector; magnitude checked against speed |
| angularVelocity X/Y/Z | 44 / 48 / 52 | f32 | Canonical vector, no axis transform |
| yaw / pitch / roll | 56 / 60 / 64 | f32 | Canonical orientation x/y/z respectively |
| normalized suspension travel | 68 / 72 / 76 / 80 | f32 | Canonical per wheel, 0..1 |
| tire slip ratio | 84 / 88 / 92 / 96 | f32 | Canonical per wheel, dimensionless |
| wheel rotation | 100 / 104 / 108 / 112 | f32 | Canonical per wheel, rad/s |
| Undecoded wheel-block bytes | 116..163 inclusive | 48 raw bytes | Opaque; zero in every captured packet |
| tire slip angle | 164 / 168 / 172 / 176 | f32 | Canonical per wheel, dimensionless |
| tire combined slip | 180 / 184 / 188 / 192 | f32 | Canonical per wheel, dimensionless |
| suspension travel | 196 / 200 / 204 / 208 | f32 | Canonical per wheel, metres |
| carOrdinal | 212 | s32 | Canonical vehicle ID when positive |
| carClass / carPerformanceIndex | 216 / 220 | s32 | Canonical **codes**; no enum/name inference |
| drivetrainType / numCylinders | 224 / 228 | s32 | Canonical code / count; no drivetrain enum inference |
| Horizon block | 232..243 inclusive | 12 raw bytes | Explicitly unknown, preserved exactly |
| position X/Y/Z | 244 / 248 / 252 | f32 | Canonical position, no coordinate transform |
| speed | 256 | f32 | m/s; UI multiplies by 3.6 for km/h |
| power / torque | 260 / 264 | f32 | Canonical watts / newton-metres |
| tire temperatures | 268 / 272 / 276 / 280 | f32 | Fahrenheit on the wire; canonical Celsius per wheel |
| boost / fuel / distanceTraveled | 284 / 288 / 292 | f32 | Preserved raw; **not canonical**, units unestablished |
| bestLap / lastLap / currentLap | 296 / 300 / 304 | f32 | Preserved raw; **not canonical**, never non-zero in any capture |
| currentRaceTime | 308 | f32 | Canonical seconds |
| lapNumber | 312 | u16 | Canonical count |
| racePosition | 314 | u8 | Canonical ordinal |
| throttle / brake / clutch / handbrake | 315 / 316 / 317 / 318 | u8 | Raw codes preserved; canonical value = code / 255 |
| gear | 319 | u8 | Canonical gear is null; exact raw code in `sourceSpecific.fh6.gear` |
| steering | 320 | i8 | Reject -128; canonical value = code / 127 |
| Unknown trailer | 321..323 inclusive | 3 raw bytes | Preserved exactly |

The supplied request explicitly typed header fields and tail controls. The float groups above use f32; vehicle fields use signed 32-bit integers. Tests verify these byte widths and signedness with independent sentinels. Real physical consistency strongly corroborates speed, velocity, RPM and controls, but is not proof of every label, unit or enum in the packet. The adapter does not name unknown fields merely because their bytes vary.


## V0.8 promoted fields: offsets, units and evidence

Every field below is decoded by the FH6 adapter and reaches the canonical
`TelemetryFrame` schema v2. `i` is the source wheel-block index 0..3; the
mapping from index to corner is [below](#wheel-order-v08). Full derivations,
statistics and controls are in [V0.8-VALIDATION.md](V0.8-VALIDATION.md).

| Canonical field | Offset | Type | Source unit | Canonical unit | Evidence | Status |
|---|---|---|---|---|---|---|
| `engine.power_w` | 260 | f32 LE | watts | watts | `P = τ·ω` holds to a 2.2e-4 median relative error over 14,200 samples; no other unit pair is within three orders of magnitude | proven |
| `engine.torque_nm` | 264 | f32 LE | N·m | N·m | same identity | proven |
| `vehicle.class_code` | 216 | s32 LE | code | code | repo FH6 contract; rendered as a code, never a name | code known |
| `vehicle.performance_index` | 220 | s32 LE | index | index | repo FH6 contract; observed 600 | code known |
| `vehicle.drivetrain_code` | 224 | s32 LE | code | code | repo FH6 contract; rendered as a code, never a name | code known |
| `vehicle.cylinders` | 228 | s32 LE | count | count | repo FH6 contract; observed 4 | code known |
| `wheel.normalized_suspension_travel` | 68 + 4i | f32 LE | 0..1 | 0..1 | spans exactly [0,1] over 14,237 packets; exactly affine to the metres channel; direction anchored on airborne/landing frames | proven |
| `wheel.slip_ratio` | 84 + 4i | f32 LE | dimensionless | dimensionless | matches `(ω·r − v)/v`; orthogonal partner in the combined-slip identity | proven |
| `wheel.rotation_rad_s` | 100 + 4i | f32 LE | rad/s | rad/s | `speed / ω` is a constant 0.3247 m (front) / 0.3232 m (rear) effective rolling radius | proven |
| `wheel.slip_angle` | 164 + 4i | f32 LE | dimensionless | dimensionless | lateral partner in the combined-slip identity; **not radians**, and deliberately not named `_rad` | proven |
| `wheel.combined_slip` | 180 + 4i | f32 LE | dimensionless | dimensionless | `= hypot(slip_ratio, slip_angle)` to a max residual of 8.95e-7; cross-pairing controls fail by 5.8–12.5 | proven |
| `wheel.suspension_travel_m` | 196 + 4i | f32 LE | metres | metres | exact affine map from the normalized channel, r = 1.000000, max residual 1.8e-9; ±3 cm range | proven |
| `wheel.temperature_c` | 268 + 4i | f32 LE | **Fahrenheit** | **Celsius** | wire range 141–335 is impossible as °C but is 61–168 °C as °F; corroborated by independent FH6 implementations. Converted once, in the adapter | proven (combined) |
| `race.race_time_seconds` | 308 | f32 LE | seconds | seconds | tracks the game clock 1:1; ≤34 ms cumulative drift over 82 s | proven |
| `race.lap_number` | 312 | u16 LE | count | count | repo FH6 contract; a count has no unit to establish | code known |
| `race.race_position` | 314 | u8 | ordinal | ordinal | repo FH6 contract | code known |

All reads are bounds-safe little-endian reads of a length-checked 324-byte
array, with no packed-struct alignment and no unsafe casts. Every promoted f32
is in `FLOAT_FIELDS` and is therefore rejected as a decode error if non-finite,
reporting its own field name and byte offset.

### Deliberately not promoted

| Field | Offset | Why |
|---|---|---|
| boost | 284 | saturates at a constant with no establishable scale (psi / bar / kPa) |
| fuel | 288 | exactly 1.0 in all 14,237 active packets |
| wheel on rumble strip | 116 + 4i | every byte zero in all 18,165 packets; even the type is unestablished |
| wheel in puddle depth | 132 + 4i | every byte zero in all 18,165 packets |
| surface rumble | 148 + 4i | only three distinct values ever observed; domain unknown |
| distanceTraveled | 292 | exactly 0.0 while demonstrably driving, so it does **not** mean session distance in free roam |
| bestLap / lastLap / currentLap | 296 / 300 / 304 | never non-zero in any capture; unit inferred from a sibling field is not evidence |
| gear | 319 | semantics unestablished; canonical gear stays null and the raw code stays in Diagnostics |

Bytes 116..=163 are not decoded as floats at all. They remain raw inside the
`wheel_block_68_211` envelope so that nothing reinterprets them.

### Wheel order (V0.8)

| Source index | Canonical corner |
|---|---|
| 0 | front left |
| 1 | front right |
| 2 | rear left |
| 3 | rear right |

Established from real captures: the axle split (`{0,1}` front, `{2,3}` rear) and
the side pairing (`{0,2}` one side, `{1,3}` the other) are each proven by
multiple independent measurements. Which side is *left* is a parity choice that
is provably not derivable from kinematics and is taken from the documented Forza
Data Out per-wheel field order, whose every other prediction the captures
confirm. `adapters::fh6::WHEEL_ORDER` is the only place this mapping exists.

## Canonical model and invalid values

`telemetry::TelemetryFrame` is game-independent: activity, optional game/vehicle identifiers and game timestamp, engine, vectors, position, speed, normalized controls and optional semantic gear. Its `sourceSpecific.fh6` envelope preserves game-only values and opaque byte regions. `adapters::fh6::DecodedFrame` also exposes `Fh6Raw` to offline callers. Packet offsets and FH6 block fields remain outside canonical values.

`isRaceOn == 0` produces an inactive frame with null dynamic canonical values, including engine and controls. Game timestamp remains available for ordering; FH6 extension fields and all implemented raw float values remain available. Positive car ordinal becomes a string vehicle ID; zero/negative ordinals yield null. Gear semantics remain unknown, so canonical gear is null even when active; the UI shows the raw code. Actual active zero values remain zero. **Non-finite values in every implemented float field and steering -128 are still reported on inactive packets**. Offline validation skips active physics rules on inactive telemetry. Before a live protocol lock, the detector checks raw inactive engine/speed/velocity values too, so zero-filled packets cannot identify FH6.

Decoding rejects unsupported sizes, non-finite f32 values, invalid activity flags and out-of-range steering. Errors identify field, offset and reason; NaN/Inf is represented by its raw bit pattern in diagnostics, not silently converted to JSON null or zero. `physical_issues` applies the following declared V0.4 policy to decoded active frames:

- `abs(speed - magnitude(velocity)) <= 0.001 m/s`, with nonnegative speed. Magnitude is computed in f64 from the three stored f32 components. This policy allows f32 rounding headroom; the measured maximum discrepancy in real captures is about `1.03e-5 m/s`.
- `0 < engineMaxRpm <= 30000`; `0 <= engineIdleRpm <= engineMaxRpm`; `0 <= currentEngineRpm <= min(engineMaxRpm * 1.1, 30000)`. These are configurable-in-code plausibility decisions, not proven FH6 protocol limits. An unsupported future high-RPM vehicle should lead to a reviewed policy change, not data clamping.
- Throttle/brake/clutch/handbrake are u8 and therefore exactly 0..255 before normalization. Steering is signed and restricted to -127..127. Endpoint tests exercise 0/255 and -127/127. No input is clamped to conceal invalid data.

Offline and live consumers both run decoding and physical validation. Invalid packets remain in raw capture, but do not replace the live display with a supposedly valid frame. Live fields show unavailable values after the latest packet is invalid, listener stop, or 1.5 seconds without valid frames by default. Capture runs before the adapter callback and does not depend on successful parsing. Adapter work is bounded in memory and performs no I/O on ingress.

## Game timestamp policy

Equal timestamps are allowed. Increasing timestamps are ordered. A backward jump is classified separately as:

1. u32 wrap when the previous value is within 60 seconds of `u32::MAX` and the new value is within 60 seconds of zero;
2. active/inactive boundary reset when the activity flag changes;
3. explicit reset when an offline caller identifies a documented packet boundary, or when live listener commands reset the adapter for a new listener session.

All other backward jumps are errors. A rejected jump does not lower the baseline. Repeated backward jumps within an inactive run are also errors. These are **explicit validation policies**, not a claim that reset behavior was demonstrated by the six captures: none contained a backward timestamp jump. Reset/wrap paths are covered by deterministic synthetic tests. Do not mark arbitrary regressions as known resets merely to make a report pass.

Offline validation tracks timestamps separately for up to 64 source endpoints; further sources produce errors rather than unbounded memory use. V0.5 live detection requires five consecutive valid packets from one endpoint, with at least two timestamp advances. It additionally rejects forward deltas exceeding elapsed reception time plus 2,000 ms and active timestamps frozen for more than 2,500 ms. Inactive clocks may remain paused after locking. Activity changes reset the stalled-clock watchdog. These are declared safety policies, not measured FH6 frequency limits.

V0.5.1 separates packet classification from lock evidence. Structurally valid inactive packets count as `valid_inactive_fh6` even if zero engine/motion fields or unusable probe clock continuity cannot identify the stream. They do not increment invalid/rejected counters. The detector still requires its multi-frame physical/clock evidence before publishing frames or identifying FH6.

After lock, inactive packets bypass live driving-clock continuity checks and clear the active clock baseline. Their game timestamps remain preserved. The next valid active packet establishes a fresh baseline; subsequent active regression/jump/stall checks remain enforced. This is a classification policy for unavailable inactive telemetry, not a claim that every menu timestamp reset is understood. Non-finite implemented fields, invalid activity and steering remain errors on inactive packets. Offline timestamp validation remains unchanged and can report discontinuities that live inactive classification tolerates.

Live telemetry locks one source endpoint. Foreign traffic counts as `unknown_protocol` without reducing the locked stream's confidence or hiding its latest valid values. Malformed packets from the locked endpoint count as `invalid_fh6`; unrecognized packets before lock count as unknown. Loss of valid telemetry releases the lock after session grace (or after the silence timeout when idle), allowing automatic reprobe without rebinding. Raw capture continues for all sources. See [V0.5 state/session policies](V0.5-VALIDATION.md) and [V0.5.1 classification details](V0.5.1-VALIDATION.md).

## Offline commands and fixtures

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --example validate_fh6 -- 'C:\private\capture.rlcap'
# Only with a documented game restart at one-based packet 123:
cargo run --manifest-path src-tauri/Cargo.toml --example validate_fh6 -- 'C:\private\capture.rlcap' --reset-at 123
cargo test --manifest-path src-tauri/Cargo.toml --test fh6
pnpm test:frontend
```

The CLI streams existing RLCAP files, validates the full footer and prints JSON totals, active/inactive counts, packet sizes, physical ranges/error maxima, timestamp events, capture drops and at most 100 issue examples with one-based packet indices. It reports omitted issue counts. Exit 0 means nonempty, structurally complete and no validation errors/capture drops; exit 2 means a completed report with failed validation; exit 1 means file/format/argument failure. An all-inactive file may pass structural/inactive validation but establishes no active physics evidence; inspect `active_packets`.

Private captures stay in the application data directory. The public [fixture directory](../src-tauri/tests/fixtures/fh6/README.md) contains only 18 anonymized packets (six 1,198-byte files), golden values and hashes. Real engine/motion/control bytes are preserved; identifying/configuration/unknown/position/timing context is removed as documented. Synthetic tests independently cover fields removed by anonymization. `.gitignore` excludes full `.rlcap` captures and summary sidecars except the reviewed fixture directory.

## Remaining uncertainties

- Meanings of bytes 232..243, 321..323 and the still-undecoded 116..163 region.
- FH6-specific coordinate axes/sign conventions beyond preserving supplied X/Y/Z order.
- Boost and fuel units; the distance counter's semantics; lap-time units and sentinel conventions. Tire-temperature order and unit, power, torque, wheel rotation, slip and suspension units are now established — see the V0.8 table above.
- Vehicle enum meanings and drivetrain mapping.
- Gear code semantics, especially observed 0 and 11. The UI deliberately labels **Gear (code)**; no reverse/neutral mapping has been invented.
- Reset behavior outside the tested captures and plausibility limits for other vehicles/game states.

No AI, database analytics, coaching, lap detection, F1 adapter or visual redesign is part of V0.5 or V0.8.

V0.8 expanded the canonical model to schema version 2. See
[V0.8-TELEMETRY-SCHEMA.md](V0.8-TELEMETRY-SCHEMA.md) for the schema and its
backward compatibility, and [V0.8-VALIDATION.md](V0.8-VALIDATION.md) for the
evidence audit and the manual acceptance plan that V0.8 has **not yet passed**.
