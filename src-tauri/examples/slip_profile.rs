//! Distribution of the canonical slip channels across a recorded session.
//!
//! Slip thresholds are RaceLab heuristics, and a heuristic is only defensible
//! against a measured distribution. This reports what a session's slip channels
//! actually did, per corner, so a threshold decision can be argued from data
//! rather than from a remembered range.
//!
//! ```powershell
//! cargo run --release --manifest-path src-tauri/Cargo.toml --example slip_profile -- '<sessions>\<session-id>'
//! ```
//!
//! Read-only: it opens `frames.rlframes` and writes nothing.
use racelab_lib::{
    session_format::{FrameStreamReader, FRAME_FILE_NAME},
    telemetry::{WheelPosition, WHEEL_POSITIONS},
};
use std::{fs::File, io::BufReader, path::PathBuf};

/// Sorted samples for one channel. Bounded by the session length, which is the
/// point: this is an offline reporting tool, not the streaming analyzer.
#[derive(Default)]
struct Samples(Vec<f32>);

impl Samples {
    fn push(&mut self, value: f32) {
        if value.is_finite() {
            self.0.push(value);
        }
    }

    fn finish(&mut self) {
        self.0.sort_by(|a, b| a.total_cmp(b));
    }

    fn quantile(&self, fraction: f64) -> f32 {
        if self.0.is_empty() {
            return f32::NAN;
        }
        let index = ((self.0.len() - 1) as f64 * fraction).round() as usize;
        self.0[index]
    }

    /// Share of samples at or above `threshold`, which is exactly what a
    /// threshold means in practice: how much of the drive it selects.
    fn share_at_or_above(&self, threshold: f32) -> f64 {
        if self.0.is_empty() {
            return 0.0;
        }
        self.0.iter().filter(|value| **value >= threshold).count() as f64 / self.0.len() as f64
    }

    fn report(&self, label: &str) {
        println!(
            "{label:<28} n={:<6} p50={:<9.3} p75={:<9.3} p90={:<9.3} p99={:<9.3} max={:<9.3} \
             >=0.5:{:>6.1}% >=1:{:>6.1}% >=2:{:>6.1}% >=5:{:>6.1}% >=10:{:>6.1}%",
            self.0.len(),
            self.quantile(0.50),
            self.quantile(0.75),
            self.quantile(0.90),
            self.quantile(0.99),
            self.quantile(1.0),
            self.share_at_or_above(0.5) * 100.0,
            self.share_at_or_above(1.0) * 100.0,
            self.share_at_or_above(2.0) * 100.0,
            self.share_at_or_above(5.0) * 100.0,
            self.share_at_or_above(10.0) * 100.0,
        );
    }
}

fn corner_label(position: WheelPosition) -> &'static str {
    match position {
        WheelPosition::FrontLeft => "front_left",
        WheelPosition::FrontRight => "front_right",
        WheelPosition::RearLeft => "rear_left",
        WheelPosition::RearRight => "rear_right",
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Usage: slip_profile <session-directory>")?,
    );
    let mut reader =
        FrameStreamReader::new(BufReader::new(File::open(directory.join(FRAME_FILE_NAME))?))?;

    let mut ratio: [Samples; 4] = Default::default();
    let mut combined: [Samples; 4] = Default::default();
    let mut any_ratio = Samples::default();
    let mut any_combined = Samples::default();
    let mut active = 0_u64;
    // V0.8 established `combined_slip == hypot(slip_ratio, slip_angle)` to 9e-7
    // on its evidence car. Re-checking it here separates "this car really does
    // send huge slip values" from "the adapter is misreading these bytes".
    let mut hypot_residual = 0.0_f64;

    while let Some(record) = reader.next_frame()? {
        if !record.frame.active {
            continue;
        }
        active += 1;
        let mut frame_ratio = f32::NEG_INFINITY;
        let mut frame_combined = f32::NEG_INFINITY;
        for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
            let wheel = record.frame.wheels.get(position);
            if let Some(value) = wheel.slip_ratio {
                ratio[index].push(value.abs());
                frame_ratio = frame_ratio.max(value.abs());
            }
            if let Some(value) = wheel.combined_slip {
                combined[index].push(value);
                frame_combined = frame_combined.max(value);
            }
            if let (Some(ratio), Some(angle), Some(value)) =
                (wheel.slip_ratio, wheel.slip_angle, wheel.combined_slip)
            {
                let expected = f64::from(ratio).hypot(f64::from(angle));
                hypot_residual = hypot_residual.max((f64::from(value) - expected).abs());
            }
        }
        if frame_ratio.is_finite() {
            any_ratio.push(frame_ratio);
        }
        if frame_combined.is_finite() {
            any_combined.push(frame_combined);
        }
    }

    println!("session: {}", reader.header.session_id);
    println!(
        "telemetry frame schema: {}, active frames: {active}",
        reader.header.telemetry_frame_schema_version
    );
    println!();
    for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
        ratio[index].finish();
        ratio[index].report(&format!("|slip_ratio| {}", corner_label(position)));
    }
    any_ratio.finish();
    any_ratio.report("|slip_ratio| worst corner");
    println!();
    for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
        combined[index].finish();
        combined[index].report(&format!("combined_slip {}", corner_label(position)));
    }
    any_combined.finish();
    any_combined.report("combined_slip worst corner");
    println!();
    println!("max |combined_slip - hypot(slip_ratio, slip_angle)| = {hypot_residual:.3e}");
    Ok(())
}
