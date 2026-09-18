# 10 Hz UDP loss investigation — 2026-09-18

## Finding

**The exact root cause remains unresolved. The reproduced loss is not a 90/95/100-second truncation or early teardown.** The requested matrix delivered 5,998 of 6,000 packets; all 6,000 sender calls returned the full 128 bytes. The failed 100-second run missed only sequences **132 and 192**, sent at **13.1129352 s and 19.1101964 s** after sender start. Sequence **1000 arrived**. Teardown did not begin until **105.6543566 s** after case start.

A separate, short, bare-socket control also missed sequence **8**, only **0.6930643 s** after its sender started. Its pending receive call returned Winsock **10060 (TimedOut)** after that send completed. This isolates a reproduction away from RaceLab statistics, React, PowerShell, child-process management and long-run lifetime. The **100 ms blocking receive timeout / Windows receive path is the strongest lead**, not an established kernel-level cause. A 250 ms control and a subsequent 100 ms control both passed, so this small experiment is not proof that changing the timeout fixes loss.

No production listener code, socket buffer size, UI or parser was changed. The matrix uses the two existing configurations on separate sockets. The additional control changes only a test-local read timeout; it never sets SO_RCVBUF.

## Timeout and lifetime audit

| Component | Existing behavior | Consequence |
|---|---|---|
| UDP listener | Per-call blocking read timeout is 100 ms. TimedOut, WouldBlock and Interrupted retry. | No elapsed-session deadline. A timeout does not intentionally stop the loop. At 10 Hz, send spacing is near this timeout. |
| Listener lifetime | Arc owns listener; explicit stop or Drop sets stop flag and joins worker. Fatal receive errors stop the worker. | No automatic 90/95/100-second stop. Matrix keeps its Arc alive through child completion and grace period. |
| Start / stop serialization | Lifecycle mutex spans worker join/bind. | No concurrent start/stop was issued during these runs. |
| Rust statistics | Packet totals updated in receive loop; rate uses elapsed monotonic time with a 1-second refresh window. | Rate window cannot truncate packet totals. |
| Tauri publisher | 250 ms recv_timeout on its cancellation channel; application exit stops publisher/listener. | Independent of UDP loop. Tauri and React are absent from these integration runs. |
| Original integration sender | Command.output() waits for child completion; diagnostic version uses spawn() then wait_with_output(). | Neither imposes a child timeout. |
| PowerShell sender | Count-bounded loop; absolute monotonic pacing at (seq-1)/Hz seconds. | Seq 1000 is scheduled at 99.9 seconds at 10 Hz. No overall deadline or timer cancellation. |
| wait_for_packets helper | 3-second deadline, used by short unit tests after sending. | Not used for the paced PowerShell integration matrix. |
| Integration count wait | Up to 3 seconds, starting only AFTER child exit. | Cannot stop the receiver at 3 seconds or while the sender is running. |
| Integration cleanup | Additional 2.2 seconds, sampler stop/join (250 ms cadence), then listener stop/join. | Receiver remains live beyond the last send. Stop/join requests and returns are logged. |
| Test runner / shell tool | Rust emits an informational warning after 60 seconds. Shell execution can yield a live session ID. | Neither warning nor tool yield kills the test. Matrix completed after 496.14 seconds; replay after 94.36 seconds. |

The source audit found no fixed 90-, 95- or 100-second lifetime/deadline. The number 100 in the listener is **milliseconds per receive call**.

## Requested matrix

Windows localhost, 128-byte synthetic datagrams, sequential runs, one PowerShell child per row. All sender exit statuses were successful. Each TSV send record was checked for sequence, full byte count and success; this does not assume loop completion equals send success.

| Run | Sender successes / attempts | Receiver count | First / last received | Every missing sequence range |
|---|---:|---:|---|---|
| 10hz-100-default | 100/100 | 100 | 1 / 100 | none |
| 10hz-100-4mib | 100/100 | 100 | 1 / 100 | none |
| 10hz-300-default | 300/300 | 300 | 1 / 300 | none |
| 10hz-300-4mib | 300/300 | 300 | 1 / 300 | none |
| 10hz-600-default | 600/600 | 600 | 1 / 600 | none |
| 10hz-600-4mib | 600/600 | 600 | 1 / 600 | none |
| 10hz-1000-default | 1000/1000 | 998 | 1 / 1000 | 132, 192 |
| 10hz-1000-4mib | 1000/1000 | 1000 | 1 / 1000 | none |
| 20hz-1000-4mib | 1000/1000 | 1000 | 1 / 1000 | none |
| 60hz-1000-4mib | 1000/1000 | 1000 | 1 / 1000 | none |

