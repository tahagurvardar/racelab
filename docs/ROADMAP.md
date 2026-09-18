# RaceLab roadmap

## V0.1 — Link
Raw UDP listener, packet-rate measurement, packet size/source/hex preview, synthetic packet sender.

## V0.2 — FH6 adapter
Capture real FH6 traffic, document packet sizes, implement evidence-based parser, normalize into `TelemetryFrame`.

## V0.3 — Live dashboard
Speed, RPM, gear, throttle, brake, steering, motion/tyre fields that are actually available.

## V0.4 — Session recorder
SQLite persistence, session metadata, crash-safe recording, import/export.

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
