//! Evidence sweep over the FH6 fields RaceLab still refuses to promote.
//!
//! V0.8 deferred `boost`, `fuel`, `distance_traveled`, `best_lap`, `last_lap`,
//! `current_lap` and the raw `gear` code on 14,237 active packets from a single
//! car. V0.10 re-asks the same question against every persisted schema-2
//! session, which is a far larger and more varied corpus — including multi-hour
//! free-roam driving. Promotion still requires independent evidence, so this
//! tool only reports what the corpus contains; it never decides.
//!
//! ```powershell
//! cargo run --release --manifest-path src-tauri/Cargo.toml --example deferred_fields -- '<sessions-root>'
//! ```
//!
//! Read-only. It opens `manifest.json` and `frames.rlframes` and writes
//! nothing. The values come from the adapter's own `sourceSpecific.fh6`
//! envelope, which stores every deferred field verbatim as it arrived on the
//! wire, so nothing here re-reads a packet offset or re-derives a unit.
//!
//! What would count as evidence, per field:
//!
//! - A field that is **constant across the whole corpus** is positive evidence
//!   that its assumed meaning is wrong, not merely absent evidence for it.
//! - A field that **varies** still needs an established *unit* before it can
//!   become canonical. Variation alone promotes nothing.
//! - `gear` is different: it is a code, and a code can be established by
//!   showing that it partitions a physical ratio into ordered, separated
//!   clusters. That test is run here.
use racelab_lib::session_format::{self, FrameStreamReader, SessionStatus, FRAME_FILE_NAME};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::BufReader,
    path::PathBuf,
};

/// Range, constancy and zero/non-zero occupancy for one scalar field.
#[derive(Default)]
struct Field {
    samples: u64,
    zero: u64,
    negative: u64,
    min: Option<f64>,
    max: Option<f64>,
    sum: f64,
    /// Distinct values, capped. A field with few distinct values is a very
    /// different object from one with thousands, and the cap keeps a
    /// continuously varying field from exhausting memory.
    distinct: BTreeMap<String, u64>,
    distinct_overflow: bool,
    /// Largest value seen at the top of the range, and how often it recurred
    /// exactly. A saturating field pins here.
    max_repeats: u64,
    /// Whether the value ever decreased between consecutive frames, which
    /// separates a monotonic counter from a free-running quantity.
    decreases: u64,
    previous: Option<f64>,
}

const MAX_DISTINCT: usize = 24;

impl Field {
    fn observe(&mut self, value: f64) {
        if !value.is_finite() {
            return;
        }
        self.samples += 1;
        self.sum += value;
        if value == 0.0 {
            self.zero += 1;
        }
        if value < 0.0 {
            self.negative += 1;
        }
        match self.max {
            Some(current) if value > current => {
                self.max = Some(value);
                self.max_repeats = 1;
            }
            Some(current) if value == current => self.max_repeats += 1,
            Some(_) => {}
            None => {
                self.max = Some(value);
                self.max_repeats = 1;
            }
        }
        self.min = Some(self.min.map_or(value, |current: f64| current.min(value)));
        if self.distinct.len() < MAX_DISTINCT {
            *self.distinct.entry(format!("{value}")).or_default() += 1;
        } else if !self.distinct.contains_key(&format!("{value}")) {
            self.distinct_overflow = true;
        }
        if let Some(previous) = self.previous {
            if value < previous {
                self.decreases += 1;
            }
        }
        self.previous = Some(value);
    }

    fn constant(&self) -> bool {
        self.samples > 0 && !self.distinct_overflow && self.distinct.len() == 1
    }

    fn report(&self, label: &str) {
        if self.samples == 0 {
            println!("  {label:<20} no samples");
            return;
        }
        let mean = self.sum / self.samples as f64;
        println!(
            "  {label:<20} n={:<9} min={:<14.6} max={:<14.6} mean={:<14.6} zero={:>6.2}% neg={:>6.2}% decreases={:<9} distinct={}{}",
            self.samples,
            self.min.unwrap_or(f64::NAN),
            self.max.unwrap_or(f64::NAN),
            mean,
            self.zero as f64 * 100.0 / self.samples as f64,
            self.negative as f64 * 100.0 / self.samples as f64,
            self.decreases,
            self.distinct.len(),
            if self.distinct_overflow { "+" } else { "" },
        );
        if self.constant() {
            println!(
                "  {:<20} CONSTANT at {} across every sample",
                "",
                self.distinct.keys().next().cloned().unwrap_or_default()
            );
        }
        if self.max_repeats > 1 {
            println!(
                "  {:<20} maximum {:.6} recurs exactly {} times ({:.2}% of samples)",
                "",
                self.max.unwrap_or(f64::NAN),
                self.max_repeats,
                self.max_repeats as f64 * 100.0 / self.samples as f64,
            );
        }
        if !self.distinct_overflow {
            let values: Vec<String> = self
                .distinct
                .iter()
                .map(|(value, count)| format!("{value}x{count}"))
                .collect();
            println!("  {:<20} values: {}", "", values.join(" "));
        }
    }
}

