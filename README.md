# RaceLab

RaceLab is a desktop telemetry platform for racing games. Its frozen transport treats every UDP datagram as opaque bytes. V0.5 automatically listens, validates FH6 traffic, and manages live in-memory sessions.

## V0.6: automatic session recorder

Every session RaceLab detects is now recorded to disk automatically. There is no Start Recording button: the recorder opens when `SessionEngine` starts a session, keeps the same file across a short menu interruption (GRACE), and finalizes when the session completes. Normalized `TelemetryFrame` records are stored — not raw FH6 datagrams — under `%LOCALAPPDATA%\com.tahagurvardar.racelab\sessions\<session-id>\` as a versioned `manifest.json` plus a streamable binary `frames.rlframes`. Frames reach the writer through a bounded 4096-slot queue; overflow drops the newest frame and is counted in the recorder status, the manifest and the session summary, so ingestion is never blocked by disk I/O.

Completion calculates a summary automatically: duration, frame count, max and **time-weighted average** speed and RPM, full-throttle time (normalized throttle >= 0.95), braking time (normalized brake > 0.05), gear changes and distance. Unavailable values stay unavailable — FH6 reports no canonical gear or distance field, so those read as `—` rather than zero. A session interrupted by a crash is reclassified as incomplete on the next start and never presented as completed. Recent Sessions and Session Details are served from manifest metadata alone; the frame stream is never sent to the UI. V0.3 raw capture remains a diagnostics-only feature. Format specification: [V0.6 session format](docs/V0.6-SESSION-FORMAT.md). Implementation and test results: [V0.6 validation](docs/V0.6-VALIDATION.md).

## V0.5.1: telemetry classification cleanup

The engineering UI separately counts **FH6 active**, **FH6 inactive (menus/loading)**, **Invalid FH6**, and **Unknown protocol**. Structurally valid inactive packets are not rejected for lacking active-driving physics or usable menu/loading clock continuity. Packet classification is separate from protocol-lock evidence: an inactive packet may pass layout checks without proving FH6 identity. Malformed/non-finite data from a locked FH6 source still reports validation issues. Full details and current test results: [V0.5.1 validation](docs/V0.5.1-VALIDATION.md).

The user has completed [manual V0.5 validation](docs/V0.5-VALIDATION.md): automatic listening/detection, active sessions, same-ID grace recovery, expiry, shutdown disconnect and automatic reconnect detection. Active input/valid rates matched, with zero receive errors/hub drops and 100% protocol confidence.

## V0.5: automatic connection, telemetry hub and sessions

Launch RaceLab and it automatically listens on **20440**. Five consecutive invariant-valid packets with at least two game-clock advances establish an FH6 protocol lock. Active telemetry starts a session; inactive telemetry or a brief interruption enters a configurable grace period. Connection state and health remain separate from session state. Manual listener controls live under diagnostics.

The game-independent hub retains the latest frame and a bounded 512-frame ring. Bounded subscribers receive full-rate frames using nonblocking delivery with explicit drop counts. The UI requests one latest snapshot at a time, at most 20 Hz; it does not queue live frames. Unavailable canonical values are now `Option` / JSON `null`; actual zero remains zero. Raw gear and other FH6 values stay in `sourceSpecific.fh6`.

The grace period defaults to 10 seconds, following inactive telemetry immediately or 1.5 seconds without valid active telemetry. To change it before launch:

```powershell
$env:RACELAB_SESSION_GRACE_MS = '15000'
pnpm tauri dev
```

Allowed grace values are 1..120000 milliseconds. Automatic sessions are in memory only. Raw file recording still requires **Start Capture / Stop Capture**. See [V0.5 transitions, contracts, architecture, validation and risks](docs/V0.5-VALIDATION.md). The frozen UDP transport and capture format remain unchanged.

## V0.4: FH6 adapter and offline validation

The 324-byte FH6 Car Dash adapter produces a game-independent `TelemetryFrame`, preserves FH6-only/unknown bytes separately, and reports unsupported sizes, non-finite values and physical/timestamp validation failures. V0.5 supersedes V0.4's inactive zero values with null. The engineering UI shows speed km/h, RPM, the raw gear code, throttle %, brake % and steering %. Raw capture continues independently of parsing. UDP ingress is unchanged.

All six private real captures passed offline validation: **18,165 packets**, 14,237 active / 3,928 inactive, zero invalid packets, capture drops or timestamp regressions. Maximum active speed-versus-velocity error was **0.0000103002 m/s**. The repository includes only **18 anonymized real packets** in six minimal fixtures; full captures remain private.

See [exact offsets and validation policies](docs/FH6-PROTOCOL.md), [fixture provenance/redactions](src-tauri/tests/fixtures/fh6/README.md), and [V0.4 validation results and changed files](docs/V0.4-VALIDATION.md).

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --example validate_fh6 -- 'C:\private\capture.rlcap'
cargo test --manifest-path src-tauri/Cargo.toml --test fh6
```

