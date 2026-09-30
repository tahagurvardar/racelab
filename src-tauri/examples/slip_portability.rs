//! Cross-vehicle slip distributions across every persisted session in a
//! sessions root.
//!
//! `slip_profile` answers "what did *this* session's slip channels do". This
//! answers the question V0.9 left open and V0.10 must not guess at: **is the
//! absolute slip threshold portable across cars?** A threshold tuned on one
//! vehicle is a property of that vehicle until a second vehicle says otherwise,
//! so the only defensible way to argue about `slip_ratio_enter` is to put the
//! per-vehicle, per-corner distributions next to each other.
//!
//! ```powershell
//! cargo run --release --manifest-path src-tauri/Cargo.toml --example slip_portability -- '<sessions-root>'
//! cargo run --release --manifest-path src-tauri/Cargo.toml --example slip_portability -- '<sessions-root>' --json report.json
//! ```
//!
//! Read-only. It opens `manifest.json` and `frames.rlframes` and writes nothing
//! except an optional report file the caller names.
//!
//! Three rules keep the output honest:
//!
//! 1. **Only measured samples.** A corner whose channel is unavailable
//!    contributes nothing; it is never counted as a zero. A V1 recording
//!    carries no wheel telemetry at all and is reported as skipped, not as a
//!    vehicle that measured no slip.
//! 2. **Time, not samples, for threshold occupancy.** "Time above threshold" is
//!    the summed inter-frame interval, with intervals longer than `max_gap_ms`
//!    excluded exactly as the analyzer excludes them. A sample count would let
//!    a high-rate session outvote a low-rate one.
//! 3. **No interpretation.** The numbers are `|slip_ratio|` and
//!    `combined_slip`. Neither is called wheelspin, lock or traction loss, and
//!    no physical normalization is asserted for either.
use racelab_lib::{
    analysis::AnalysisConfigV1,
    session_format::{self, FrameStreamReader, SessionStatus, FRAME_FILE_NAME},
    telemetry::{WheelPosition, WHEEL_POSITIONS},
};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::BufReader,
    path::{Path, PathBuf},
};

/// Sorted samples plus the time they occupied. Bounded by the corpus size,
/// which is the point: this is an offline reporting tool, not the analyzer.
#[derive(Default)]
struct Channel {
    values: Vec<f32>,
    /// Seconds spent at or above the threshold, and total measured seconds.
    seconds_above: f64,
    seconds_measured: f64,
    sorted: bool,
}

impl Channel {
    fn observe(&mut self, value: f32, dt_seconds: f64, threshold: f32) {
        if !value.is_finite() {
            return;
        }
        self.values.push(value);
        self.sorted = false;
        self.seconds_measured += dt_seconds;
        if value >= threshold {
            self.seconds_above += dt_seconds;
        }
    }

    fn sort(&mut self) {
        if !self.sorted {
            self.values.sort_by(|a, b| a.total_cmp(b));
            self.sorted = true;
        }
    }

    /// Nearest-rank quantile over the sorted samples.
    fn quantile(&self, fraction: f64) -> Option<f32> {
        if self.values.is_empty() {
            return None;
        }
        Some(self.values[((self.values.len() - 1) as f64 * fraction).round() as usize])
    }

    fn share_above(&self) -> f64 {
        if self.seconds_measured <= 0.0 {
            return 0.0;
        }
        self.seconds_above / self.seconds_measured
    }
}

fn quantile_text(channel: &Channel, fraction: f64) -> String {
    channel
        .quantile(fraction)
        .map(|value| format!("{value:.3}"))
        .unwrap_or_else(|| "-".into())
}

/// Everything measured for one vehicle. Corner arrays are in
/// `WHEEL_POSITIONS` order; the index is never a source wheel index.
#[derive(Default)]
struct Vehicle {
    sessions: Vec<String>,
    frames: u64,
    active_frames: u64,
    slip_ratio: [Channel; 4],
    combined_slip: [Channel; 4],
    /// Worst corner in each frame, which is what a whole-car threshold sees.
    worst_slip_ratio: Channel,
    worst_combined_slip: Channel,
    analyzed_seconds: f64,
}