/// Per gear-code evidence. A gear code is only establishable if it partitions
/// the speed/RPM ratio into ordered, separated clusters, so that is exactly
/// what is collected: the ratio, per code, with its spread.
#[derive(Default)]
struct GearCode {
    frames: u64,
    ratios: Vec<f64>,
    min_speed: Option<f32>,
    max_speed: Option<f32>,
    /// Moving frames whose wheels were turning backwards, and forwards.
    ///
    /// `Wheel::rotation_rad_s` is canonically documented as signed with forward
    /// rotation positive, so this distinguishes reverse from neutral without
    /// assuming any world-axis convention. Deriving direction from `velocity`
    /// and `orientation` instead would require asserting an axis handedness
    /// that no RaceLab evidence establishes.
    reversing: u64,
    advancing: u64,
}

impl GearCode {
    fn observe(&mut self, frame: &racelab_lib::telemetry::TelemetryFrame) {
        let (speed_mps, rpm) = (frame.speed_mps, frame.engine.rpm);
        self.frames += 1;
        let mut rotation = 0.0_f32;
        let mut corners = 0;
        for position in racelab_lib::telemetry::WHEEL_POSITIONS {
            if let Some(value) = frame.wheels.get(position).rotation_rad_s {
                rotation += value;
                corners += 1;
            }
        }
        if corners > 0 && speed_mps.is_some_and(|speed| speed >= 1.0) {
            if rotation < 0.0 {
                self.reversing += 1;
            } else if rotation > 0.0 {
                self.advancing += 1;
            }
        }
        let (Some(speed), Some(rpm)) = (speed_mps, rpm) else {
            return;
        };
        // Below walking pace or near idle the ratio is dominated by clutch slip
        // and is not evidence about a ratio.
        if speed < 3.0 || rpm < 800.0 {
            return;
        }
        self.min_speed = Some(self.min_speed.map_or(speed, |current| current.min(speed)));
        self.max_speed = Some(self.max_speed.map_or(speed, |current| current.max(speed)));
        self.ratios.push(f64::from(speed) / f64::from(rpm));
    }

    fn quantile(&mut self, fraction: f64) -> Option<f64> {
        if self.ratios.is_empty() {
            return None;
        }
        self.ratios.sort_by(|a, b| a.total_cmp(b));
        Some(self.ratios[((self.ratios.len() - 1) as f64 * fraction).round() as usize])
    }
}

/// Whether a candidate clock advances 1:1 with the game's own timestamp.
///
/// This is the exact test that established `race_time_seconds` as seconds in
/// V0.8: a field whose value advances by the same amount the game timestamp
/// advances is measured in the game timestamp's unit. It is the only unit
/// argument in RaceLab that does not require an external reference, so a
/// deferred clock candidate is entitled to be judged by it.
/// The comparison is made **over a span, never per frame**. Both clocks are
/// f32 seconds: at a race time of 4,700 s an f32 ULP is about 0.24 ms against a
/// ~13 ms frame interval, so a single interval's ratio is dominated by
/// quantization and says nothing about drift. Accumulating a contiguous run and
/// comparing its endpoints removes the quantization entirely, because the error
/// stays one ULP over an arbitrarily long span.
#[derive(Default)]
struct ClockAdvance {
    /// Contiguous runs with no reset, and the ratio each produced.
    runs: Vec<(f64, f64)>,
    resets: u64,
    previous_ms: Option<u64>,
    run_start: Option<(f64, u64)>,
    run_end: Option<(f64, u64)>,
}

/// A span shorter than this cannot resolve drift and is discarded.
const MIN_RUN_SECONDS: f64 = 5.0;

