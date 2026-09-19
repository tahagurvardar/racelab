# RaceLab roadmap

## V0.1 — Link
Raw UDP listener, packet-rate measurement, packet size/source/hex preview, synthetic packet sender.

## V0.2 — Reliable ingress
Rust-owned packet/byte totals, monotonic packet-rate measurement, bounded latest-packet state, independent 4 Hz UI snapshots, safe lifecycle, and synthetic UDP load verification.

## V0.3 — Real telemetry capture
Record lossless raw datagrams through PacketSink with a bounded nonblocking writer queue, explicit capture lifecycle, summaries, a documented binary format and deterministic offline replay. V0.2.2 ingress is frozen. FH6 manual ingress evidence: 324-byte packets, approximately 70 Hz, source 127.0.0.1:5200, bound port 20440, zero receive errors in the user's sample.

## V0.4 — FH6 protocol adapter and offline validation
Parse the supplied 324-byte FH6 layout into a game-independent `TelemetryFrame`, preserve unknown fields, validate physics/timestamps offline, and maintain minimal anonymized real fixtures. Add six live engineering fields: speed, RPM, raw gear code, throttle, brake and steering. No UDP ingress changes or visual redesign. Six private captures (18,165 packets) pass validation.

## V0.5 — Automatic connection, telemetry hub and sessions
Automatically listen on 20440, probe multiple invariant-valid FH6 frames, expose connection and health states, normalize unavailable values to null, and manage active/grace/completed sessions in memory. A bounded hub supports full-rate subscribers and latest-only UI polling capped at 20 Hz. No frozen transport changes or UI redesign.

## V0.6 — Automatic session recorder
Record normalized `TelemetryFrame` streams automatically for every SessionEngine session, with no Start Recording control. Bounded non-blocking writer queue, versioned manifest and RLFRAMES v1 binary frame stream on disk, automatic summaries, crash-safe interrupted classification, and a manifest-only Recent Sessions / Session Details UI. Frozen UDP ingress and V0.5.1 lifecycle semantics unchanged. V0.3 raw capture stays diagnostics-only.

## Deferred — Driving analysis
Import/export, retention policy, lap/segment detection, driving metrics and comparisons need separate scope. No SQLite or coach analytics in V0.6.

## Deferred — Companion screen
Read-only LAN dashboard suitable for iPhone Safari/PWA while the desktop app owns capture and storage.

## V0.7 — Game adapters
Forza Motorsport and F1 adapter(s) feeding a canonical telemetry model.

## V0.8 — Engineer layer
Deterministic findings first; optional AI explanation grounded only in computed telemetry evidence.

## V1.0
Stable capture, replay, analysis, multi-game adapter architecture, tests and release packaging.