fn corner_label(position: WheelPosition) -> &'static str {
    match position {
        WheelPosition::FrontLeft => "front_left",
        WheelPosition::FrontRight => "front_right",
        WheelPosition::RearLeft => "rear_left",
        WheelPosition::RearRight => "rear_right",
    }
}

struct Options {
    root: PathBuf,
    json: Option<PathBuf>,
    slip_ratio_threshold: f32,
    combined_slip_threshold: f32,
    max_gap_ms: u64,
}

const USAGE: &str =
    "Usage: slip_portability <sessions-root> [--json <file>] [--slip-ratio <f32>] [--combined-slip <f32>]";

fn parse_options() -> Result<Options, String> {
    let config = AnalysisConfigV1::default();
    let mut arguments = std::env::args().skip(1);
    let root = PathBuf::from(arguments.next().ok_or(USAGE)?);
    let mut options = Options {
        root,
        json: None,
        slip_ratio_threshold: config.slip_ratio_enter,
        combined_slip_threshold: config.combined_slip_enter,
        max_gap_ms: config.max_gap_ms,
    };
    while let Some(flag) = arguments.next() {
        let value = arguments
            .next()
            .ok_or_else(|| format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--json" => options.json = Some(PathBuf::from(value)),
            "--slip-ratio" => {
                options.slip_ratio_threshold =
                    value.parse().map_err(|_| "--slip-ratio must be a number")?;
            }
            "--combined-slip" => {
                options.combined_slip_threshold = value
                    .parse()
                    .map_err(|_| "--combined-slip must be a number")?;
            }
            other => return Err(format!("Unknown flag {other}")),
        }
    }
    Ok(options)
}

/// One session's contribution. A session that cannot be opened is reported and
/// skipped; it never aborts the sweep.
fn scan_session(directory: &Path, options: &Options, vehicle: &mut Vehicle) -> Result<(), String> {
    let file = File::open(directory.join(FRAME_FILE_NAME))
        .map_err(|error| format!("frame stream: {error}"))?;
    let mut reader =
        FrameStreamReader::new(BufReader::new(file)).map_err(|error| format!("header: {error}"))?;
    let mut previous_ms: Option<u64> = None;
    loop {
        let record = match reader.next_frame() {
            Ok(Some(record)) => record,
            Ok(None) => break,
            // A truncated or damaged tail ends this session's contribution;
            // everything already read stays counted.
            Err(error) => {
                eprintln!("  stopped early in {}: {error}", directory.display());
                break;
            }
        };
        vehicle.frames += 1;
        let gap = previous_ms.map(|previous| record.monotonic_ms.saturating_sub(previous));
        previous_ms = Some(record.monotonic_ms);
        if !record.frame.active {
            continue;
        }
        vehicle.active_frames += 1;
        // The same exclusion rule the analyzer applies, so "time above
        // threshold" here and analyzed time there mean the same thing.
        let dt_seconds = match gap {
            Some(gap) if gap > 0 && gap <= options.max_gap_ms => gap as f64 / 1000.0,
            _ => 0.0,
        };
        vehicle.analyzed_seconds += dt_seconds;
        let mut worst_ratio = f32::NEG_INFINITY;
        let mut worst_combined = f32::NEG_INFINITY;
        for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
            let wheel = record.frame.wheels.get(position);
            if let Some(value) = wheel.slip_ratio {
                let value = value.abs();
                vehicle.slip_ratio[index].observe(value, dt_seconds, options.slip_ratio_threshold);
                worst_ratio = worst_ratio.max(value);
            }
            if let Some(value) = wheel.combined_slip {
                vehicle.combined_slip[index].observe(
                    value,
                    dt_seconds,
                    options.combined_slip_threshold,
                );
                worst_combined = worst_combined.max(value);
            }
        }
        if worst_ratio.is_finite() {
            vehicle
                .worst_slip_ratio
                .observe(worst_ratio, dt_seconds, options.slip_ratio_threshold);
        }
        if worst_combined.is_finite() {
            vehicle.worst_combined_slip.observe(
                worst_combined,
                dt_seconds,
                options.combined_slip_threshold,
            );
        }
    }
    Ok(())
}