## V0.3: real telemetry capture

V0.2.2 UDP ingress is frozen and unchanged. Manual FH6 verification supplied by the user observed continuous 324-byte datagrams at approximately 70 packets/sec from `127.0.0.1:5200`, bound to port `20440`, with zero receive errors.

V0.3 attaches `RawCaptureSink` through the existing `PacketSink` seam. **Start Capture / Stop Capture** records named sessions to lossless binary `.rlcap` files with timestamps, source addresses, original lengths, exact datagram bytes and a JSON summary. A 4,096-frame queue feeds a dedicated disk writer; ingress never waits for disk I/O. Queue overflow drops newest frames, increments the visible dropped capture counter and marks the dataset as having loss. Stop drains and syncs the file before reporting Saved. Capture remains independent of listener stop/restart.

Captures normally live in `%LOCALAPPDATA%\com.tahagurvardar.racelab\captures`; the capture panel displays the actual full path. See the [binary format and replay API](docs/RAW-CAPTURE-FORMAT.md), [first-six-dataset recording instructions](docs/FIRST-SIX-FH6-DATASETS.md), and [historical V0.3 validation report](docs/V0.3-VALIDATION.md). No UI redesign, database, AI, charts, accounts or driving analysis is included.

## Frozen V0.2.2 transport

**Frozen baseline validation.** All 14 requested load runs passed: 14,000/14,000 packets, zero sequence gaps and zero receive errors, with the 4 MiB request unchanged. Removing SO_RCVTIMEO eliminated the previously observed failure in this tested matrix; it does not prove the historical root cause. See [the V0.2.2 validation report](docs/V0.2.2-VALIDATION.md) for per-run results, earlier transient test failures and remaining risks.

`Game / test sender -> dedicated Rust UDP thread -> backend session statistics -> 4 Hz Tauri snapshots -> React`

- Rust owns running status, bound port, packet and byte totals, packets/sec, last source, packet size/timestamp, raw bytes, and receive errors.
- The receive loop does no event delivery, JSON serialization, or hex formatting. A short mutex protects counters and the latest datagram. V0.3's queue/history belongs exclusively to the attached capture sink.
- `PacketSink::on_packet(&CapturedPacket)` is the game-agnostic consumer seam. Construct `Listener::new(buffer, Some(sink))` to attach a future adapter without editing the UDP loop. The callback receives borrowed raw bytes, source address, wall-clock milliseconds, and monotonic microseconds relative to session start, sampled immediately after reception. Product statistics update first, and their lock is released before the callback. Consumers must return promptly and must not call listener start/stop from the callback. Expensive consumers need their own bounded handoff with an explicit overflow policy; there is no implicit queue. A panicking sink is detached for the session and reported through `last_error`; counting continues.
- A separate publisher takes a snapshot every 250 ms and releases the statistics lock before formatting and Tauri delivery. React displays snapshots; it does not count packets or compute rates.
- PPS uses packet counts divided by actual elapsed monotonic time in approximately one-second windows. The receive loop and publisher advance the windows. Idle PPS settles to zero within approximately two seconds; stop immediately reports zero. Wall-clock timestamps are for display only.
- Ingress's latest-packet state is bounded to one datagram (65,535-byte buffer); IPC includes only the first 32 bytes as hex. The optional capture session stores the full bytes separately. Zero-length datagrams count as packets.
- Async commands dispatch bind/join work to the blocking pool. A lifecycle mutex serializes start/stop; starting the same active port and repeated stops are idempotent. Changing an active port requires stopping first.
- The receive socket blocks in `recv_from` without SO_RCVTIMEO, polling or sleeps. Stop sets an atomic flag, sends a private loopback wake datagram, then joins the worker and releases the socket. Each session reserves its wake source socket and generates a fresh 256-bit OS-random nonce; the receiver matches both source and nonce before counters or consumers. Control packets never become telemetry. Wake-send failures surface as lifecycle errors and retain the worker for another stop attempt instead of joining a potentially blocked thread. Final totals remain visible. A successful restart clears all session data and errors. Port `0` is available to Rust callers for an OS-assigned test port; the UI accepts `1..65535`.
- Session IDs identify restarts; globally increasing snapshot revisions prevent stale command/event responses from overwriting newer frontend state. Subscribing before fetching the initial snapshot supports remount/reload.
- If the initial stats query fails after event subscription succeeds, the next stats event restores frontend connectivity and clears the connection error. A late rejected query cannot undo recovery. Command and backend errors remain separate.
- Fatal receive errors stop the session and appear in the UI. Interrupted reads retry. Other receive errors are counted; no timeout/WouldBlock retry classification remains. Bind/setup failures are reported separately as `last_error`. App exit stops the publisher and receiver.