impl ClockAdvance {
    fn observe(&mut self, candidate: f64, timestamp_ms: u64) {
        // A timestamp that did not advance carries no new information; a
        // timestamp that went backwards is a wrap or a new epoch.
        if let Some(previous_ms) = self.previous_ms {
            if timestamp_ms < previous_ms {
                self.close_run();
                self.previous_ms = Some(timestamp_ms);
                self.run_start = Some((candidate, timestamp_ms));
                self.run_end = Some((candidate, timestamp_ms));
                return;
            }
        }
        self.previous_ms = Some(timestamp_ms);
        match self.run_end {
            // A candidate that went backwards is a reset: it ends this run.
            Some((previous_value, _)) if candidate < previous_value => {
                self.resets += 1;
                self.close_run();
                self.run_start = Some((candidate, timestamp_ms));
                self.run_end = Some((candidate, timestamp_ms));
            }
            Some(_) => self.run_end = Some((candidate, timestamp_ms)),
            None => {
                self.run_start = Some((candidate, timestamp_ms));
                self.run_end = Some((candidate, timestamp_ms));
            }
        }
    }

    fn close_run(&mut self) {
        let (Some((start_value, start_ms)), Some((end_value, end_ms))) =
            (self.run_start.take(), self.run_end.take())
        else {
            return;
        };
        let elapsed = (end_ms.saturating_sub(start_ms)) as f64 / 1000.0;
        let advance = end_value - start_value;
        // A run during which the candidate never moved is not evidence about a
        // rate; it is evidence the field was idle, which is reported elsewhere.
        if elapsed >= MIN_RUN_SECONDS && advance > 0.0 {
            self.runs.push((advance / elapsed, elapsed));
        }
    }

    /// Ends the current run without treating it as a reset. Called on every
    /// inactive frame and at every session boundary: a menu advances the
    /// packet timestamp while a race clock is stopped, so a run that spanned
    /// one would measure the pause, not the clock.
    fn break_run(&mut self) {
        self.close_run();
        self.previous_ms = None;
    }

    fn report(&self, label: &str) {
        if self.runs.is_empty() {
            println!(
                "  {label:<26} no run of at least {MIN_RUN_SECONDS:.0}s during which the field advanced ({} resets)",
                self.resets
            );
            return;
        }
        let total_seconds: f64 = self.runs.iter().map(|(_, seconds)| seconds).sum();
        let worst = self
            .runs
            .iter()
            .map(|(ratio, _)| (ratio - 1.0).abs())
            .fold(0.0_f64, f64::max);
        let matching = self
            .runs
            .iter()
            .filter(|(ratio, _)| (ratio - 1.0).abs() <= 1e-3)
            .count();
        println!(
            "  {label:<26} {matching}/{} runs within 1e-3 of 1:1 over {total_seconds:.0}s, worst |ratio-1| = {worst:.3e}, {} resets",
            self.runs.len(),
            self.resets,
        );
    }
}

/// Everything collected for one vehicle. Gear ratios are per vehicle because
/// pooling two cars' gearboxes into one ratio table would manufacture exactly
/// the cross-car confusion this audit exists to avoid.
#[derive(Default)]
struct VehicleEvidence {
    sessions: u64,
    active_frames: u64,
    gear: Field,
    gears: BTreeMap<u64, GearCode>,
}

#[derive(Default)]
struct Corpus {
    sessions: u64,
    frames: u64,
    active_frames: u64,
    /// Frames where the event-only fields are populated at all.
    event_frames: u64,
    boost: Field,
    fuel: Field,
    distance_traveled: Field,
    best_lap: Field,
    last_lap: Field,
    current_lap: Field,
    current_race_time: Field,
    lap_number: Field,
    race_position: Field,
    gear: Field,
    gears: BTreeMap<u64, GearCode>,
    vehicles: BTreeMap<String, VehicleEvidence>,
    /// Pearson accumulators for boost against normalized throttle.
    boost_throttle: Correlation,
    /// The 1:1 unit test, run against the already-promoted `race_time_seconds`
    /// as a control and against the deferred `current_lap` as the candidate.
    race_time_clock: ClockAdvance,
    current_lap_clock: ClockAdvance,
}

/// Streaming Pearson correlation. Enough to restate the V0.8 boost/throttle
/// relationship on a much larger corpus without holding the samples.
#[derive(Default)]
struct Correlation {
    n: f64,
    sx: f64,
    sy: f64,
    sxx: f64,
    syy: f64,
    sxy: f64,
}

impl Correlation {
    fn observe(&mut self, x: f64, y: f64) {
        if !x.is_finite() || !y.is_finite() {
            return;
        }
        self.n += 1.0;
        self.sx += x;
        self.sy += y;
        self.sxx += x * x;
        self.syy += y * y;
        self.sxy += x * y;
    }

    fn value(&self) -> Option<f64> {
        if self.n < 2.0 {
            return None;
        }
        let covariance = self.sxy - self.sx * self.sy / self.n;
        let vx = self.sxx - self.sx * self.sx / self.n;
        let vy = self.syy - self.sy * self.sy / self.n;
        if vx <= 0.0 || vy <= 0.0 {
            return None;
        }
        Some(covariance / (vx * vy).sqrt())
    }
}