All runs retained the expected final sequence (including seq=1000 for all 1,000-packet runs). No duplicate, malformed or unexpected sequences; no observer overflow; monotonic capture times never decreased. Backend totals matched collected sequence observations. The listener was running at every sampled snapshot and immediately before stop. No fatal receive errors were reported; ordinary socket timeouts are intentionally not included in that production error counter.

Default-buffer aggregate: **1,998/2,000**. Existing 4 MiB configuration: **2,000/2,000 at 10 Hz**, plus **2,000/2,000 at 20/60 Hz**. Winsock SO_RCVBUF readbacks were **65,536** and **4,194,304** bytes respectively. These are accepted/read-back option values, not proof of OS allocation or queue capacity. One pass of the current configuration does not establish that buffer size caused or cured the earlier intermittent losses.

## Monotonic timing and teardown

All values below are seconds relative to each row's case_start, calculated from Windows QPC ticks at **10,000,000 ticks/second**. PowerShell Stopwatch and the test use that clock. Raw absolute ticks are retained in the lifecycle TSVs and analysis.json.

Receiver start request / ready brackets the Listener.start() call: ready is its return, not a native thread-entry timestamp. The worker may begin executing before or after that return; the first observed packet proves it was receiving. Receiver joined is the return from stop(), after worker completion and socket closure. Teardown finished marks completion of teardown/report collection before artifact writes, not the later test-function return. Per-packet capture_us is the listener's monotonic session-relative ingestion time; callback_ticks is the observer callback time, not a wire-arrival timestamp.

| Run | Sender start / end | Receiver start requested / ready | Teardown requested | Receiver joined / socket closed | Teardown finished |
|---|---|---|---|---|---|
| 10hz-100-default | 0.3006343 / 10.2016775 | 0.0001774 / 0.0017291 | 12.5156427 | 12.5950398 | 12.5954897 |
| 10hz-100-4mib | 0.2676983 / 10.1741438 | 0.0000056 / 0.0002075 | 12.5254476 | 12.5650354 | 12.5653714 |
| 10hz-300-default | 0.2772088 / 30.1868735 | 0.0000073 / 0.0002034 | 32.5343532 | 32.5802013 | 32.5813732 |
| 10hz-300-4mib | 0.3398346 / 30.2433863 | 0.0000069 / 0.0002153 | 32.5429342 | 32.6229480 | 32.6243173 |
| 10hz-600-default | 0.2733068 / 60.1765306 | 0.0000062 / 0.0002058 | 62.5842597 | 62.6816656 | 62.6834107 |
| 10hz-600-4mib | 0.2727635 / 60.1854979 | 0.0000089 / 0.0002162 | 62.5826300 | 62.6785760 | 62.6798860 |
| 10hz-1000-default | 0.3366272 / 100.2422897 | 0.0000112 / 0.0002379 | 105.6543566 | 105.6844721 | 105.6866457 |
| 10hz-1000-4mib | 0.4946235 / 100.4019241 | 0.0000051 / 0.0002434 | 102.6688045 | 102.6969846 | 102.6991908 |
| 20hz-1000-4mib | 0.2905950 / 50.2512789 | 0.0000032 / 0.0002220 | 52.5769182 | 52.6455710 | 52.6476641 |
| 60hz-1000-4mib | 0.2969580 / 16.9580400 | 0.0000071 / 0.0002198 | 19.2921777 | 19.3520370 | 19.3541868 |

For the failed run, sender end = **100.2422897 s**, child exit observed = **100.3222151 s**, stats-wait end = **103.3281382 s**, teardown requested = **105.6543566 s**, receiver joined = **105.6844721 s**. The three-second stats wait extended the run after sending; it did not cut it short.

The missing packets were **isolated internal gaps**, not tail loss and not a cluster near 90–100 seconds:

| Missing seq | Send start relative to sender start | Measured send call/audit interval | Return | Gap since previous send start |
|---|---:|---:|---|---:|
| 132 | 13.1129352 s | 0.1150 ms | 128 bytes, True | 107.6737 ms |
| 192 | 19.1101964 s | 0.0988 ms | 128 bytes, True | 108.5199 ms |

The following sequences (133 and 193) and all final sequences arrived. These intervals slightly exceed the listener's 100 ms read timeout. The matrix alone cannot prove where these two datagrams disappeared.

## Short receiver control

