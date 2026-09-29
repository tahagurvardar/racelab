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
Import/export, retention policy, lap/segment detection, driving metrics and comparisons need separate scope. No SQLite or coach analytics in V0.6. Event detection and turn segmentation landed in V0.9 below; import/export, retention and lap comparison remain deferred.

## Deferred — Companion screen
Read-only LAN dashboard suitable for iPhone Safari/PWA while the desktop app owns capture and storage.

## V0.7 — Full telemetry dashboard
Turn the engineering screen into a product dashboard: a persistent shell with
Overview, Engine, Dynamics, Tires, Suspension, Inputs, Race and Sessions, and a
separated Diagnostics section for protocol, transport, recorder-queue and raw
adapter data. Product views consume the canonical `TelemetryFrame` only;
`sourceSpecific` reaches exactly one module, which only Diagnostics imports.
Unavailable values stay unavailable and stale telemetry is never presented as
live. Frontend only: `src-tauri/` is byte-identical to `v0.6.0`. Canonical
telemetry carries no per-wheel, suspension, lap/race, power, torque, boost or
fuel channel, so those views render their final structure with stated reasons
rather than invented values. See [V0.7 dashboard](V0.7-DASHBOARD.md) and
[V0.7 validation](V0.7-VALIDATION.md).

## V0.8 — Canonical telemetry expansion
Promote the FH6 fields whose offsets, types, units, ordering and semantics are
supported by evidence into `TelemetryFrame` **schema version 2**, and wire them
into the existing V0.7 views. Per-wheel suspension travel, slip and rotation,
tire temperature in Celsius, engine power and torque, vehicle configuration
codes and race time/lap/position are promoted; boost, fuel, lap times, the
distance counter and the rumble-strip/puddle/surface bytes are not, and the
reason for each is recorded. Old schema-v1 recordings stay readable through a
frozen compatibility struct and are never rewritten. See
[V0.8 schema](V0.8-TELEMETRY-SCHEMA.md) and
[V0.8 validation](V0.8-VALIDATION.md). **Not frozen until manual FH6
acceptance passes.**

## V0.9 — Driving event engine and session analysis
A **derived analysis layer** over the frozen V0.8 telemetry model. When a
session completes, RaceLab analyzes its own frame stream on a background thread
and writes a versioned `analysis.json` beside the manifest: neutral driving
events (full throttle, braking, hard braking, rapid throttle lift, strong
acceleration/deceleration, high slip ratio, high combined slip, high suspension
compression/extension) and conservative yaw-rate turn segments. Streaming and
O(n): a 32 MB frame stream is analyzed in 4.5 MB of memory and under 400 ms.

Derived analysis is deliberately **not** part of `TelemetryFrame` and there is
no schema v3. Every threshold is a documented RaceLab heuristic, stored inside
the analysis that used it, and nothing is named understeer, oversteer,
wheelspin, wheel lock or left/right, because the telemetry does not establish
those meanings. V0.9 measures and segments; it does not coach. Schema-v1
recordings are analyzed partially, with V2-only channels reported unavailable
and never reconstructed from `sourceSpecific`. Frozen UDP ingress, session
lifecycle, hub and recorder architecture unchanged. See
[V0.9 analysis](V0.9-ANALYSIS.md) and [V0.9 validation](V0.9-VALIDATION.md).
Released as `0.9.0` after one real FH6 acceptance drive and the hardening pass
it produced.

## V0.10 — Game adapters, and the slip-threshold portability question
Forza Motorsport and F1 adapter(s) feeding the canonical telemetry model.
Also the natural home for the lap-timing and distance fields V0.8 deferred,
once a real race has been captured.

Carries one known risk forward from V0.9:
[cross-car slip-threshold portability](V0.9-VALIDATION.md#carried-into-v010-cross-car-slip-threshold-portability).
RaceLab's slip thresholds were set against a single vehicle, and the second
vehicle measured disagrees about the slip scale by more than an order of
magnitude. Settling whether a fixed absolute slip threshold is portable — or
whether slip needs a per-vehicle or percentile-relative reference — needs
several vehicles across drivetrains and surfaces, which is the same evidence
base a second adapter requires anyway.

## V1.0-pre — Engineer layer
Deterministic findings first; optional AI explanation grounded only in computed telemetry evidence.

## V1.0
Stable capture, replay, analysis, multi-game adapter architecture, tests and release packaging.