fn number(envelope: &Value, key: &str) -> Option<f64> {
    envelope.get(key)?.as_f64()
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Usage: deferred_fields <sessions-root>")?,
    );
    let mut corpus = Corpus::default();
    let mut skipped_v1 = 0_u64;
    let mut skipped_unreadable = 0_u64;
    let mut vehicles: BTreeMap<String, u64> = BTreeMap::new();

    let mut directories: Vec<PathBuf> = fs::read_dir(&root)?
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
            continue;
        }
        if manifest.telemetry_frame_schema_version < 2 {
            skipped_v1 += 1;
            continue;
        }
        let Ok(file) = File::open(directory.join(FRAME_FILE_NAME)) else {
            skipped_unreadable += 1;
            continue;
        };
        let Ok(mut reader) = FrameStreamReader::new(BufReader::new(file)) else {
            skipped_unreadable += 1;
            continue;
        };
        corpus.sessions += 1;
        let vehicle_id = manifest
            .vehicle_id
            .clone()
            .unwrap_or_else(|| "unknown".into());
        *vehicles.entry(vehicle_id.clone()).or_default() += 1;
        corpus
            .vehicles
            .entry(vehicle_id.clone())
            .or_default()
            .sessions += 1;
        loop {
            let record = match reader.next_frame() {
                Ok(Some(record)) => record,
                Ok(None) => break,
                Err(error) => {
                    eprintln!("  stopped early in {}: {error}", manifest.session_id);
                    break;
                }
            };
            corpus.frames += 1;
            if !record.frame.active {
                // A menu or loading screen stops a race clock while the packet
                // timestamp keeps running. Spanning one would measure the pause.
                corpus.race_time_clock.break_run();
                corpus.current_lap_clock.break_run();
                continue;
            }
            corpus.active_frames += 1;
            let Some(envelope) = record
                .frame
                .source_specific
                .as_ref()
                .and_then(|value| value.get("fh6"))
            else {
                continue;
            };
            if let Some(value) = number(envelope, "boost") {
                corpus.boost.observe(value);
                if let Some(throttle) = record.frame.controls.throttle {
                    corpus.boost_throttle.observe(f64::from(throttle), value);
                }
            }
            for (field, key) in [
                (&mut corpus.fuel, "fuel"),
                (&mut corpus.distance_traveled, "distance_traveled"),
                (&mut corpus.best_lap, "best_lap"),
                (&mut corpus.last_lap, "last_lap"),
                (&mut corpus.current_lap, "current_lap"),
                (&mut corpus.current_race_time, "current_race_time"),
                (&mut corpus.lap_number, "lap_number"),
                (&mut corpus.race_position, "race_position"),
                (&mut corpus.gear, "gear"),
            ] {
                if let Some(value) = number(envelope, key) {
                    field.observe(value);
                }
            }
            let vehicle = corpus.vehicles.entry(vehicle_id.clone()).or_default();
            vehicle.active_frames += 1;
            if let Some(code) = number(envelope, "gear") {
                corpus
                    .gears
                    .entry(code as u64)
                    .or_default()
                    .observe(&record.frame);
                vehicle.gear.observe(code);
                vehicle
                    .gears
                    .entry(code as u64)
                    .or_default()
                    .observe(&record.frame);
            }
            // The event-only fields move together: a frame is either free-roam
            // (all zero) or inside an event. Counting it separates "the field
            // is always zero" from "the field is zero outside events".
            if number(envelope, "race_position").is_some_and(|value| value > 0.0) {
                corpus.event_frames += 1;
            }
            // Unit test against the game's own clock, on the same frame.
            if let Some(timestamp_ms) = record.frame.game_timestamp_ms {
                if let Some(value) = number(envelope, "current_race_time") {
                    corpus.race_time_clock.observe(value, timestamp_ms);
                }
                if let Some(value) = number(envelope, "current_lap") {
                    corpus.current_lap_clock.observe(value, timestamp_ms);
                }
            }
        }
        // A session boundary must never join two unrelated clock epochs.
        corpus.race_time_clock.break_run();
        corpus.current_lap_clock.break_run();
    }

    println!("sessions root: {}", root.display());
    println!(
        "scanned {} schema-2 session(s) over {} vehicle(s); skipped {skipped_v1} schema-1 and {skipped_unreadable} unreadable",
        corpus.sessions,
        vehicles.len()
    );
    println!(
        "{} frames, {} active frames",
        corpus.frames, corpus.active_frames
    );
    for (vehicle, count) in &vehicles {
        println!("  vehicle {vehicle}: {count} session(s)");
    }

    println!();
    println!("deferred scalar fields (active frames only, from sourceSpecific.fh6)");
    corpus.boost.report("boost (284)");
    corpus.fuel.report("fuel (288)");
    corpus.distance_traveled.report("distance (292)");
    corpus.best_lap.report("best_lap (296)");
    corpus.last_lap.report("last_lap (300)");
    corpus.current_lap.report("current_lap (304)");

    println!();
    println!("promoted neighbours, for contrast");
    corpus.current_race_time.report("race_time (308)");
    corpus.lap_number.report("lap_number (312)");
    corpus.race_position.report("position (314)");

    println!();
    println!(
        "event-mode frames (race_position > 0): {} of {} active ({:.2}%)",
        corpus.event_frames,
        corpus.active_frames,
        corpus.event_frames as f64 * 100.0 / corpus.active_frames.max(1) as f64
    );

    println!();
    match corpus.boost_throttle.value() {
        Some(r) => println!(
            "pearson r(throttle, boost) = {r:.4} over {} frames",
            corpus.boost_throttle.n
        ),
        None => println!("pearson r(throttle, boost) unavailable"),
    }

    println!();
    println!("unit test: does the candidate advance 1:1 with the game timestamp?");
    println!("  (this is the argument that established race_time_seconds; it is its own control)");
    corpus.race_time_clock.report("current_race_time (308)");
    corpus.current_lap_clock.report("current_lap (304)");

    println!();
    println!("gear code (319): speed/RPM ratio per code, ALL VEHICLES POOLED");
    println!("  (pooled ratios mix two gearboxes and are shown only for contrast)");
    corpus.gear.report("gear (319)");
    report_gears(&mut corpus.gears);

    for (id, vehicle) in corpus.vehicles.iter_mut() {
        println!();
        println!(
            "gear code (319) for vehicle {id}: {} session(s), {} active frames",
            vehicle.sessions, vehicle.active_frames
        );
        vehicle.gear.report("gear (319)");
        report_gears(&mut vehicle.gears);
    }
    Ok(())
}

