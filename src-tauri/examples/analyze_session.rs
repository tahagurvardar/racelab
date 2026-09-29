//! Run the V0.9 analyzer over a recorded session directory and report what it
//! found, without touching the app. Offline counterpart to `validate_fh6`.
//!
//! ```powershell
//! cargo run --release --manifest-path src-tauri/Cargo.toml --example analyze_session -- '<sessions>\<session-id>'
//! ```
//!
//! Reads `frames.rlframes`, writes nothing unless `--write` is passed, and
//! prints the timing and counters used for V0.9 validation.
use racelab_lib::{
    analysis::{self, AnalysisConfigV1},
    analysis_engine,
};
use std::{path::PathBuf, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let directory = PathBuf::from(
        arguments
            .next()
            .ok_or("Usage: analyze_session <session-directory> [--write]")?,
    );
    let write = arguments.any(|argument| argument == "--write");

    let started = Instant::now();
    let analysis =
        analysis_engine::analyze_session_directory(&directory, AnalysisConfigV1::default())?;
    let elapsed = started.elapsed();

    if write {
        analysis::write_analysis_atomically(&directory, &analysis)?;
    }

    let frames = analysis.data_quality.frames_read;
    let seconds = elapsed.as_secs_f64();
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "session_id": analysis.session_id,
            "telemetry_frame_schema_version": analysis.telemetry_frame_schema_version,
            "frames": frames,
            "active_frames": analysis.data_quality.active_frames,
            "inactive_frames": analysis.data_quality.inactive_frames,
            "zero_interval_frames": analysis.data_quality.zero_interval_frames,
            "speed_discontinuities": analysis.data_quality.speed_discontinuities,
            "recorded_seconds": analysis.coverage.recorded_seconds,
            "analyzed_seconds": analysis.coverage.analyzed_seconds,
            "excluded_gap_count": analysis.coverage.excluded_gap_count,
            "excluded_gap_seconds": analysis.coverage.excluded_gap_seconds,
            "inactive_interval_count": analysis.coverage.inactive_interval_count,
            "events": analysis.driving_summary.event_count,
            "events_by_kind": analysis.driving_summary.events_by_kind
                .iter()
                .map(|entry| (entry.kind.as_str(), entry.count))
                .collect::<std::collections::BTreeMap<_, _>>(),
            "events_truncated": analysis.data_quality.events_truncated,
            "slip_episodes": analysis.driving_summary.slip_episode_count,
            "slip_episodes_truncated": analysis.data_quality.slip_episodes_truncated,
            "slip_ratio_detector_events": analysis.data_quality.slip_ratio_detector_events,
            "combined_slip_detector_events": analysis.data_quality.combined_slip_detector_events,
            "analysis_duration_ms": analysis.analysis_duration_ms,
            "turn_segments": analysis.driving_summary.turn_segment_count,
            "wheel_telemetry_available": analysis.data_quality.wheel_telemetry_available,
            "orientation_available": analysis.data_quality.orientation_available,
            "frame_stream_complete": analysis.data_quality.frame_stream_complete,
            "max_speed_kmh": analysis.driving_summary.max_speed_mps.map(|v| f64::from(v) * 3.6),
            "max_acceleration_mps2": analysis.driving_summary.max_longitudinal_acceleration_mps2,
            "max_deceleration_mps2": analysis.driving_summary.max_longitudinal_deceleration_mps2,
            "analysis_wall_ms": elapsed.as_secs_f64() * 1000.0,
            "frames_per_second_analyzed": if seconds > 0.0 { frames as f64 / seconds } else { 0.0 },
            "analysis_json_bytes": serde_json::to_vec(&analysis)?.len(),
            "written": write,
        }))?
    );
    Ok(())
}
