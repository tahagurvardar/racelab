# FH6 adapter — V0.4 contract and limits

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
| Unimplemented preceding fields | 68..211 inclusive | 144 raw bytes | Opaque, preserved separately |
| carOrdinal / carClass / carPerformanceIndex | 212 / 216 / 220 | s32 | FH6 extension; no enum/name inference |
| drivetrainType / numCylinders | 224 / 228 | s32 | FH6 extension; no drivetrain enum inference |
| Horizon block | 232..243 inclusive | 12 raw bytes | Explicitly unknown, preserved exactly |
| position X/Y/Z | 244 / 248 / 252 | f32 | Canonical position, no coordinate transform |
| speed | 256 | f32 | m/s; UI multiplies by 3.6 for km/h |
| power / torque | 260 / 264 | f32 | FH6 extension, units not converted |
| tire temperatures | 268 / 272 / 276 / 280 | f32 | Ordered by offset; wheel labels/units unconfirmed |
| boost / fuel / distanceTraveled | 284 / 288 / 292 | f32 | FH6 extension, units not converted |
| bestLap / lastLap / currentLap / currentRaceTime | 296 / 300 / 304 / 308 | f32 | FH6 extension; no timing analysis |
| lapNumber | 312 | u16 | FH6 extension |
| racePosition | 314 | u8 | FH6 extension |
| throttle / brake / clutch / handbrake | 315 / 316 / 317 / 318 | u8 | Raw codes preserved; canonical value = code / 255 |
| gear | 319 | u8 | Preserved as canonical `Gear::Unmapped(code)` and raw FH6 code |
| steering | 320 | i8 | Reject -128; canonical value = code / 127 |
| Unknown trailer | 321..323 inclusive | 3 raw bytes | Preserved exactly |

The supplied request explicitly typed header fields and tail controls. The float groups above use f32; vehicle fields use signed 32-bit integers. Tests verify these byte widths and signedness with independent sentinels. Real physical consistency strongly corroborates speed, velocity, RPM and controls, but is not proof of every label, unit or enum in the packet. The adapter does not name unknown fields merely because their bytes vary.

## Canonical model and invalid values

`telemetry::TelemetryFrame` is game-independent: activity, game timestamp, engine, vectors, position, speed, normalized controls and a gear representation. `adapters::fh6::DecodedFrame` pairs it with `Fh6Raw` for game-only values and opaque byte regions. No game identifiers, offsets or FH6 block fields live in the canonical model.

`isRaceOn == 0` produces an inactive frame with zero dynamic canonical values and unknown gear. Game timestamp remains available for ordering; FH6 extension fields remain raw. Active RPM/speed plausibility rules do not apply to inactive telemetry. **Non-finite values in every implemented float field and steering -128 are still reported on inactive packets**, instead of being hidden by zeroing.

Decoding rejects unsupported sizes, non-finite f32 values, invalid activity flags and out-of-range steering. Errors identify field, offset and reason; NaN/Inf is represented by its raw bit pattern in diagnostics, not silently converted to JSON null or zero. `physical_issues` applies the following declared V0.4 policy to decoded active frames:

- `abs(speed - magnitude(velocity)) <= 0.001 m/s`, with nonnegative speed. Magnitude is computed in f64 from the three stored f32 components. This policy allows f32 rounding headroom; the measured maximum discrepancy in real captures is about `1.03e-5 m/s`.
- `0 < engineMaxRpm <= 30000`; `0 <= engineIdleRpm <= engineMaxRpm`; `0 <= currentEngineRpm <= min(engineMaxRpm * 1.1, 30000)`. These are configurable-in-code plausibility decisions, not proven FH6 protocol limits. An unsupported future high-RPM vehicle should lead to a reviewed policy change, not data clamping.
- Throttle/brake/clutch/handbrake are u8 and therefore exactly 0..255 before normalization. Steering is signed and restricted to -127..127. Endpoint tests exercise 0/255 and -127/127. No input is clamped to conceal invalid data.

Offline and live consumers both run decoding and physical validation. Invalid packets remain in raw capture, but do not replace the live display with a supposedly valid frame. Live fields show unavailable values after an invalid packet, listener stop, or two seconds without packets. Capture runs before the adapter callback and does not depend on successful parsing. Adapter work is bounded in memory and performs no I/O on ingress.

## Game timestamp policy

Equal timestamps are allowed. Increasing timestamps are ordered. A backward jump is classified separately as:

1. u32 wrap when the previous value is within 60 seconds of `u32::MAX` and the new value is within 60 seconds of zero;
2. active/inactive boundary reset when the activity flag changes;
3. explicit reset when an offline caller identifies a documented packet boundary, or when live listener commands reset the adapter for a new listener session.

All other backward jumps are errors. A rejected jump does not lower the baseline. Repeated backward jumps within an inactive run are also errors. These are **explicit validation policies**, not a claim that reset behavior was demonstrated by the six captures: none contained a backward timestamp jump. Reset/wrap paths are covered by deterministic synthetic tests. Do not mark arbitrary regressions as known resets merely to make a report pass.

Offline validation tracks timestamps separately for up to 64 source endpoints; further sources produce errors rather than unbounded memory use. Live telemetry latches the first decoded source for the listener session; a different source is reported and hidden until listener restart. Raw capture continues for all sources.

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

- Meanings of bytes 232..243 and 321..323, and the unimplemented 68..211 region.
- FH6-specific coordinate axes/sign conventions beyond preserving supplied X/Y/Z order.
- Tire-temperature wheel order/units; power, torque, boost, fuel, distance and lap/race-time units and special sentinel conventions.
- Vehicle enum meanings and drivetrain mapping.
- Gear code semantics, especially observed 0 and 11. The UI deliberately labels **Gear (code)**; no reverse/neutral mapping has been invented.
- Reset behavior outside the tested captures and plausibility limits for other vehicles/game states.

No AI, database analytics, coaching, lap detection, F1 adapter or visual redesign is part of V0.4.