/// Ordered, separated ratio clusters would establish a gear code. A wide
/// spread means the bucket is not one ratio, whatever the code is called.
fn report_gears(gears: &mut BTreeMap<u64, GearCode>) {
    println!(
        "  {:<8} {:>10} {:>10} {:>12} {:>12} {:>12} {:>10} {:>12} {:>20}",
        "code", "frames", "ratios", "p05", "p50", "p95", "spread", "speed range", "wheels back/fwd"
    );
    let mut previous: Option<(u64, f64)> = None;
    let mut ordered = true;
    let mut steps = 0_u32;
    for (code, bucket) in gears.iter_mut() {
        let p05 = bucket.quantile(0.05);
        let p50 = bucket.quantile(0.50);
        let p95 = bucket.quantile(0.95);
        let spread = match (p05, p95, p50) {
            (Some(low), Some(high), Some(mid)) if mid > 0.0 => format!("{:.3}", (high - low) / mid),
            _ => "-".into(),
        };
        println!(
            "  {:<8} {:>10} {:>10} {:>12} {:>12} {:>12} {:>10} {:>12} {:>20}",
            code,
            bucket.frames,
            bucket.ratios.len(),
            p05.map(|v| format!("{v:.6}")).unwrap_or_else(|| "-".into()),
            p50.map(|v| format!("{v:.6}")).unwrap_or_else(|| "-".into()),
            p95.map(|v| format!("{v:.6}")).unwrap_or_else(|| "-".into()),
            spread,
            match (bucket.min_speed, bucket.max_speed) {
                (Some(low), Some(high)) => format!("{low:.0}-{high:.0}"),
                _ => "-".into(),
            },
            format!("{}/{}", bucket.reversing, bucket.advancing),
        );
        // Only *consecutive* codes are compared. A gap in the code sequence
        // is not evidence of disorder: codes 1..8 stepping up in ratio says
        // nothing about a rare code 11 that may not be a gear at all.
        if *code >= 1 {
            if let Some(mid) = p50 {
                if let Some((previous_code, previous_mid)) = previous {
                    if *code == previous_code + 1 {
                        steps += 1;
                        if mid <= previous_mid {
                            ordered = false;
                        }
                    }
                }
                previous = Some((*code, mid));
            }
        }
    }
    println!(
        "  ratio medians across {steps} consecutive-code step(s) are {}",
        if steps == 0 {
            "untested (no consecutive codes)"
        } else if ordered {
            "STRICTLY INCREASING"
        } else {
            "NOT monotonic"
        }
    );
}