fn report_channel(label: &str, channel: &mut Channel, threshold: f32) {
    channel.sort();
    println!(
        "  {label:<32} n={:<9} p50={:<8} p90={:<8} p95={:<8} p99={:<8} max={:<10} above {threshold:.2}: {:>7.3}% of {:>8.1}s",
        channel.values.len(),
        quantile_text(channel, 0.50),
        quantile_text(channel, 0.90),
        quantile_text(channel, 0.95),
        quantile_text(channel, 0.99),
        quantile_text(channel, 1.0),
        channel.share_above() * 100.0,
        channel.seconds_measured,
    );
}

fn json_channel(channel: &mut Channel, threshold: f32) -> String {
    channel.sort();
    let quantile = |fraction: f64| {
        channel
            .quantile(fraction)
            .map(|value| format!("{value:.6}"))
            .unwrap_or_else(|| "null".into())
    };
    let mut text = String::from("{");
    text.push_str(&format!("\"samples\":{},", channel.values.len()));
    text.push_str(&format!("\"p50\":{},", quantile(0.50)));
    text.push_str(&format!("\"p90\":{},", quantile(0.90)));
    text.push_str(&format!("\"p95\":{},", quantile(0.95)));
    text.push_str(&format!("\"p99\":{},", quantile(0.99)));
    text.push_str(&format!("\"max\":{},", quantile(1.0)));
    text.push_str(&format!("\"threshold\":{threshold:.6},"));
    text.push_str(&format!(
        "\"seconds_above_threshold\":{:.6},",
        channel.seconds_above
    ));
    text.push_str(&format!(
        "\"seconds_measured\":{:.6},",
        channel.seconds_measured
    ));
    text.push_str(&format!(
        "\"share_above_threshold\":{:.9}",
        channel.share_above()
    ));
    text.push('}');
    text
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = parse_options()?;
    let mut vehicles: BTreeMap<String, Vehicle> = BTreeMap::new();
    let mut skipped_v1 = 0_u64;
    let mut skipped_unreadable = 0_u64;
    let mut scanned = 0_u64;

    let mut directories: Vec<PathBuf> = fs::read_dir(&options.root)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    directories.sort();

    for directory in directories {
        let Ok(manifest) = session_format::read_manifest(&directory) else {
            skipped_unreadable += 1;
            continue;
        };
        if manifest.status == SessionStatus::Recording {
            // A live recording is not a stable measurement corpus.
            continue;
        }
        // Wheel telemetry is a schema-2 group. A V1 recording measured no slip
        // at all, which is different from having measured low slip.
        if manifest.telemetry_frame_schema_version < 2 {
            skipped_v1 += 1;
            continue;
        }
        let key = manifest
            .vehicle_id
            .clone()
            .unwrap_or_else(|| "unknown".into());
        let vehicle = vehicles.entry(key).or_default();
        vehicle.sessions.push(manifest.session_id.clone());
        if let Err(error) = scan_session(&directory, &options, vehicle) {
            eprintln!("  {}: {error}", manifest.session_id);
            skipped_unreadable += 1;
            continue;
        }
        scanned += 1;
    }

    println!("sessions root: {}", options.root.display());
    println!(
        "scanned {scanned} schema-2 session(s); skipped {skipped_v1} schema-1 session(s) with no wheel telemetry and {skipped_unreadable} unreadable session(s)"
    );
    println!(
        "thresholds under test: slip_ratio_enter={:.3}, combined_slip_enter={:.3}, max_gap_ms={}",
        options.slip_ratio_threshold, options.combined_slip_threshold, options.max_gap_ms
    );
    println!(
        "vehicles with wheel telemetry: {} - {}",
        vehicles.len(),
        vehicles.keys().cloned().collect::<Vec<_>>().join(", ")
    );

    for (id, vehicle) in vehicles.iter_mut() {
        println!();
        println!(
            "vehicle {id}: {} session(s), {} frames ({} active), {:.1}s analyzed",
            vehicle.sessions.len(),
            vehicle.frames,
            vehicle.active_frames,
            vehicle.analyzed_seconds
        );
        for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
            report_channel(
                &format!("|slip_ratio| {}", corner_label(position)),
                &mut vehicle.slip_ratio[index],
                options.slip_ratio_threshold,
            );
        }
        report_channel(
            "|slip_ratio| worst corner",
            &mut vehicle.worst_slip_ratio,
            options.slip_ratio_threshold,
        );
        for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
            report_channel(
                &format!("combined_slip {}", corner_label(position)),
                &mut vehicle.combined_slip[index],
                options.combined_slip_threshold,
            );
        }
        report_channel(
            "combined_slip worst corner",
            &mut vehicle.worst_combined_slip,
            options.combined_slip_threshold,
        );
    }

    // The portability question in one table: if the same absolute threshold
    // selects wildly different fractions of two cars' driving, it is not a
    // portable threshold.
    println!();
    println!("portability: share of analyzed time above the current absolute thresholds");
    println!(
        "  {:<12} {:>16} {:>18} {:>14}",
        "vehicle", "|slip_ratio| %", "combined_slip %", "analyzed s"
    );
    for (id, vehicle) in vehicles.iter_mut() {
        println!(
            "  {:<12} {:>15.3}% {:>17.3}% {:>14.1}",
            id,
            vehicle.worst_slip_ratio.share_above() * 100.0,
            vehicle.worst_combined_slip.share_above() * 100.0,
            vehicle.analyzed_seconds,
        );
    }

    if let Some(path) = &options.json {
        let mut entries = Vec::new();
        for (id, vehicle) in vehicles.iter_mut() {
            let mut corners = Vec::new();
            for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
                corners.push(format!(
                    "{{\"corner\":\"{}\",\"slip_ratio\":{},\"combined_slip\":{}}}",
                    corner_label(position),
                    json_channel(&mut vehicle.slip_ratio[index], options.slip_ratio_threshold),
                    json_channel(
                        &mut vehicle.combined_slip[index],
                        options.combined_slip_threshold
                    ),
                ));
            }
            let mut entry = String::from("{");
            entry.push_str(&format!("\"vehicle_id\":\"{id}\","));
            entry.push_str(&format!("\"sessions\":{},", vehicle.sessions.len()));
            entry.push_str(&format!("\"frames\":{},", vehicle.frames));
            entry.push_str(&format!("\"active_frames\":{},", vehicle.active_frames));
            entry.push_str(&format!(
                "\"analyzed_seconds\":{:.6},",
                vehicle.analyzed_seconds
            ));
            entry.push_str(&format!("\"corners\":[{}],", corners.join(",")));
            entry.push_str(&format!(
                "\"worst_corner\":{{\"slip_ratio\":{},\"combined_slip\":{}}}",
                json_channel(&mut vehicle.worst_slip_ratio, options.slip_ratio_threshold),
                json_channel(
                    &mut vehicle.worst_combined_slip,
                    options.combined_slip_threshold
                ),
            ));
            entry.push('}');
            entries.push(entry);
        }
        let mut document = String::from("{");
        document.push_str(&format!("\"sessions_scanned\":{scanned},"));
        document.push_str(&format!("\"skipped_schema_1\":{skipped_v1},"));
        document.push_str(&format!("\"skipped_unreadable\":{skipped_unreadable},"));
        document.push_str(&format!("\"vehicles\":[{}]", entries.join(",")));
        document.push_str("}\n");
        fs::write(path, document)?;
        println!();
        println!("wrote {}", path.display());
    }
    Ok(())
}
