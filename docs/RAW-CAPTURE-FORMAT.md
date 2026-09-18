# RaceLab raw capture format — RLCAP v1

V0.3 records opaque datagrams. No field offsets, game schemas, conversions, filtering by size/source, or resampling are applied. A 324-byte FH6 observation is evidence about the supplied sample, not a format constraint.

## Files and lifecycle

Each capture creates `<unix-ms>-<128-bit-random-id>.rlcap` and, on successful Stop Capture, a matching `.summary.json`. The explicit UTF-8 label is metadata; labels never form filesystem paths. Files use create-new semantics and do not overwrite existing captures. The application stores them under Tauri's `app_local_data_dir()/captures`, normally `%LOCALAPPDATA%\com.tahagurvardar.racelab\captures` on Windows. The UI displays the actual full path.

Start validates the label (trimmed, 1–256 UTF-8 bytes), creates the directory/file, writes the header, and starts a dedicated writer before opening packet admission. Capture duration uses `Instant`, beginning after header preparation. Stop atomically closes admission and records the duration, then disconnects the sender, drains accepted packets, writes the footer, flushes and syncs the raw file, and writes/syncs the summary. The UI says **Saved** only after these operations succeed. Drain time is excluded from capture duration. Repeated Stop is idempotent; a second Start while a session is open is rejected. Each new capture resets capture counters and uses a new file.

Admission is defined at the existing `PacketSink::on_packet` callback, serialized by a short memory-only mutex. Callbacks before Start opens admission and after Stop closes it are excluded. A callback already in progress when Stop closes admission completes first. These boundaries do not flush the operating system's receive queue or retroactively classify packets that arrived at the socket before their callbacks. Capture is independent of listener stop/restart; stopping the listener does not save the capture. An orderly application exit stops the listener and drains capture.

The ingress callback copies at most 65,535 bytes and calls `try_send` on a **4,096-frame bounded queue**. Full queues drop the newest frame and increment `dropped_capture_frames`; ingress never waits for disk. A short admission mutex is never held during disk access, summary updates, or writer joins. The separate lifecycle mutex can cover I/O but is never acquired by ingress. The writer updates size counts and previews outside ingress. At 324 bytes the queue holds about 1.27 MiB of payload; at the format limit it holds just under 256 MiB, plus bounded metadata, a producer/consumer frame and the writer buffer.

Live `captured_packets` counts complete records handed to the buffered writer and remains provisional until successful save. Queue overflow is shown prominently and stored in both footer and summary. A write failure surfaces immediately; the writer drains and counts rejected frames until Stop. Errors during flush/sync/summary creation also surface, and the session is not shown as Saved. Previously buffered bytes cannot be assumed durable after a storage failure; the error is authoritative even if a live count was nonzero. Stop the failed capture before starting again. Files are preserved for investigation.

## Byte layout

All unsigned integers use **little endian**. IP addresses use their normal network-order octets. There is no alignment padding, compression, packet payload encoding, or implicit delimiter. Zero-length datagrams are valid. EOF is valid only after a complete footer.

Header, once:

| Field | Bytes | Meaning |
|---|---:|---|
| magic | 8 | ASCII `RLCAP`, then `0D 0A 00` |
| version | 4 | `u32`, currently 1 |
| label_length | 4 | `u32`, 1–256 UTF-8 bytes |
| started_at_ms | 8 | `u64`, Unix wall-clock ms sampled during file/header preparation |
| label | label_length | Exact trimmed UTF-8 label |

Packet record, repeated in admission order (56-byte metadata prefix):

| Field | Bytes | Meaning |
|---|---:|---|
| tag | 1 | `01` |
| capture_at_us | 8 | `u64`, monotonic microseconds since capture clock start, sampled at sink admission |
| listener_at_us | 8 | `u64`, original `CapturedPacket.captured_at_us`, unchanged |
| received_at_ms | 8 | `u64`, original Unix wall-clock milliseconds, unchanged |
| address_family | 1 | `04` IPv4 or `06` IPv6 |
| source_ip | 16 | IPv4: first 4 octets followed by 12 zero bytes; IPv6: all 16 octets |
| source_port | 2 | `u16` |
| flow_info | 4 | `u32`, IPv6 flow info, zero for IPv4 |
| scope_id | 4 | `u32`, IPv6 scope ID, zero for IPv4 |
| original_length | 4 | `u32`, 0–65,535; also the stored payload length |
| payload | original_length | Exact original raw datagram bytes |

Footer, exactly once (25 bytes):

| Field | Bytes | Meaning |
|---|---:|---|
| tag | 1 | `02` |
| duration_us | 8 | `u64`, capture duration to Stop admission boundary |
| dropped_capture_frames | 8 | `u64`, frames discarded by capture |
| captured_packets | 8 | `u64`, complete packet records in file |

File length is `24 + label_length + sum(56 + original_length) + 25`.

`capture_at_us` is nondecreasing (equal microsecond values are allowed). It stays ordered across listener restarts. `listener_at_us` preserves the earlier ingress measurement and can reset when the listener restarts; `received_at_ms` can move backwards when the wall clock changes. The capture timestamp includes any delay between ingress measurement and the sink callback; it is not a replacement claim about socket arrival time. No timestamps or packet bytes are rewritten during reading.

## Summary and offline use

The JSON sidecar contains the label, status, file path, start time, capture duration, captured count, dropped count, queue capacity, packet-size histogram, first/last timestamps (both monotonic clocks and wall clock), first/last 32-byte hex previews, and error state. Empty captures use null first/last fields and an empty histogram. An empty datagram has a present timestamp and an empty preview string. Only previews are hex; packet storage is binary. UI revision/admission fields in the sidecar are diagnostic snapshots, not replay inputs. The binary file is self-contained and can be moved without editing the sidecar's historical absolute path.

`capture_format::CaptureReader<R: Read>` streams one `RawPacket` at a time with bounded memory. Consume `next_packet()` until it returns `Ok(None)` to verify the footer. It rejects unsupported versions, malformed addresses, invalid lengths/UTF-8, decreasing capture timestamps, truncated records/footer, footer count/duration mismatches, and trailing bytes. An interrupted capture may yield a readable prefix but fails full validation. V1 has no per-record checksum or automatic crash recovery; preserve a SHA-256 digest for fixtures to detect later byte changes.

Validate/reconstruct a summary without the sidecar:

```powershell
cargo run --manifest-path src-tauri/Cargo.toml --example inspect_capture -- 'C:\full\path\capture.rlcap'
Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\full\path\capture.rlcap'
```

`capture_format::replay(reader, &sink)` streams packets to a `PacketSink` in file order, with identical bytes, source, and wall-clock time. The replay callback's monotonic field uses `capture_at_us`; use `CaptureReader` directly to access both clocks. Replay is offline and unpaced: it does not create a UDP socket or sleep. It returns the validated footer or an error; a malformed file may have delivered a prefix before the error, so always check the result. A nonzero dropped count means exact replay of the saved subset, not a loss-free dataset.

For future deterministic parser tests, copy an approved `.rlcap`, its summary and observation notes into a versioned fixture directory. Record its SHA-256, label, captured count and size distribution in a manifest. Require a valid footer and zero capture drops; compare parser expectations against the stored bytes rather than live UDP, current wall time or packet-rate guesses. The reader/replay tests include arbitrary binary bytes, empty datagrams, IPv6 metadata, maximum-length records and exact ordering. No FH6 parser exists in V0.3.

Capture drops do not measure losses in the game, network or OS before the application receives a datagram. Zero capture drops and zero receive errors alone cannot prove that the game sent no additional packets.
