# RaceLab

RaceLab is a desktop telemetry platform for racing games. Its transport treats every UDP datagram as opaque bytes. FH6 packet parsing requires real captures and is not implemented.

## V0.2.2: blocking UDP ingress

**Validation status: ready to freeze the narrow V0.2.2 baseline.** All 14 requested load runs passed: 14,000/14,000 packets, zero sequence gaps and zero receive errors, with the 4 MiB request unchanged. Removing SO_RCVTIMEO eliminated the previously observed failure in this tested matrix; it does not prove the historical root cause. See [the V0.2.2 validation report](docs/V0.2.2-VALIDATION.md) for per-run results, earlier transient test failures and remaining risks.

`Game / test sender -> dedicated Rust UDP thread -> backend session statistics -> 4 Hz Tauri snapshots -> React`

- Rust owns running status, bound port, packet and byte totals, packets/sec, last source, packet size/timestamp, raw bytes, and receive errors.
- The receive loop does no event delivery, JSON serialization, or hex formatting. A short mutex protects counters and the latest datagram; there is no per-packet queue or history.
- `PacketSink::on_packet(&CapturedPacket)` is the game-agnostic consumer seam. Construct `Listener::new(buffer, Some(sink))` to attach a future adapter without editing the UDP loop. The callback receives borrowed raw bytes, source address, wall-clock milliseconds, and monotonic microseconds relative to session start, sampled immediately after reception. Product statistics update first, and their lock is released before the callback. Consumers must return promptly and must not call listener start/stop from the callback. Expensive consumers need their own bounded handoff with an explicit overflow policy; there is no implicit queue. A panicking sink is detached for the session and reported through `last_error`; counting continues.
- A separate publisher takes a snapshot every 250 ms and releases the statistics lock before formatting and Tauri delivery. React displays snapshots; it does not count packets or compute rates.
- PPS uses packet counts divided by actual elapsed monotonic time in approximately one-second windows. The receive loop and publisher advance the windows. Idle PPS settles to zero within approximately two seconds; stop immediately reports zero. Wall-clock timestamps are for display only.
- Raw retention is bounded to one datagram (65,535-byte buffer); IPC includes only the first 32 bytes as hex. Zero-length datagrams count as packets.
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

Leave the UDP port at `5300` and click **Start listener**.

## Synthetic traffic

Run from a second PowerShell window while the app listens:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\send-test-udp.ps1 -Port 5300 -Count 1000 -Hz 60
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

The paced test is explicitly ignored by the fast default Rust test suite; `pnpm test:udp` runs it. Rust tests also cover injected sequence gaps and duplicates, rate math, error state, bind recovery, same/different-port restart, concurrent lifecycle calls, snapshot contention during ingestion, monotonic capture times, sink panic isolation, zero-length packets, bounded previews, maximum-size IPv4 datagrams, and a 1,000-packet burst. Frontend reducer tests cover recovery and stale responses (requires Node with TypeScript stripping, tested with Node 24). Formatting covers the changed frontend/package/test files and all Rust code.

## Limits and next evidence

UDP has no delivery guarantee. Counters describe datagrams received by this process; they cannot detect packets dropped by the OS or network before `recv_from`. The product requests `SO_RCVBUF = 4 MiB`; tests can leave that option untouched with `ReceiveBuffer::SystemDefault`. On Windows, `receive_buffer_bytes` is the value Winsock accepted/read back. It is not a guaranteed OS allocation or proof of actual queue capacity. The earlier 989/1000 result has no sequence evidence and cannot be attributed to receive buffering. Loopback synthetic results do not establish loss-free performance with game traffic, bursty large payloads, CPU contention, or real network conditions. Only the latest raw datagram is retained; there is no capture history or persistence.

The listener binds IPv4 on all local interfaces. Real FH6 traffic still needs packet-size/sample evidence and testing on the target machine. No game parser, SQLite, AI, accounts, charts, or backend service is included.

See `docs/ROADMAP.md` and `docs/adr/0001-capture-before-parser.md` for scope and the capture-before-parser decision.