The ignored replay test uses a bare std::net::UdpSocket and a native Rust sender. It replays the first 300 measured send-start offsets from the failed matrix row, with actual timings independently logged. It has no RaceLab Listener, statistics lock, publisher, PowerShell child or long-run deadline. It retains the default receive buffer, and captures every recv_from call's start, end, result and OS error. Receiver teardown begins only after sending ends plus 1.5 seconds.

| Run | Test-local read timeout | Successful sends | Received | First / last | Missing ranges |
|---|---:|---:|---:|---|---|
| replay-1 | 100 ms | 300 | 299 | 1 / 300 | **8** |
| replay-2 | 250 ms | 300 | 300 | 1 / 300 | none |
| replay-3 | 100 ms | 300 | 300 | 1 / 300 | none |

All buffers read back 65,536 bytes. All 900 send calls returned 128 bytes. All tails included seq=300; no duplicate or malformed observations. The control test deliberately records all three outcomes instead of failing on loss; its Rust test status of 'ok' means the experiment completed, **not** that every packet arrived.

Replay-1 absolute QPC evidence:

- Receiver thread start: **124273254463**; sender start: **124273460337**.
- Seq 7 received successfully at **124279297121**.
- Next recv_from entered at **124279297293**.
- Seq 8 send started at **124280390980**, returned 128 bytes at **124280391758**.
- Pending recv_from returned TimedOut / OS error 10060 at **124280421457**, about **2.9699 ms after the successful send returned**.
- Next recv_from entered at **124280421592** and returned seq 9 at **124281308033**. Seq 8 never appeared later.
- Sender ended at **124572364805**; teardown requested at **124587370039**; receiver thread ended at **124587619759**; joined at **124587621892**.

Thus the short reproduction occurs inside a receive-timeout boundary, long before any teardown. A successful send only proves acceptance by the sending socket API; it cannot by itself prove delivery into the destination socket. No OS packet trace was captured, so the exact internal drop point is still unknown. Microsoft documents SO_RCVTIMEO as the per-call blocking receive timeout: [Winsock socket options](https://learn.microsoft.com/en-us/windows/win32/winsock/sol-socket-socket-options).

## Scope, validation and limitations

Changes in this investigation:

- scripts/send-test-udp.ps1: optional in-memory per-send audit, send success/failure accounting and monotonic session timestamps.
- src-tauri/tests/support/mod.rs: expose a copy of bounded test observations and exercise it in the existing sequence test.
- src-tauri/tests/udp_diagnosis.rs: ignored duration matrix and bare-receiver control; all synthetic decoding stays in tests.
- docs/UDP-10HZ-DIAGNOSIS.md and docs/udp-diagnosis/: this report, exact raw evidence, analysis and inventory.

Other pre-existing working-tree edits belong to the prior V0.2/V0.2.1 work. They were not introduced as diagnosis fixes.

Validation: cargo fmt --check and cargo clippy --all-targets -- -D warnings passed. The ordinary Rust suite passed **18 test executions** (10 ingress tests plus 4 shared sequence tests in each of two integration binaries), with 3 long tests ignored. The explicitly run duration matrix **failed**, as intended on loss: 9 rows complete, 1 row missing 2 packets; elapsed **496.14 s**. The explicitly run replay experiment completed in **94.36 s** with one missing packet. A localized MSVC linker informational message remains emitted as a warning during cargo test.

The instrumentation adds small in-memory/QPC overhead and can change timing; losses are intermittent. These runs do not prove that every historical failure shares this mechanism. No lifecycle fix was made because no duration/lifecycle bug was established. No production timeout change was made on the basis of this limited control.

Classification: **unresolved exact root cause, with evidence pointing at the receiver/Windows blocking-read timeout path**. Sender API failures and test lifetime truncation were not observed. Further isolation would require repeated controlled timeout/no-timeout receiver comparisons and an OS-level packet/receive trace around a missing sequence. This investigation does not establish loss-free operation or justify freezing ingress as loss-free.

## Reproduction and raw evidence

Run sequentially from the repository root (the replay consumes the matrix trace). These commands overwrite same-named evidence files, so preserve previous evidence before re-running.

~~~powershell
cargo test --manifest-path src-tauri/Cargo.toml --test udp_diagnosis duration_matrix -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --test udp_diagnosis replay_receiver_timeout_control -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml
~~~

Each matrix label has -sends.tsv, -received.tsv, -lifecycle.tsv, -snapshots.tsv and -sender.txt. Replay labels have -sends.tsv and -recv-calls.tsv. matrix.log and timeout-control.log retain exact results and replay lifecycle ticks; analysis.json retains machine-readable matrix timing/count/missing-send data. FILES.txt enumerates the investigation's files.