## Windows prerequisites

1. Node.js + pnpm
2. Git
3. Rust MSVC toolchain
4. Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\check-env.ps1
pnpm install
pnpm tauri dev
```

RaceLab automatically listens on `20440`. Configure the game's telemetry destination to this computer and port. Enter an explicit capture label and use **Start Capture**, then **Stop Capture** to save raw traffic. Listener start/stop is available under diagnostics when troubleshooting.

## Synthetic traffic

Run from a second PowerShell window while the app listens:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\send-test-udp.ps1 -Port 20440 -Count 1000 -Hz 60 -PayloadBytes 324
```

Use `-Hz 10`, `-Hz 20`, `-Hz 60`, or `-Hz 120`. The sender uses absolute stopwatch deadlines, reports actual achieved rate, and defaults to 128-byte datagrams. `-PayloadBytes` accepts `64..65507`. The synthetic ASCII content is a test protocol only, not an FH6 layout.

For automated verification without a running app:

```powershell
pnpm test:udp
```

This Windows integration test runs the same Rust `Listener` used by Tauri against the PowerShell sender. The V0.2.2 matrix has fourteen runs of 1,000 packets: five at 10 Hz and three each at 20, 60 and 120 Hz, all with the unchanged 4 MiB request. Allow about 13 minutes. Each send return value is audited; per-run send/receive records are saved under `docs/v0.2.2-load/`. Each run checks exactly 1,000 packets / 128,000 bytes, every sequence from 1 through 1000 exactly once, final/tail `seq=1000`, nondecreasing capture timestamps, zero receive errors, and idle PPS decay. Any failure prints exact missing sequence ranges, duplicates, malformed/unexpected packets, and the received tail. The sequence observer is test-only and bounded to 2,000 observations per run; overflow fails the test rather than silently discarding evidence. A separate snapshot consumer stalls for two seconds before sampling at 4 Hz. This exercises real loopback UDP and backend statistics, but does not automate the WebView UI.

## Checks

```powershell
pnpm format
pnpm format:check
pnpm check
pnpm test:frontend
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:udp
```

The historical paced ingress matrix is ignored by the default Rust suite; `pnpm test:udp` runs it. V0.3's new 600-packet, 60 Hz, 324-byte capture/replay integration test runs in the default suite and takes about ten seconds. Capture tests cover exact byte/metadata round trips, timestamp ordering, lifecycle boundaries, drain behavior, overflow accounting and persistence, storage failures, malformed files and deterministic replay. Existing Rust tests cover sequence gaps/duplicates, rate math, bind recovery, concurrent listener lifecycle, snapshot contention, sink panic isolation, zero-length/maximum-size packets and a 1,000-packet burst. Frontend tests cover recovery and stale telemetry/capture snapshots (requires Node with TypeScript stripping). Formatting covers the changed frontend/package/test files and all Rust code.

## Limits and next evidence

UDP has no delivery guarantee. Counters describe datagrams received by this process; they cannot detect packets dropped by the OS or network before `recv_from`. The product requests `SO_RCVBUF = 4 MiB`; tests can leave that option untouched with `ReceiveBuffer::SystemDefault`. On Windows, `receive_buffer_bytes` is the value Winsock accepted/read back. It is not a guaranteed OS allocation or proof of actual queue capacity. The earlier 989/1000 result has no sequence evidence and cannot be attributed to receive buffering. Loopback synthetic results do not establish loss-free performance with game traffic, bursty large payloads, CPU contention, or real network conditions. Persistence occurs only between Start Capture and Stop Capture; interrupted recordings are not guaranteed complete and fail full validation without a valid footer.

The listener binds IPv4 on all local interfaces. Real FH6 ingress and capture were manually verified and six recordings are now validated offline. The FH6 adapter accepts only the supplied 324-byte layout; unresolved fields remain opaque. No SQLite, AI, accounts, charts, driving analysis, F1 adapter or backend service is included.

See `docs/ROADMAP.md` and `docs/adr/0001-capture-before-parser.md` for scope and the capture-before-parser decision.
