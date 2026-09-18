# First six FH6 raw datasets

The user manually verified the frozen V0.2.2 ingress: bound port **20440**, continuous FH6 traffic, **324-byte** observed datagrams, source **127.0.0.1:5200**, approximately **70 packets/sec** during that sample, and **0 receive errors**. This is observed transport evidence, not a parsed packet schema or a guaranteed fixed rate/source.

## Prepare once

1. From `C:\Users\PC\Desktop\racelab-v0.1`, run `pnpm tauri dev`.
2. Keep FH6's telemetry destination at the already verified `127.0.0.1:20440`. In RaceLab, enter **20440** and click **Start listener**.
3. Confirm continuous packet-count growth, the actual size/source/rate, and zero receive errors. Do not run the synthetic sender during these captures. If size, source or rate differs from the earlier observation, record the difference; do not filter or discard bytes based on assumptions.
4. Use the same car, tune, assists, transmission setting and location for the first five recordings. Record those choices, game build/version if available, input device, date, and telemetry settings in a text note. Arrange a repeatable in-game road/test area. Keep RaceLab visible on another display if available, or switch back to it to control capture.

## Record each dataset

Enter the exact label below in **Capture label** and click **Start Capture**. Wait for **recording**, perform the timed sequence, then click **Stop Capture** and wait for **Saved** before starting the next dataset. Duration is measured by RaceLab's monotonic clock; switching between apps adds some time, so note actual action times and any pause/background behavior rather than trimming or fabricating timestamps. A stopwatch can guide the action sequence.

| Label | Target duration | In-game sequence after Start Capture |
|---|---:|---|
| `01-fh6-stationary-idle` | 30 s | Stay stationary in active gameplay. No throttle or steering; hold the brake only if necessary to remain still, and note it. |
| `02-fh6-stationary-revs` | 30 s | Remain stationary. First 5 s idle, next 20 s perform four gentle throttle-rise/release cycles of about 5 s each, final 5 s idle. Use a game setting that permits stationary revving; note gear/brake use and any movement. |
| `03-fh6-straight-acceleration` | 60 s | First 5 s stationary, next 40 s accelerate along a straight with minimal steering, final 15 s release throttle and coast. Allow normal gear changes and note observed shifts/any interruption. |
| `04-fh6-straight-braking` | 60 s | First 15 s accelerate straight, next 10 s release throttle and coast, next 10 s brake progressively to a stop, final 25 s remain stationary. Note if stopping took a different time. |
| `05-fh6-steering-left-right` | 60 s | First 10 s establish low, steady speed. Next 40 s alternate gentle left/right turns, about 10 s per direction (left, right, left, right). Final 10 s straighten and slow to a stop. Note throttle/brake changes. |
| `06-fh6-mixed-driving` | 120 s | First 10 s stationary, next 100 s drive normally through acceleration, coasting, braking, left/right turns and gear changes, final 10 s stop and idle. Note any collisions, menus, resets, or focus changes. |

These are input/observation scenarios for later offline comparison. No signal or field interpretation is assumed. Approximate packet totals at the observed 70 Hz would be 2,100 / 2,100 / 4,200 / 4,200 / 4,200 / 8,400; these are planning estimates, not pass/fail counts.

## Verify and preserve each recording

1. Confirm **Saved**, a nonzero captured count, **0 dropped capture frames**, and **0 receive errors** in the listener. Check duration, the complete size histogram, first/last timestamps and previews. If capture drops or storage errors occurred, preserve the failed file as evidence and repeat that scenario with a label ending `-retry01`.
2. Copy the full `.rlcap` path displayed in the panel. Files normally live in `%LOCALAPPDATA%\com.tahagurvardar.racelab\captures`; the actual UI path is authoritative. Open that folder in Explorer and keep the `.rlcap` and matching `.summary.json` together.
3. From the repository root, validate that exact file and calculate its digest (replace the example path with the displayed path):

   ```powershell
   $captureFile = 'C:\Users\PC\AppData\Local\com.tahagurvardar.racelab\captures\REPLACE-WITH-ACTUAL-FILENAME.rlcap'
   cargo run --manifest-path src-tauri/Cargo.toml --example inspect_capture -- $captureFile
   Get-FileHash -Algorithm SHA256 -LiteralPath $captureFile
   ```

4. Require successful inspection with `complete_file: true`, `loss_free_capture: true`, and `captured_packets` matching the UI/sidecar. A zero-byte packet is allowed, but unexpected size distributions should be documented for analysis.
5. Add a matching `.notes.txt` with the dataset label, binary filename and SHA-256, car/tune/assists/transmission, game version and telemetry settings, action timing, observed source/rate/sizes, receive errors, and any pauses or deviations. Preserve original raw bytes; do not convert payloads to hex, resample, strip headers, or edit the capture.
6. Repeat for all six labels. Stop the listener when finished. The six binary files, summaries and notes form the first evidence set; parser offsets will be determined only from later analysis.

An interrupted app or machine shutdown may leave an incomplete capture without a valid footer or summary. The inspector rejects it as a complete fixture. Repeat that dataset; V0.3 does not claim automatic recovery of interrupted recordings.
