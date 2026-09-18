# RaceLab roadmap

## V0.1 — Link
Raw UDP listener, packet-rate measurement, packet size/source/hex preview, synthetic packet sender.

## V0.2 — Reliable ingress
Rust-owned packet/byte totals, monotonic packet-rate measurement, bounded latest-packet state, independent 4 Hz UI snapshots, safe lifecycle, and synthetic UDP load verification.

## V0.3 — Real telemetry capture
Record lossless raw datagrams through PacketSink with a bounded nonblocking writer queue, explicit capture lifecycle, summaries, a documented binary format and deterministic offline replay. V0.2.2 ingress is frozen. FH6 manual ingress evidence: 324-byte packets, approximately 70 Hz, source 127.0.0.1:5200, bound port 20440, zero receive errors in the user's sample.

## V0.4 — FH6 protocol adapter and offline validation
Parse the supplied 324-byte FH6 layout into a game-independent `TelemetryFrame`, preserve unknown fields, validate physics/timestamps offline, and maintain minimal anonymized real fixtures. Add six live engineering fields: speed, RPM, raw gear code, throttle, brake and steering. No UDP ingress changes or visual redesign. Six private captures (18,165 packets) pass validation.

## Deferred — Session storage
Additional session metadata, crash recovery and import/export need separate scope. SQLite analytics is outside V0.4.

## V0.5 — Driving analysis
Lap/segment detection where data allows it, braking/acceleration/corner metrics, comparisons against personal best.

## V0.6 — Companion screen
Read-only LAN dashboard suitable for iPhone Safari/PWA while the desktop app owns capture and storage.

## V0.7 — Game adapters
Forza Motorsport and F1 adapter(s) feeding a canonical telemetry model.

## V0.8 — Engineer layer
Deterministic findings first; optional AI explanation grounded only in computed telemetry evidence.

## V1.0
Stable capture, replay, analysis, multi-game adapter architecture, tests and release packaging.
