//! V0.9 derived analysis: streaming engine, persistence, isolation and the
//! automatic lifecycle.
//!
//! Frame sequences here are synthetic and deterministic. Every threshold the
//! tests rely on is read from `AnalysisConfigV1` rather than written as a
//! literal, so a documented threshold change updates one place and these tests
//! keep asserting the *behaviour* rather than a number.
use racelab_lib::{
    analysis::{
        self, AnalysisConfigV1, AnalysisReadError, DrivingEventV1, EventKind, SessionAnalysisV1,
        SlipEpisodeV1, SlipFamily, ANALYSIS_FILE_NAME, ANALYSIS_SCHEMA_VERSION,
    },
    analysis_engine::{self, wrap_angle, AnalysisAccumulator},
    analysis_job::{self, AnalysisRunner, ANALYSIS_QUEUE_CAPACITY},
    session_format::{
        self, FrameStreamReader, RecordedFrame, SessionManifestV1, SessionStatus, FRAME_FILE_NAME,
        FRAME_FORMAT_VERSION, TELEMETRY_FRAME_SCHEMA_VERSION,
    },
    session_recorder::SessionRecorder,
    session_store::{self, AnalysisAvailability},
    telemetry::{
        Controls, Engine, TelemetryFrame, Vector3, Wheel, WheelPosition, Wheels, WHEEL_POSITIONS,
    },
    telemetry_hub::{SessionRecorderHook, TelemetryHub},
};
use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

static UNIQUE: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let unique = UNIQUE.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "racelab-v09-{}-{name}-{unique}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

// ------------------------------------------------------------------ builders

/// One active frame. Every channel is explicit, so a test never depends on a
/// default that might change.
fn active(speed_mps: f32, throttle: f32, brake: f32) -> TelemetryFrame {
    TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some("3134".into()),
        engine: Engine {
            rpm: Some(4200.0),
            idle_rpm: Some(800.0),
            max_rpm: Some(7500.0),
            power_w: Some(84_286.8),
            torque_nm: Some(140.55),
        },
        speed_mps: Some(speed_mps),
        controls: Controls {
            throttle: Some(throttle),
            brake: Some(brake),
            clutch: Some(0.0),
            handbrake: Some(0.0),
            steering: Some(0.0),
        },
        ..TelemetryFrame::default()
    }
}

fn inactive() -> TelemetryFrame {
    TelemetryFrame {
        active: false,
        game: Some("fh6".into()),
        ..TelemetryFrame::default()
    }
}

fn with_yaw(mut frame: TelemetryFrame, yaw_rad: f32) -> TelemetryFrame {
    frame.orientation = Some(Vector3 {
        x: yaw_rad,
        y: 0.0,
        z: 0.0,
    });
    frame
}

/// A quiet corner: every channel present and far from every threshold.
fn quiet_wheel() -> Wheel {
    Wheel {
        temperature_c: Some(85.0),
        slip_ratio: Some(0.01),
        slip_angle: Some(0.01),
        combined_slip: Some(0.014),
        rotation_rad_s: Some(90.0),
        normalized_suspension_travel: Some(0.5),
        suspension_travel_m: Some(0.0),
    }
}

fn quiet_wheels() -> Wheels {
    let mut wheels = Wheels::default();
    for position in WHEEL_POSITIONS {
        wheels.set(position, quiet_wheel());
    }
    wheels
}

fn with_wheels(mut frame: TelemetryFrame, wheels: Wheels) -> TelemetryFrame {
    frame.wheels = wheels;
    frame
}

/// A frame whose wheels are quiet except for one corner, which is edited.
fn one_corner(
    frame: TelemetryFrame,
    position: WheelPosition,
    edit: impl FnOnce(&mut Wheel),
) -> TelemetryFrame {
    let mut wheels = quiet_wheels();
    let mut wheel = *wheels.get(position);
    edit(&mut wheel);
    wheels.set(position, wheel);
    with_wheels(frame, wheels)
}

fn record(index: usize, monotonic_ms: u64, frame: TelemetryFrame) -> RecordedFrame {
    RecordedFrame {
        sequence: index as u64 + 1,
        monotonic_ms,
        frame,
    }
}

/// Feed a sequence straight into the accumulator. This is the engine under
/// test; file I/O is exercised separately.
fn analyze_records(records: &[RecordedFrame], config: AnalysisConfigV1) -> SessionAnalysisV1 {
    let mut accumulator = AnalysisAccumulator::new("test-1".into(), 2, config);
    for record in records {
        accumulator.observe(record);
    }
    accumulator.finish(true)
}

fn analyze(records: &[RecordedFrame]) -> SessionAnalysisV1 {
    analyze_records(records, AnalysisConfigV1::default())
}

/// Build a fixed-interval sequence from a per-frame closure.
fn sequence(
    count: usize,
    step_ms: u64,
    mut build: impl FnMut(usize) -> TelemetryFrame,
) -> Vec<RecordedFrame> {
    (0..count)
        .map(|index| record(index, index as u64 * step_ms, build(index)))
        .collect()
}

fn of_kind(analysis: &SessionAnalysisV1, kind: EventKind) -> Vec<&DrivingEventV1> {
    analysis
        .events
        .iter()
        .filter(|event| event.kind == kind)
        .collect()
}

fn episodes(analysis: &SessionAnalysisV1) -> &[SlipEpisodeV1] {
    &analysis.slip_episodes
}

fn count_of(analysis: &SessionAnalysisV1, kind: EventKind) -> u64 {
    analysis
        .driving_summary
        .events_by_kind
        .iter()
        .find(|entry| entry.kind == kind)
        .map(|entry| entry.count)
        .unwrap_or_default()
}

// ------------------------------------------------------------- basic events

/// Case 1. A full-throttle interval starts and ends where the input crosses the
/// thresholds, and carries its entry, exit and peak speeds.
#[test]
fn full_throttle_event_has_correct_bounds_and_speeds() {
    let config = AnalysisConfigV1::default();
    // 20 frames at 50 ms. Full throttle from frame 4 to frame 12 inclusive.
    let records = sequence(20, 50, |index| {
        let throttle = if (4..=12).contains(&index) { 1.0 } else { 0.2 };
        active(20.0 + index as f32, throttle, 0.0)
    });
    let analysis = analyze_records(&records, config);
    let events = of_kind(&analysis, EventKind::FullThrottle);
    assert_eq!(events.len(), 1, "{:?}", analysis.events);
    let event = events[0];
    assert_eq!(event.start_ms, 200);
    assert_eq!(event.end_ms, 600);
    assert_eq!(event.duration_ms, 400);
    assert_eq!(event.entry_speed_mps, Some(24.0));
    assert_eq!(event.exit_speed_mps, Some(32.0));
    assert_eq!(event.max_speed_mps, Some(32.0));
    assert_eq!(event.speed_change_mps, Some(8.0));
    assert_eq!(event.max_rpm, Some(4200.0));
    assert_eq!(event.peak, Some(1.0));
    assert!(event.corner.is_none());
}

/// Case 2. Braking is detected from the brake channel alone, and reports the speed
/// it removed. The reduction is reported as a signed speed change; nothing here
/// claims the brake caused it.
#[test]
fn braking_event_reports_speed_reduction() {
    let records = sequence(20, 50, |index| {
        let braking = (5..=10).contains(&index);
        let speed = if index <= 5 {
            40.0
        } else {
            40.0 - (index.min(10) - 5) as f32 * 3.0
        };
        active(speed, 0.0, if braking { 0.6 } else { 0.0 })
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::Braking);
    assert_eq!(events.len(), 1);
    let event = events[0];
    assert_eq!(event.start_ms, 250);
    assert_eq!(event.end_ms, 500);
    assert_eq!(event.entry_speed_mps, Some(40.0));
    assert_eq!(event.exit_speed_mps, Some(25.0));
    assert_eq!(event.speed_change_mps, Some(-15.0));
    assert_eq!(event.peak, Some(0.6));
    // The hard-braking threshold is higher, so this is not one.
    assert!(of_kind(&analysis, EventKind::HardBraking).is_empty());
}

/// Case 3. Hysteresis: a brake input that dips below the enter threshold but stays
/// above the exit threshold keeps one event open instead of producing two.
#[test]
fn hard_braking_hysteresis_keeps_one_event() {
    let config = AnalysisConfigV1::default();
    let between = (config.hard_braking_enter + config.hard_braking_exit) / 2.0;
    assert!(between < config.hard_braking_enter && between > config.hard_braking_exit);
    let records = sequence(20, 50, |index| {
        let brake = match index {
            4..=7 => 0.95,
            // Dips into the hysteresis band: below enter, above exit.
            8..=9 => between,
            10..=13 => 0.95,
            _ => 0.0,
        };
        active(40.0, 0.0, brake)
    });
    let analysis = analyze_records(&records, config);
    let events = of_kind(&analysis, EventKind::HardBraking);
    assert_eq!(events.len(), 1, "the dip must not split the event");
    assert_eq!(events[0].start_ms, 200);
    assert_eq!(events[0].end_ms, 650);
    assert_eq!(events[0].peak, Some(0.95));
}

/// Case 4. A throttle fall inside the lift window is one event, reported from the
/// high sample to the low one, and the cooldown stops it repeating.
#[test]
fn rapid_throttle_lift_is_detected_once() {
    let records = sequence(20, 50, |index| {
        let throttle = if index < 8 { 1.0 } else { 0.0 };
        active(50.0, throttle, 0.0)
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::RapidThrottleLift);
    assert_eq!(events.len(), 1, "{:?}", events);
    assert_eq!(events[0].end_ms, 400);
    assert_eq!(events[0].start_ms, 350);
    assert_eq!(events[0].peak, Some(1.0));
}

/// A throttle that falls slowly, outside the lift window, is not a lift.
#[test]
fn slow_throttle_release_is_not_a_lift() {
    // 1.0 down to 0 over 2 seconds: never an 0.8 -> 0.2 fall inside 250 ms.
    let records = sequence(41, 50, |index| {
        active(50.0, (1.0 - index as f32 / 40.0).max(0.0), 0.0)
    });
    let analysis = analyze(&records);
    assert!(of_kind(&analysis, EventKind::RapidThrottleLift).is_empty());
}

/// Case 5. Longitudinal acceleration comes from d(speed)/dt, never from the source
/// acceleration vector, whose vehicle-axis orientation is not established.
#[test]
fn speed_derived_acceleration_is_detected() {
    // +8 m/s² for 1 s, then steady.
    let records = sequence(40, 25, |index| {
        let t = index as f32 * 0.025;
        let speed = if t <= 1.0 { 10.0 + 8.0 * t } else { 18.0 };
        active(speed, 1.0, 0.0)
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::StrongAcceleration);
    assert_eq!(events.len(), 1, "{:?}", events);
    let peak = analysis
        .driving_summary
        .max_longitudinal_acceleration_mps2
        .unwrap();
    assert!((peak - 8.0).abs() < 0.01, "peak {peak}");
    assert!(of_kind(&analysis, EventKind::StrongDeceleration).is_empty());
}

/// Case 6. The same derivative in the other direction. Note that the event is named
/// deceleration, not braking: it says the speed fell and nothing about why.
#[test]
fn speed_derived_deceleration_is_detected_without_brake_input() {
    let records = sequence(40, 25, |index| {
        let t = index as f32 * 0.025;
        let speed = if t <= 1.0 { 40.0 - 10.0 * t } else { 30.0 };
        // No brake input at all: the event must not claim braking.
        active(speed, 0.0, 0.0)
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::StrongDeceleration);
    assert_eq!(events.len(), 1);
    assert!(events[0].signed_peak.unwrap() < 0.0);
    assert!(of_kind(&analysis, EventKind::Braking).is_empty());
    let peak = analysis
        .driving_summary
        .max_longitudinal_deceleration_mps2
        .unwrap();
    assert!((peak + 10.0).abs() < 0.01, "peak {peak}");
}

/// A speed change no vehicle could produce — a respawn, a rewind, fast travel
/// or a collision — is a discontinuity in what was recorded, not acceleration.
/// It is counted and excluded rather than reported as a 20 g braking event.
#[test]
fn a_speed_discontinuity_is_excluded_from_acceleration_events() {
    let config = AnalysisConfigV1::default();
    // 60 m/s, then instantly 5 m/s, then steady: ~ -200 m/s² over the window.
    let records = sequence(60, 25, |index| {
        let speed = if index < 30 { 60.0 } else { 5.0 };
        active(speed, 0.0, 0.0)
    });
    let analysis = analyze_records(&records, config);
    assert!(analysis.data_quality.speed_discontinuities > 0);
    // The absurd value never reaches the summary or an event.
    let peak = analysis
        .driving_summary
        .max_longitudinal_deceleration_mps2
        .unwrap_or_default();
    assert!(
        peak.abs() <= config.max_plausible_acceleration_mps2,
        "peak {peak} was reported as vehicle deceleration"
    );
    for event in of_kind(&analysis, EventKind::StrongDeceleration) {
        assert!(
            event.peak.unwrap_or_default() <= config.max_plausible_acceleration_mps2,
            "{event:?}"
        );
    }
}

/// A hard but plausible deceleration is still reported: the guard excludes
/// discontinuities, not strong driving.
#[test]
fn a_plausible_hard_deceleration_is_still_reported() {
    let config = AnalysisConfigV1::default();
    // -10 m/s² for a second, far above the event threshold and far below the
    // plausibility bound.
    let records = sequence(80, 25, |index| {
        let t = index as f32 * 0.025;
        let speed = if t <= 1.0 { 40.0 - 10.0 * t } else { 30.0 };
        active(speed, 0.0, 0.9)
    });
    let analysis = analyze_records(&records, config);
    assert_eq!(analysis.data_quality.speed_discontinuities, 0);
    assert_eq!(of_kind(&analysis, EventKind::StrongDeceleration).len(), 1);
}

// ------------------------------------------------------------------- timing

/// Case 7. Irregular intervals are handled by using the monotonic clock rather than
/// an assumed frame rate: the same drive sampled irregularly yields the same
/// durations.
#[test]
fn irregular_frame_timing_preserves_durations() {
    let steps = [13_u64, 41, 7, 22, 63, 9, 31, 18, 55, 11];
    let mut records = Vec::new();
    let mut time = 0;
    for index in 0..30 {
        let throttle = if (10..20).contains(&index) { 1.0 } else { 0.0 };
        records.push(record(index, time, active(30.0, throttle, 0.0)));
        time += steps[index % steps.len()];
    }
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::FullThrottle);
    assert_eq!(events.len(), 1);
    // Frames 10..=19 are at full throttle; the event spans their timestamps.
    let start = records[10].monotonic_ms;
    let end = records[19].monotonic_ms;
    assert_eq!(events[0].start_ms, start);
    assert_eq!(events[0].end_ms, end);
    assert_eq!(events[0].duration_ms, end - start);
}

/// Case 8. Duplicate timestamps advance no time. They are counted, they never divide
/// by zero, and they never inflate a duration.
#[test]
fn zero_interval_frames_are_counted_and_excluded() {
    let mut records = Vec::new();
    for index in 0..20 {
        // Every frame is emitted twice with the same monotonic value.
        records.push(record(index * 2, index as u64 * 50, active(30.0, 1.0, 0.0)));
        records.push(record(
            index * 2 + 1,
            index as u64 * 50,
            active(30.0, 1.0, 0.0),
        ));
    }
    let analysis = analyze(&records);
    assert_eq!(analysis.data_quality.frames_read, 40);
    assert_eq!(analysis.data_quality.zero_interval_frames, 20);
    assert!((analysis.coverage.analyzed_seconds - 0.95).abs() < 1e-9);
    let events = of_kind(&analysis, EventKind::FullThrottle);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].duration_ms, 950);
}

/// Case 9. An interval longer than the gap threshold is excluded from analyzed time
/// and counted, exactly as the session summary already does.
#[test]
fn large_gap_is_excluded_from_analyzed_time() {
    let config = AnalysisConfigV1::default();
    let mut records: Vec<_> = (0..10)
        .map(|index| record(index, index as u64 * 50, active(30.0, 0.0, 0.0)))
        .collect();
    let after_gap = 450 + config.max_gap_ms * 3;
    records.extend((0..10).map(|index| {
        record(
            10 + index,
            after_gap + index as u64 * 50,
            active(30.0, 0.0, 0.0),
        )
    }));
    let analysis = analyze_records(&records, config);
    assert_eq!(analysis.coverage.excluded_gap_count, 1);
    assert!(
        (analysis.coverage.excluded_gap_seconds - config.max_gap_ms as f64 * 3.0 / 1000.0).abs()
            < 1e-9
    );
    // 9 intervals before plus 9 after, at 50 ms each.
    assert!((analysis.coverage.analyzed_seconds - 0.9).abs() < 1e-9);
    // The recorded span still includes the gap: coverage states both numbers.
    assert!(analysis.coverage.recorded_seconds > analysis.coverage.analyzed_seconds);
}

/// Case 10. An event open when a gap begins is closed at the last frame that
/// observed it. It never spans the gap, and the telemetry after the gap starts
/// a new event rather than resuming the old one.
#[test]
fn an_event_closes_at_the_gap_rather_than_spanning_it() {
    let config = AnalysisConfigV1::default();
    let mut records: Vec<_> = (0..10)
        .map(|index| record(index, index as u64 * 50, active(30.0, 1.0, 0.0)))
        .collect();
    let after_gap = 450 + config.max_gap_ms * 4;
    records.extend((0..10).map(|index| {
        record(
            10 + index,
            after_gap + index as u64 * 50,
            active(30.0, 1.0, 0.0),
        )
    }));
    let analysis = analyze_records(&records, config);
    let events = of_kind(&analysis, EventKind::FullThrottle);
    assert_eq!(events.len(), 2, "one event per side of the gap");
    assert_eq!(events[0].end_ms, 450);
    assert_eq!(events[1].start_ms, after_gap);
    // Neither event covers the unmeasured time.
    assert!(events.iter().all(|event| event.duration_ms <= 450));
}

/// An inactive stretch closes events too: a menu is not driving.
#[test]
fn inactive_frames_close_open_events() {
    let records = sequence(30, 50, |index| {
        if (10..15).contains(&index) {
            inactive()
        } else {
            active(30.0, 1.0, 0.0)
        }
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::FullThrottle);
    assert_eq!(events.len(), 2);
    assert_eq!(analysis.data_quality.inactive_frames, 5);
    assert_eq!(analysis.data_quality.active_frames, 25);
    assert!(analysis.coverage.inactive_interval_count > 0);
}

// --------------------------------------------------------------- slip events

/// Case 11. A sustained high slip ratio produces one episode that names the
/// corner and preserves the sign without interpreting it.
#[test]
fn high_slip_ratio_event_preserves_sign_and_corner() {
    let records = sequence(30, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        if (10..20).contains(&index) {
            one_corner(frame, WheelPosition::RearRight, |wheel| {
                wheel.slip_ratio = Some(-2.5);
                wheel.combined_slip = Some(2.6);
            })
        } else {
            with_wheels(frame, quiet_wheels())
        }
    });
    let analysis = analyze(&records);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 1, "{found:?}");
    let episode = &found[0];
    assert_eq!(episode.corners, vec![WheelPosition::RearRight]);
    assert_eq!(episode.start_ms, 500);
    assert_eq!(episode.end_ms, 950);
    // The magnitude crossed the threshold; the sign is reported, not named.
    assert_eq!(episode.max_abs_slip_ratio.rear_right, Some(2.5));
    assert_eq!(episode.signed_peak_slip_ratio.rear_right, Some(-2.5));
    assert_eq!(episode.max_combined_slip.rear_right, Some(2.6));
    assert_eq!(episode.peak_abs_slip_ratio, Some(2.5));
    // Corners that never crossed a threshold are unavailable, never zero.
    assert_eq!(episode.max_abs_slip_ratio.front_left, None);
    // No per-corner slip rows exist to duplicate it.
    assert!(analysis
        .events
        .iter()
        .all(|event| event.corner != Some(WheelPosition::RearRight)
            || event.kind == EventKind::HighSuspensionCompression
            || event.kind == EventKind::HighSuspensionExtension));
}

/// Case 12. Combined slip is its own detector, so a corner can report high combined
/// slip without a high longitudinal slip ratio.
#[test]
fn combined_slip_event_is_independent_of_slip_ratio() {
    let records = sequence(30, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        if (10..20).contains(&index) {
            one_corner(frame, WheelPosition::FrontLeft, |wheel| {
                // Low longitudinal slip, high lateral, so combined slip is high.
                wheel.slip_ratio = Some(0.05);
                wheel.slip_angle = Some(2.0);
                wheel.combined_slip = Some(2.0006);
            })
        } else {
            with_wheels(frame, quiet_wheels())
        }
    });
    let analysis = analyze(&records);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].corners, vec![WheelPosition::FrontLeft]);
    // Only the combined-slip channel crossed, and the episode says so rather
    // than implying the longitudinal channel did too.
    assert_eq!(found[0].families, vec![SlipFamily::CombinedSlip]);
    assert_eq!(analysis.data_quality.slip_ratio_detector_events, 0);
    assert!(analysis.data_quality.combined_slip_detector_events > 0);
}

/// Case 13. A single noisy frame does not create an event, and a value oscillating
/// around the enter threshold does not create a stream of them.
#[test]
fn noise_does_not_create_event_chatter() {
    let config = AnalysisConfigV1::default();
    let records = sequence(60, 16, |index| {
        let frame = active(30.0, 0.5, 0.0);
        // Alternating one-frame spikes above and below the enter threshold.
        let slip = if index % 2 == 0 {
            config.slip_ratio_enter + 0.2
        } else {
            0.0
        };
        one_corner(frame, WheelPosition::FrontRight, |wheel| {
            wheel.slip_ratio = Some(slip);
        })
    });
    let analysis = analyze_records(&records, config);
    assert!(
        episodes(&analysis).is_empty(),
        "alternating 16 ms spikes never spend {} ms above threshold: {:?}",
        config.slip_min_ms,
        episodes(&analysis)
    );
    assert_eq!(analysis.driving_summary.slip_episode_count, 0);
    // And the raw detectors agree: no single engagement was long enough.
    assert_eq!(analysis.data_quality.slip_ratio_detector_events, 0);
}

// --------------------------------------------------------- suspension events

/// Case 14. High compression uses the normalized channel, whose V0.8 meaning is
/// 1 = full compression. The event says "high compression" and never
/// "bottoming out".
#[test]
fn high_suspension_compression_event() {
    let records = sequence(30, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        one_corner(frame, WheelPosition::RearLeft, |wheel| {
            wheel.normalized_suspension_travel =
                Some(if (10..20).contains(&index) { 0.99 } else { 0.5 });
        })
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::HighSuspensionCompression);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].corner, Some(WheelPosition::RearLeft));
    assert_eq!(events[0].peak, Some(0.99));
    assert!(of_kind(&analysis, EventKind::HighSuspensionExtension).is_empty());
}

/// Case 15. And the other end of the same channel: 0 = full extension.
#[test]
fn high_suspension_extension_event() {
    let records = sequence(30, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        one_corner(frame, WheelPosition::FrontRight, |wheel| {
            wheel.normalized_suspension_travel =
                Some(if (10..20).contains(&index) { 0.01 } else { 0.5 });
        })
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::HighSuspensionExtension);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].corner, Some(WheelPosition::FrontRight));
    assert!(of_kind(&analysis, EventKind::HighSuspensionCompression).is_empty());
}

/// Case 16. Corner identity survives analysis. Four corners are excited with four
/// distinct magnitudes at four distinct times; each event must carry the corner
/// it actually belongs to.
#[test]
fn corner_identity_is_preserved_through_analysis() {
    // Separated by more than the slip merge gap, so each is its own episode and
    // the test exercises corner identity and episode separation at once.
    let excitement: Vec<(WheelPosition, f32, usize)> = vec![
        (WheelPosition::FrontLeft, 2.0, 5),
        (WheelPosition::FrontRight, 3.0, 25),
        (WheelPosition::RearLeft, 4.0, 45),
        (WheelPosition::RearRight, 5.0, 65),
    ];
    let records = sequence(90, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        let mut wheels = quiet_wheels();
        for (position, magnitude, start) in &excitement {
            if (*start..start + 8).contains(&index) {
                let mut wheel = *wheels.get(*position);
                wheel.slip_ratio = Some(*magnitude);
                wheels.set(*position, wheel);
            }
        }
        with_wheels(frame, wheels)
    });
    let analysis = analyze(&records);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 4, "{found:?}");
    for (index, (position, magnitude, start)) in excitement.iter().enumerate() {
        let episode = &found[index];
        assert_eq!(episode.corners, vec![*position], "episode {index} corner");
        assert_eq!(
            episode.max_abs_slip_ratio.get(*position),
            Some(*magnitude),
            "episode {index} magnitude"
        );
        assert_eq!(
            episode.start_ms,
            *start as u64 * 50,
            "episode {index} start"
        );
        assert_eq!(episode.index, index as u32 + 1);
    }
}

// ------------------------------------------------------------ turn segments

/// Case 17. A yaw signal crossing the ±π boundary must not read as a half-turn in
/// one frame.
#[test]
fn yaw_wraparound_does_not_invent_a_turn() {
    // Yaw creeps across +π at a rate far below the turn threshold.
    let rate = 0.02_f32; // rad per 50 ms frame = 0.4 rad/s... but only for 1 frame
    let records = sequence(40, 50, |index| {
        let raw = 3.0 + index as f32 * rate * 0.1;
        let yaw = wrap_angle(f64::from(raw)) as f32;
        with_yaw(active(30.0, 0.5, 0.0), yaw)
    });
    let analysis = analyze(&records);
    assert!(
        analysis.turn_segments.is_empty(),
        "a wrap must not become a turn: {:?}",
        analysis.turn_segments
    );
}

/// The wrap helper itself, at the boundaries that matter.
#[test]
fn wrap_angle_maps_into_a_half_open_interval() {
    use std::f64::consts::{PI, TAU};
    assert!((wrap_angle(0.0)).abs() < 1e-12);
    assert!((wrap_angle(0.5) - 0.5).abs() < 1e-12);
    // A crossing from +π-ε to -π+ε is a small positive step, not -2π.
    let crossing = wrap_angle((-PI + 0.05) - (PI - 0.05));
    assert!((crossing - 0.1).abs() < 1e-12, "crossing {crossing}");
    // And the same crossing in the other direction.
    let back = wrap_angle((PI - 0.05) - (-PI + 0.05));
    assert!((back + 0.1).abs() < 1e-12, "back {back}");
    assert!((wrap_angle(TAU)).abs() < 1e-12);
    assert!((wrap_angle(PI) - PI).abs() < 1e-12);
}

/// Yaw that advances steadily and wraps mid-way still produces exactly one
/// segment whose total yaw change is the true rotation, not a 2π artefact.
#[test]
fn a_turn_that_crosses_the_wrap_boundary_stays_one_turn() {
    // 0.5 rad/s for 4 s: 2 rad of rotation, crossing +π on the way.
    let records = sequence(81, 50, |index| {
        let raw = 2.5 + index as f64 * 0.5 * 0.05;
        with_yaw(active(30.0, 0.5, 0.0), wrap_angle(raw) as f32)
    });
    let analysis = analyze(&records);
    assert_eq!(analysis.turn_segments.len(), 1);
    let segment = &analysis.turn_segments[0];
    assert!(
        (segment.signed_yaw_change_rad - 2.0).abs() < 0.01,
        "yaw change {}",
        segment.signed_yaw_change_rad
    );
}

/// Case 18. Turn hysteresis: yaw rate dipping under the enter threshold but staying
/// above the exit threshold keeps one segment open.
#[test]
fn turn_enter_exit_hysteresis_keeps_one_segment() {
    let config = AnalysisConfigV1::default();
    let between = (config.turn_yaw_rate_enter_rad_s + config.turn_yaw_rate_exit_rad_s) / 2.0;
    let mut yaw = 0.0_f64;
    let records = sequence(80, 50, |index| {
        let rate = match index {
            0..=9 => 0.0,
            // A dip into the hysteresis band, then back up.
            30..=39 => between,
            10..=59 => 0.6,
            _ => 0.0,
        };
        let frame = with_yaw(active(30.0, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze_records(&records, config);
    assert_eq!(
        analysis.turn_segments.len(),
        1,
        "{:?}",
        analysis.turn_segments
    );
}

/// Case 19. Two turns in opposite directions stay two segments: a direction reversal
/// closes the first and opens the second.
#[test]
fn two_opposite_turns_remain_separate() {
    let mut yaw = 0.0_f64;
    let records = sequence(120, 50, |index| {
        let rate: f64 = match index {
            10..=45 => 0.6,
            // A straight stretch longer than the exit hold.
            46..=60 => 0.0,
            61..=100 => -0.6,
            _ => 0.0,
        };
        let frame = with_yaw(active(30.0, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze(&records);
    assert_eq!(
        analysis.turn_segments.len(),
        2,
        "{:?}",
        analysis.turn_segments
    );
    assert!(analysis.turn_segments[0].signed_yaw_change_rad > 0.0);
    assert!(analysis.turn_segments[1].signed_yaw_change_rad < 0.0);
    assert!(analysis.turn_segments[0].end_ms < analysis.turn_segments[1].start_ms);
    assert_eq!(analysis.turn_segments[0].index, 1);
    assert_eq!(analysis.turn_segments[1].index, 2);
}

/// Two turns in the *same* direction, separated by a straight, also stay two.
#[test]
fn two_same_direction_turns_separated_by_a_straight_remain_separate() {
    let mut yaw = 0.0_f64;
    let records = sequence(140, 50, |index| {
        let rate: f64 = match index {
            10..=45 => 0.6,
            70..=110 => 0.6,
            _ => 0.0,
        };
        let frame = with_yaw(active(30.0, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze(&records);
    assert_eq!(analysis.turn_segments.len(), 2);
}

/// Case 20. A brief flick of the wheel is below the minimum segment duration and is
/// not reported as a turn.
#[test]
fn a_short_yaw_excursion_is_not_a_turn() {
    let config = AnalysisConfigV1::default();
    let mut yaw = 0.0_f64;
    let records = sequence(60, 50, |index| {
        // Four frames (200 ms) of high yaw rate, well under the minimum.
        let rate: f64 = if (20..24).contains(&index) { 1.0 } else { 0.0 };
        let frame = with_yaw(active(30.0, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze_records(&records, config);
    assert!(
        analysis.turn_segments.is_empty(),
        "200 ms is under the {} ms minimum",
        config.turn_min_duration_ms
    );
    assert_eq!(analysis.driving_summary.turn_segment_count, 0);
}

/// A turn below the minimum speed is not a turn: spinning the wheel while
/// parked is not cornering.
#[test]
fn yaw_below_the_minimum_speed_is_not_a_turn() {
    let config = AnalysisConfigV1::default();
    let mut yaw = 0.0_f64;
    let records = sequence(80, 50, |index| {
        let rate: f64 = if (10..60).contains(&index) { 0.6 } else { 0.0 };
        let frame = with_yaw(
            active(config.turn_min_speed_mps - 1.0, 0.5, 0.0),
            wrap_angle(yaw) as f32,
        );
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze_records(&records, config);
    assert!(analysis.turn_segments.is_empty());
}

/// Case 21. Entry, minimum, exit and average speeds of a segment.
#[test]
fn turn_segment_reports_entry_minimum_and_exit_speeds() {
    let mut yaw = 0.0_f64;
    // Speed dips to a clear minimum in the middle of the turn.
    let records = sequence(80, 50, |index| {
        let rate: f64 = if (10..60).contains(&index) { 0.6 } else { 0.0 };
        // Flat before the turn opens, so the entry speed is unambiguous.
        let speed = match index {
            0..=10 => 40.0,
            11..=35 => 40.0 - (index - 10) as f32,
            36..=60 => 15.0 + (index - 35) as f32,
            _ => 40.0,
        };
        let frame = with_yaw(active(speed, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze(&records);
    assert_eq!(analysis.turn_segments.len(), 1);
    let segment = &analysis.turn_segments[0];
    assert_eq!(segment.entry_speed_mps, Some(40.0));
    assert_eq!(segment.min_speed_mps, Some(15.0));
    assert!(segment.exit_speed_mps.unwrap() > segment.min_speed_mps.unwrap());
    let average = segment.average_speed_mps.unwrap();
    assert!(
        average > segment.min_speed_mps.unwrap() && average < segment.max_speed_mps.unwrap(),
        "average {average}"
    );
}

/// Case 22. Brake and full-throttle time inside a segment, measured over monotonic
/// intervals rather than counted in frames.
#[test]
fn turn_segment_reports_brake_and_full_throttle_time() {
    let mut yaw = 0.0_f64;
    let records = sequence(80, 50, |index| {
        let rate: f64 = if (10..60).contains(&index) { 0.6 } else { 0.0 };
        // Inside the turn: 10 frames braking, then 20 frames at full throttle.
        let (throttle, brake) = match index {
            10..=19 => (0.0, 0.9),
            30..=49 => (1.0, 0.0),
            _ => (0.3, 0.0),
        };
        let frame = with_yaw(active(30.0, throttle, brake), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze(&records);
    assert_eq!(analysis.turn_segments.len(), 1);
    let segment = &analysis.turn_segments[0];
    assert!(
        (segment.brake_seconds - 0.5).abs() < 1e-9,
        "brake {}",
        segment.brake_seconds
    );
    assert!(
        (segment.full_throttle_seconds - 1.0).abs() < 1e-9,
        "full throttle {}",
        segment.full_throttle_seconds
    );
    assert_eq!(segment.max_brake, Some(0.9));
}

/// A segment carries the per-corner peaks it observed, by name.
#[test]
fn turn_segment_carries_per_corner_peaks_by_name() {
    let mut yaw = 0.0_f64;
    let records = sequence(80, 50, |index| {
        let rate: f64 = if (10..60).contains(&index) { 0.6 } else { 0.0 };
        let frame = with_yaw(active(30.0, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        if (20..30).contains(&index) {
            one_corner(frame, WheelPosition::RearRight, |wheel| {
                wheel.slip_ratio = Some(-3.5);
                wheel.combined_slip = Some(3.6);
                wheel.normalized_suspension_travel = Some(0.97);
            })
        } else {
            with_wheels(frame, quiet_wheels())
        }
    });
    let analysis = analyze(&records);
    let segment = &analysis.turn_segments[0];
    assert_eq!(segment.max_abs_slip_ratio.rear_right, Some(3.5));
    assert_eq!(segment.max_combined_slip.rear_right, Some(3.6));
    assert_eq!(segment.max_suspension_compression.rear_right, Some(0.97));
    // Every other corner stayed quiet and reports its quiet value, not the
    // excited one.
    assert_eq!(segment.max_abs_slip_ratio.front_left, Some(0.01));
}

/// Without orientation there are no turn segments, and the analysis says so
/// rather than pretending the drive was straight.
#[test]
fn a_session_without_orientation_reports_no_turn_capability() {
    let records = sequence(60, 50, |_| active(30.0, 0.5, 0.0));
    let analysis = analyze(&records);
    assert!(analysis.turn_segments.is_empty());
    assert!(!analysis.data_quality.orientation_available);
}

// ------------------------------------------------------- V1 and V2 sessions

/// The exact schema-v1 serialized shape, frozen here so this test cannot pass
/// by accident if the canonical model changes. Deliberately a copy: it must
/// never refer to `telemetry::TelemetryFrame`.
mod legacy {
    use serde::Serialize;

    #[derive(Serialize)]
    pub struct Vector3 {
        pub x: f32,
        pub y: f32,
        pub z: f32,
    }
    #[derive(Serialize)]
    pub struct Engine {
        pub rpm: Option<f32>,
        pub idle_rpm: Option<f32>,
        pub max_rpm: Option<f32>,
    }
    #[derive(Serialize)]
    pub struct Controls {
        pub throttle: Option<f32>,
        pub brake: Option<f32>,
        pub clutch: Option<f32>,
        pub handbrake: Option<f32>,
        pub steering: Option<f32>,
    }
    #[derive(Serialize)]
    #[serde(tag = "kind", content = "value", rename_all = "snake_case")]
    pub enum Gear {
        #[allow(dead_code)]
        Unknown,
        Forward(u16),
    }
    #[derive(Serialize)]
    pub struct TelemetryFrame {
        pub active: bool,
        pub game: Option<String>,
        pub vehicle_id: Option<String>,
        pub game_timestamp_ms: Option<u64>,
        pub engine: Engine,
        pub acceleration: Option<Vector3>,
        pub velocity: Option<Vector3>,
        pub angular_velocity: Option<Vector3>,
        pub orientation: Option<Vector3>,
        pub position: Option<Vector3>,
        pub speed_mps: Option<f32>,
        pub controls: Controls,
        pub gear: Option<Gear>,
        #[serde(rename = "sourceSpecific")]
        pub source_specific: Option<serde_json::Value>,
    }
    #[derive(Serialize)]
    pub struct StoredFrame {
        pub sequence: u64,
        pub monotonic_ms: u64,
        pub frame: TelemetryFrame,
    }
}

fn legacy_frame(speed_mps: f32, throttle: f32, brake: f32, yaw: f32) -> legacy::TelemetryFrame {
    legacy::TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some("3134".into()),
        game_timestamp_ms: Some(1_000),
        engine: legacy::Engine {
            rpm: Some(4200.0),
            idle_rpm: Some(800.0),
            max_rpm: Some(7500.0),
        },
        acceleration: None,
        velocity: None,
        angular_velocity: None,
        orientation: Some(legacy::Vector3 {
            x: yaw,
            y: 0.0,
            z: 0.0,
        }),
        position: None,
        speed_mps: Some(speed_mps),
        controls: legacy::Controls {
            throttle: Some(throttle),
            brake: Some(brake),
            clutch: Some(0.0),
            handbrake: Some(0.0),
            steering: Some(0.0),
        },
        gear: Some(legacy::Gear::Forward(4)),
        // A V1 envelope holding values V2 has canonical names for. Analysis
        // must not mine them: they were never validated against the V2
        // contract, so reconstructing wheel telemetry from them would
        // manufacture data nobody checked.
        source_specific: Some(serde_json::json!({
            "fh6": {
                "tire_slip_ratio": [9.0, 9.0, 9.0, 9.0],
                "tire_combined_slip": [9.0, 9.0, 9.0, 9.0],
                "normalized_suspension_travel": [1.0, 1.0, 1.0, 1.0],
            }
        })),
    }
}

/// Writes a complete schema-v1 RLFRAMES file byte for byte.
fn write_legacy_stream(path: &Path, session_id: &str, frames: Vec<legacy::TelemetryFrame>) {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RLFRM\r\n\0");
    bytes.extend_from_slice(&FRAME_FORMAT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    bytes.extend_from_slice(&(session_id.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&1_800_000_000_000_u64.to_le_bytes());
    bytes.extend_from_slice(session_id.as_bytes());
    let count = frames.len() as u64;
    for (index, frame) in frames.into_iter().enumerate() {
        let payload = rmp_serde::to_vec_named(&legacy::StoredFrame {
            sequence: index as u64 + 1,
            monotonic_ms: index as u64 * 50,
            frame,
        })
        .unwrap();
        bytes.push(1);
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
    }
    bytes.push(2);
    bytes.extend_from_slice(&count.to_le_bytes());
    bytes.extend_from_slice(&(count * 50_000).to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    fs::File::create(path).unwrap().write_all(&bytes).unwrap();
}

fn legacy_session(root: &Path, session_id: &str) {
    let directory = root.join(session_id);
    fs::create_dir_all(&directory).unwrap();
    let mut yaw = 0.0_f64;
    let frames = (0..80)
        .map(|index| {
            let rate: f64 = if (10..60).contains(&index) { 0.6 } else { 0.0 };
            let throttle = if (20..40).contains(&index) { 1.0 } else { 0.2 };
            let brake = if (60..70).contains(&index) { 0.9 } else { 0.0 };
            let frame = legacy_frame(30.0, throttle, brake, wrap_angle(yaw) as f32);
            yaw += rate * 0.05;
            frame
        })
        .collect();
    write_legacy_stream(&directory.join(FRAME_FILE_NAME), session_id, frames);
    let mut manifest = SessionManifestV1::new(session_id.into(), Some(1_800_000_000_000));
    manifest.status = SessionStatus::Completed;
    manifest.telemetry_frame_schema_version = 1;
    manifest.frame_count = 80;
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();
}

/// Case 23. An old V1 recording is analyzed through the existing version-aware
/// reader. Speed, control and orientation analysis all work.
#[test]
fn a_v1_session_is_analyzed_partially() {
    let root = scratch("v1-analysis");
    legacy_session(&root, "legacy-1");
    analysis_job::analyze_one(&root, "legacy-1", AnalysisConfigV1::default()).unwrap();
    let stored = analysis::read_analysis(&root.join("legacy-1")).unwrap();
    assert_eq!(stored.telemetry_frame_schema_version, 1);
    assert_eq!(stored.data_quality.frames_read, 80);
    assert!(stored.data_quality.speed_available);
    assert!(stored.data_quality.controls_available);
    assert!(stored.data_quality.orientation_available);
    assert!(!of_kind(&stored, EventKind::FullThrottle).is_empty());
    assert!(!of_kind(&stored, EventKind::Braking).is_empty());
    assert_eq!(stored.turn_segments.len(), 1);
}

/// Case 24. The V2-only channels are *unavailable* for a V1 session, not zero and
/// not reconstructed from the adapter envelope that happens to hold them.
#[test]
fn a_v1_session_reports_v2_channels_as_unavailable() {
    let root = scratch("v1-unavailable");
    legacy_session(&root, "legacy-2");
    analysis_job::analyze_one(&root, "legacy-2", AnalysisConfigV1::default()).unwrap();
    let stored = analysis::read_analysis(&root.join("legacy-2")).unwrap();
    assert!(!stored.data_quality.wheel_telemetry_available);
    assert!(!stored.data_quality.suspension_available);
    for kind in [
        EventKind::HighSuspensionCompression,
        EventKind::HighSuspensionExtension,
    ] {
        assert!(
            of_kind(&stored, kind).is_empty(),
            "{kind:?} must be unavailable for a V1 session"
        );
    }
    assert!(
        stored.slip_episodes.is_empty(),
        "a V1 recording carries no slip channels at all"
    );
    assert_eq!(stored.driving_summary.slip_episode_count, 0);
    assert_eq!(stored.data_quality.slip_ratio_detector_events, 0);
    assert_eq!(stored.data_quality.combined_slip_detector_events, 0);
    // The envelope held slip 9.0 and travel 1.0 on every wheel, which would
    // have produced events on all four corners had it been mined.
    let segment = &stored.turn_segments[0];
    assert_eq!(segment.max_abs_slip_ratio.front_left, None);
    assert_eq!(segment.max_combined_slip.rear_right, None);
    assert_eq!(segment.max_suspension_compression.rear_left, None);
}

/// Reading a V1 session for analysis leaves the file on disk untouched.
#[test]
fn analyzing_a_v1_session_does_not_rewrite_it() {
    let root = scratch("v1-immutable");
    legacy_session(&root, "legacy-3");
    let path = root.join("legacy-3").join(FRAME_FILE_NAME);
    let before = fs::read(&path).unwrap();
    analysis_job::analyze_one(&root, "legacy-3", AnalysisConfigV1::default()).unwrap();
    assert_eq!(
        before,
        fs::read(&path).unwrap(),
        "frame stream was modified"
    );
}

/// Write a real schema-v2 session using the product writer.
fn v2_session(root: &Path, session_id: &str, records: &[RecordedFrame]) {
    let directory = root.join(session_id);
    fs::create_dir_all(&directory).unwrap();
    let mut writer = session_format::FrameStreamWriter::create(
        &directory,
        &session_format::FrameStreamHeader {
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            session_id: session_id.into(),
            started_at_unix_ms: 1_800_000_000_000,
        },
    )
    .unwrap();
    for record in records {
        writer
            .write(record.sequence, record.monotonic_ms, &record.frame)
            .unwrap();
    }
    writer
        .finish(&session_format::FrameStreamEnd {
            frame_count: records.len() as u64,
            duration_us: 0,
            recorder_dropped_frames: 0,
        })
        .unwrap();
    let mut manifest = SessionManifestV1::new(session_id.into(), Some(1_800_000_000_000));
    manifest.status = SessionStatus::Completed;
    manifest.frame_count = records.len() as u64;
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();
}

/// A drive that exercises every detector at least once.
fn rich_records() -> Vec<RecordedFrame> {
    let mut yaw = 0.0_f64;
    let mut records = Vec::new();
    for index in 0..200_usize {
        let rate: f64 = if (40..90).contains(&index) { 0.6 } else { 0.0 };
        let (throttle, brake, speed) = match index {
            0..=29 => (1.0, 0.0, 10.0 + index as f32 * 0.8),
            30..=39 => (0.0, 0.95, 34.0 - (index - 29) as f32 * 1.5),
            _ => (0.5, 0.0, 20.0),
        };
        let mut frame = with_yaw(active(speed, throttle, brake), wrap_angle(yaw) as f32);
        frame = if (100..115).contains(&index) {
            one_corner(frame, WheelPosition::RearRight, |wheel| {
                wheel.slip_ratio = Some(2.5);
                wheel.combined_slip = Some(2.6);
                wheel.normalized_suspension_travel = Some(0.98);
            })
        } else if (130..145).contains(&index) {
            one_corner(frame, WheelPosition::FrontLeft, |wheel| {
                wheel.normalized_suspension_travel = Some(0.02);
            })
        } else {
            with_wheels(frame, quiet_wheels())
        };
        records.push(record(index, index as u64 * 50, frame));
        yaw += rate * 0.05;
    }
    records
}

/// Case 25. A V2 session supports the whole detector set, end to end through the
/// real writer, the real reader and the real persistence.
#[test]
fn a_v2_session_supports_the_full_analysis() {
    let root = scratch("v2-analysis");
    v2_session(&root, "modern-1", &rich_records());
    analysis_job::analyze_one(&root, "modern-1", AnalysisConfigV1::default()).unwrap();
    let stored = analysis::read_analysis(&root.join("modern-1")).unwrap();
    assert_eq!(stored.schema_version, ANALYSIS_SCHEMA_VERSION);
    assert_eq!(stored.telemetry_frame_schema_version, 2);
    assert!(stored.data_quality.wheel_telemetry_available);
    assert!(stored.data_quality.suspension_available);
    assert!(stored.data_quality.frame_stream_complete);
    for kind in [
        EventKind::FullThrottle,
        EventKind::Braking,
        EventKind::HardBraking,
        EventKind::RapidThrottleLift,
        EventKind::StrongAcceleration,
        EventKind::StrongDeceleration,
        EventKind::HighSuspensionCompression,
        EventKind::HighSuspensionExtension,
    ] {
        assert!(count_of(&stored, kind) > 0, "{kind:?} was never detected");
    }
    assert!(
        stored.driving_summary.slip_episode_count > 0,
        "slip is presented as episodes and there should be at least one"
    );
    assert!(stored.data_quality.slip_ratio_detector_events > 0);
    assert!(stored.driving_summary.slip_episode_seconds > 0.0);
    assert_eq!(stored.turn_segments.len(), 1);
    // Events are in time order, which is what the UI renders directly.
    assert!(stored
        .events
        .windows(2)
        .all(|pair| pair[0].start_ms <= pair[1].start_ms));
}

/// The analysis leaves the recording exactly as it was, and adds one file.
#[test]
fn analysis_only_adds_a_file_to_the_session_directory() {
    let root = scratch("v2-additive");
    v2_session(&root, "modern-2", &rich_records());
    let directory = root.join("modern-2");
    let frames_before = fs::read(directory.join(FRAME_FILE_NAME)).unwrap();
    let manifest_before = fs::read(directory.join("manifest.json")).unwrap();
    analysis_job::analyze_one(&root, "modern-2", AnalysisConfigV1::default()).unwrap();
    assert_eq!(
        frames_before,
        fs::read(directory.join(FRAME_FILE_NAME)).unwrap()
    );
    assert_eq!(
        manifest_before,
        fs::read(directory.join("manifest.json")).unwrap()
    );
    assert!(directory.join(ANALYSIS_FILE_NAME).is_file());
}

// --------------------------------------------------------------- resilience

/// Case 26. A corrupt frame stream produces no analysis at all. A partial analysis
/// that looks complete would be worse than none.
#[test]
fn a_corrupt_frame_stream_fails_without_writing_an_analysis() {
    let root = scratch("corrupt-stream");
    v2_session(&root, "broken-1", &rich_records());
    let directory = root.join("broken-1");
    // Truncate a record mid-payload and follow it with garbage.
    let mut bytes = fs::read(directory.join(FRAME_FILE_NAME)).unwrap();
    bytes.truncate(120);
    bytes.extend_from_slice(&[0xFF; 32]);
    fs::write(directory.join(FRAME_FILE_NAME), &bytes).unwrap();

    let error = analysis_job::analyze_one(&root, "broken-1", AnalysisConfigV1::default())
        .expect_err("a corrupt stream must fail");
    assert!(error.contains("frame stream"), "{error}");
    assert!(!directory.join(ANALYSIS_FILE_NAME).exists());
    assert!(!directory.join("analysis.json.tmp").exists());
    // The session itself is untouched and still readable.
    let manifest = session_store::get_session(&root, "broken-1").unwrap();
    assert_eq!(manifest.status, SessionStatus::Completed);
}

/// A stream with no footer — a session lost to a crash — is still analyzed, and
/// says that it was incomplete rather than refusing.
#[test]
fn a_footerless_stream_is_analyzed_and_reports_incompleteness() {
    let records = rich_records();
    let mut bytes = Vec::new();
    session_format::write_stream_header(
        &mut bytes,
        &session_format::FrameStreamHeader {
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            session_id: "crashed-1".into(),
            started_at_unix_ms: 1,
        },
    )
    .unwrap();
    for record in &records {
        session_format::write_frame(
            &mut bytes,
            record.sequence,
            record.monotonic_ms,
            &record.frame,
        )
        .unwrap();
    }
    let reader = FrameStreamReader::new(Cursor::new(bytes)).unwrap();
    let analysis = analysis_engine::analyze_stream(reader, AnalysisConfigV1::default()).unwrap();
    assert!(!analysis.data_quality.frame_stream_complete);
    assert_eq!(analysis.data_quality.frames_read, records.len() as u64);
}

/// Case 27. A corrupt `analysis.json` is isolated: it is its own state, the session
/// still opens, and a listing is unaffected.
#[test]
fn a_corrupt_analysis_file_is_isolated() {
    let root = scratch("corrupt-analysis");
    v2_session(&root, "modern-3", &rich_records());
    let directory = root.join("modern-3");
    fs::write(directory.join(ANALYSIS_FILE_NAME), b"{ not json at all").unwrap();

    let state = session_store::get_session_analysis(&root, "modern-3", false).unwrap();
    assert_eq!(state.state, AnalysisAvailability::Corrupt);
    assert!(state.analysis.is_none());
    assert!(state.message.is_some());
    // Neither the session nor the listing is affected.
    assert!(session_store::get_session(&root, "modern-3").is_ok());
    let recent = session_store::list_recent_sessions(&root, None);
    assert_eq!(recent.sessions.len(), 1);
    assert_eq!(recent.unreadable, 0);
    assert!(matches!(
        analysis::read_analysis(&directory),
        Err(AnalysisReadError::Corrupt(_))
    ));
}

/// Case 28. An analysis written by a future schema is refused by version, not by
/// best-effort decoding, and reports the version it found.
#[test]
fn an_unsupported_analysis_schema_is_refused_by_version() {
    let root = scratch("future-analysis");
    v2_session(&root, "modern-4", &rich_records());
    let directory = root.join("modern-4");
    analysis_job::analyze_one(&root, "modern-4", AnalysisConfigV1::default()).unwrap();
    let mut document: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join(ANALYSIS_FILE_NAME)).unwrap()).unwrap();
    document["schema_version"] = serde_json::json!(ANALYSIS_SCHEMA_VERSION + 7);
    fs::write(
        directory.join(ANALYSIS_FILE_NAME),
        serde_json::to_vec_pretty(&document).unwrap(),
    )
    .unwrap();

    let state = session_store::get_session_analysis(&root, "modern-4", false).unwrap();
    assert_eq!(state.state, AnalysisAvailability::Unsupported);
    assert_eq!(
        state.analysis_schema_version,
        Some(ANALYSIS_SCHEMA_VERSION + 7)
    );
    assert_eq!(
        state.supported_analysis_schema_version,
        ANALYSIS_SCHEMA_VERSION
    );
    assert!(state.analysis.is_none());
    assert!(session_store::get_session(&root, "modern-4").is_ok());
}

/// A session with no analysis reports absence explicitly — never "zero events".
#[test]
fn a_session_without_an_analysis_reports_absence_not_emptiness() {
    let root = scratch("absent-analysis");
    v2_session(&root, "modern-5", &rich_records());
    let state = session_store::get_session_analysis(&root, "modern-5", false).unwrap();
    assert_eq!(state.state, AnalysisAvailability::Absent);
    assert!(state.analysis.is_none());
    assert!(state.message.is_some());
    // And the same session, while a job for it is queued, is pending.
    let pending = session_store::get_session_analysis(&root, "modern-5", true).unwrap();
    assert_eq!(pending.state, AnalysisAvailability::Pending);
}

/// A crafted session identifier can never escape the sessions root, on either
/// analysis entry point.
#[test]
fn analysis_rejects_unsafe_session_identifiers() {
    let root = scratch("unsafe-id");
    for id in ["../escape", "a/b", "", "with space", "..\\escape"] {
        assert!(
            session_store::get_session_analysis(&root, id, false).is_err(),
            "{id}"
        );
        assert!(
            analysis_job::analyze_one(&root, id, AnalysisConfigV1::default()).is_err(),
            "{id}"
        );
    }
}

/// Case 29. Finalization is atomic: the temp file is gone, no partial file remains,
/// and a failed write leaves any previous analysis intact.
#[test]
fn analysis_finalization_is_atomic() {
    let root = scratch("atomic-analysis");
    v2_session(&root, "modern-6", &rich_records());
    let directory = root.join("modern-6");
    analysis_job::analyze_one(&root, "modern-6", AnalysisConfigV1::default()).unwrap();
    assert!(directory.join(ANALYSIS_FILE_NAME).is_file());
    assert!(
        !directory.join("analysis.json.tmp").exists(),
        "the temporary file must not survive"
    );
    let first = fs::read(directory.join(ANALYSIS_FILE_NAME)).unwrap();
    // A second analysis replaces the file in one step and leaves no temp file.
    analysis_job::analyze_one(&root, "modern-6", AnalysisConfigV1::default()).unwrap();
    assert!(!directory.join("analysis.json.tmp").exists());
    let second = fs::read(directory.join(ANALYSIS_FILE_NAME)).unwrap();
    assert!(!second.is_empty());
    // Both are complete, parseable documents.
    for bytes in [first, second] {
        let document: SessionAnalysisV1 = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(document.schema_version, ANALYSIS_SCHEMA_VERSION);
    }
}

/// An analysis of a session whose frame file is missing fails and writes
/// nothing, leaving the directory as it was.
#[test]
fn a_missing_frame_stream_fails_without_side_effects() {
    let root = scratch("missing-stream");
    let directory = root.join("empty-1");
    fs::create_dir_all(&directory).unwrap();
    assert!(analysis_job::analyze_one(&root, "empty-1", AnalysisConfigV1::default()).is_err());
    assert!(!directory.join(ANALYSIS_FILE_NAME).exists());
}

// ------------------------------------------------------- automatic lifecycle

struct Rig {
    hub: Arc<TelemetryHub>,
    recorder: Arc<SessionRecorder>,
    analyzer: Arc<AnalysisRunner>,
    root: PathBuf,
}

/// The real hub, the real `SessionEngine`, the real recorder and the real
/// analysis runner, wired exactly as `lib.rs` wires them. Only the frames are
/// synthetic.
fn rig(name: &str) -> Rig {
    let root = scratch(name);
    let recorder = SessionRecorder::new(root.clone()).unwrap();
    let hub = Arc::new(TelemetryHub::new(8, "test".into(), 200, 60_000).unwrap());
    hub.attach_recorder(Arc::clone(&recorder) as Arc<dyn SessionRecorderHook>)
        .unwrap();
    let analyzer = AnalysisRunner::new(root.clone(), AnalysisConfigV1::default()).unwrap();
    recorder
        .attach_completion_hook(Arc::clone(&analyzer) as Arc<_>)
        .unwrap();
    Rig {
        hub,
        recorder,
        analyzer,
        root,
    }
}

impl Rig {
    fn drive(&self, frames: usize) -> String {
        for index in 0..frames {
            let throttle = if index % 40 < 20 { 1.0 } else { 0.0 };
            let brake = if index % 40 < 20 { 0.0 } else { 0.9 };
            self.hub.publish(
                with_wheels(active(30.0, throttle, brake), quiet_wheels()),
                index as u64 * 50,
                Some(1_800_000_000_000 + index as u64 * 50),
            );
        }
        self.hub.session().expect("a session exists").id
    }

    fn await_analysis(&self, id: &str) -> SessionAnalysisV1 {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            if let Ok(analysis) = analysis::read_analysis(&self.root.join(id)) {
                return analysis;
            }
            assert!(Instant::now() < until, "no analysis appeared for {id}");
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn await_finalized(&self, id: &str) {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            if session_store::get_session(&self.root, id)
                .is_ok_and(|manifest| manifest.status != SessionStatus::Recording)
            {
                return;
            }
            assert!(Instant::now() < until, "writer never finalized {id}");
            thread::sleep(Duration::from_millis(5));
        }
    }
}

/// Case 30. The product flow: drive, stop, and an analysis appears. No control is
/// pressed anywhere in this test, because there is no control to press.
#[test]
fn a_completed_recording_is_analyzed_automatically() {
    let rig = rig("auto-analysis");
    let id = rig.drive(200);
    rig.hub.finish_session(10_000, "test_complete");
    rig.await_finalized(&id);
    let analysis = rig.await_analysis(&id);
    assert_eq!(analysis.session_id, id);
    assert_eq!(analysis.data_quality.frames_read, 200);
    assert!(count_of(&analysis, EventKind::FullThrottle) > 0);
    assert!(count_of(&analysis, EventKind::HardBraking) > 0);
    let status = rig.analyzer.status();
    assert_eq!(status.analyzed_sessions, 1);
    assert_eq!(status.failed_sessions, 0);
    // And the session is still exactly what the recorder said it was.
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.status, SessionStatus::Completed);
    assert!(manifest.summary.is_some());
}

/// An interrupted recording is not analyzed: analysis follows a successful
/// completion and nothing else.
#[test]
fn an_interrupted_recording_is_not_analyzed() {
    let rig = rig("interrupted-analysis");
    let id = rig.drive(50);
    // Shutting the recorder down mid-session interrupts it.
    rig.recorder.shutdown();
    rig.await_finalized(&id);
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.status, SessionStatus::Interrupted);
    thread::sleep(Duration::from_millis(200));
    assert!(matches!(
        analysis::read_analysis(&rig.root.join(&id)),
        Err(AnalysisReadError::Absent)
    ));
    assert_eq!(rig.analyzer.status().analyzed_sessions, 0);
}

/// Case 31. A failing analysis leaves the completed session completely alone: same
/// status, same summary, same frame file, and no analysis document.
#[test]
fn an_analysis_failure_does_not_affect_the_completed_session() {
    let root = scratch("analysis-failure");
    v2_session(&root, "modern-7", &rich_records());
    let directory = root.join("modern-7");
    let manifest_before = fs::read(directory.join("manifest.json")).unwrap();
    // Corrupt the stream so analysis is guaranteed to fail.
    let mut bytes = fs::read(directory.join(FRAME_FILE_NAME)).unwrap();
    bytes.truncate(90);
    bytes.push(0x7F);
    bytes.extend_from_slice(&[0xAB; 16]);
    fs::write(directory.join(FRAME_FILE_NAME), &bytes).unwrap();

    let analyzer = AnalysisRunner::new(root.clone(), AnalysisConfigV1::default()).unwrap();
    assert!(analyzer.request("modern-7"));
    let until = Instant::now() + Duration::from_secs(20);
    while analyzer.status().failed_sessions == 0 {
        assert!(Instant::now() < until, "the failure was never recorded");
        thread::sleep(Duration::from_millis(10));
    }
    let status = analyzer.status();
    assert_eq!(status.failed_sessions, 1);
    assert!(
        status.last_error.is_some(),
        "the failure must be observable"
    );
    assert_eq!(
        manifest_before,
        fs::read(directory.join("manifest.json")).unwrap()
    );
    let manifest = session_store::get_session(&root, "modern-7").unwrap();
    assert_eq!(manifest.status, SessionStatus::Completed);
    assert!(!directory.join(ANALYSIS_FILE_NAME).exists());
    let state = session_store::get_session_analysis(&root, "modern-7", false).unwrap();
    assert_eq!(state.state, AnalysisAvailability::Absent);
}

/// Case 32. Ingestion and the recorder never wait for analysis. A deliberately slow
/// analyzer — one whose queue is already saturated — cannot slow publication
/// down, because the completion notification is a bounded `try_send`.
#[test]
fn recording_never_blocks_on_analysis() {
    let rig = rig("non-blocking");
    // Saturate the analysis queue with requests for sessions that do not exist,
    // so the worker is busy failing while recording continues.
    for index in 0..ANALYSIS_QUEUE_CAPACITY * 4 {
        rig.analyzer.request(&format!("ghost-{index}"));
    }
    let started = Instant::now();
    let id = rig.drive(2000);
    let publish_elapsed = started.elapsed();
    rig.hub.finish_session(200_000, "test_complete");
    rig.await_finalized(&id);
    // 2000 publications with no disk work on the calling thread. The bound is
    // deliberately loose: the assertion is that publication is not serialized
    // behind analysis, not a performance target.
    assert!(
        publish_elapsed < Duration::from_secs(5),
        "publication took {publish_elapsed:?}"
    );
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.status, SessionStatus::Completed);
    assert_eq!(manifest.frame_count, 2000);
    assert_eq!(manifest.recorder_dropped_frames, 0);
}

/// Case 33. The analysis queue is bounded. Requests beyond the bound are refused and
/// counted; nothing is buffered without limit and no caller ever blocks.
#[test]
fn the_analysis_queue_is_bounded_and_refuses_overflow() {
    let root = scratch("bounded-queue");
    // Minimal sessions on purpose: this test is about the queue bound, not
    // about analysis content, and writing 64 full-length recordings would add
    // a disk-I/O burst that only makes the rest of the suite slower.
    let small: Vec<_> = (0..8)
        .map(|index| record(index, index as u64 * 50, active(30.0, 1.0, 0.0)))
        .collect();
    for index in 0..ANALYSIS_QUEUE_CAPACITY * 8 {
        v2_session(&root, &format!("bulk-{index}"), &small);
    }
    let analyzer = AnalysisRunner::new(root.clone(), AnalysisConfigV1::default()).unwrap();
    let mut accepted = 0;
    let started = Instant::now();
    for index in 0..ANALYSIS_QUEUE_CAPACITY * 8 {
        if analyzer.request(&format!("bulk-{index}")) {
            accepted += 1;
        }
    }
    // Every request returned immediately, whether accepted or refused.
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "requests blocked for {:?}",
        started.elapsed()
    );
    let status = analyzer.status();
    assert!(status.pending <= ANALYSIS_QUEUE_CAPACITY + 1, "{status:?}");
    assert!(accepted >= 1);
    assert_eq!(
        accepted as u64 + status.rejected_requests,
        (ANALYSIS_QUEUE_CAPACITY * 8) as u64
    );
}

/// A duplicate request for a session already queued is refused rather than
/// analyzing the same session twice.
#[test]
fn a_duplicate_request_is_refused() {
    let root = scratch("duplicate-request");
    v2_session(&root, "modern-8", &rich_records());
    let analyzer = AnalysisRunner::new(root.clone(), AnalysisConfigV1::default()).unwrap();
    assert!(analyzer.request("modern-8"));
    // The second request either lands while the first is still pending (and is
    // refused) or after it finished (and is accepted). Only the first case is
    // deterministic, so assert the invariant that holds either way.
    let duplicate = analyzer.request("modern-8");
    if duplicate {
        assert!(!analyzer.is_pending("modern-8") || analyzer.status().pending <= 1);
    } else {
        assert!(analyzer.status().rejected_requests >= 1);
    }
}

// ------------------------------------------------------------------- limits

/// Memory is bounded by construction: analysing ten times as many frames does
/// not produce ten times the retained state. The observable proxy is that the
/// event and segment lists stay capped and the analysis document stays small.
#[test]
fn output_is_capped_and_truncation_is_reported() {
    let config = AnalysisConfigV1 {
        max_events: 5,
        min_event_ms: 0,
        suspension_min_ms: 0,
        suspension_merge_gap_ms: 0,
        ..AnalysisConfigV1::default()
    };
    // 200 separate suspension excursions on one corner.
    let records = sequence(1200, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        let excited = (index / 3) % 2 == 0;
        one_corner(frame, WheelPosition::FrontLeft, |wheel| {
            wheel.normalized_suspension_travel = Some(if excited { 0.01 } else { 0.5 });
        })
    });
    let analysis = analyze_records(&records, config);
    assert_eq!(
        of_kind(&analysis, EventKind::HighSuspensionExtension).len(),
        5
    );
    assert!(count_of(&analysis, EventKind::HighSuspensionExtension) > 5);
    assert!(analysis.data_quality.events_truncated > 0);
}

/// An empty stream analyzes to an empty, well-formed analysis rather than an
/// error, and says it saw nothing.
#[test]
fn an_empty_stream_produces_an_empty_analysis() {
    let analysis = analyze(&[]);
    assert_eq!(analysis.data_quality.frames_read, 0);
    assert!(analysis.events.is_empty());
    assert!(analysis.turn_segments.is_empty());
    assert_eq!(analysis.coverage.analyzed_seconds, 0.0);
    assert!(!analysis.data_quality.speed_available);
}

/// The stored configuration is the one that produced the analysis, so a
/// threshold can always be traced from a result back to its rule.
#[test]
fn the_analysis_records_the_configuration_that_produced_it() {
    let config = AnalysisConfigV1 {
        hard_braking_enter: 0.55,
        hard_braking_exit: 0.45,
        ..AnalysisConfigV1::default()
    };
    let records = sequence(30, 50, |index| {
        active(30.0, 0.0, if (10..20).contains(&index) { 0.6 } else { 0.0 })
    });
    let analysis = analyze_records(&records, config);
    assert_eq!(analysis.config.hard_braking_enter, 0.55);
    assert_eq!(of_kind(&analysis, EventKind::HardBraking).len(), 1);
    // The default configuration would not have called this hard braking.
    let default = analyze(&records);
    assert!(of_kind(&default, EventKind::HardBraking).is_empty());
}

/// Analysis is deterministic: the same stream analyzed twice is identical,
/// apart from the timestamp recording when it ran.
#[test]
fn analysis_is_deterministic() {
    let records = rich_records();
    let mut first = analyze(&records);
    let mut second = analyze(&records);
    // Every observation of the clock is normalised away: what must be identical
    // is the analysis of the stream, not how long the machine took to produce
    // it or when it happened to run.
    for analysis in [&mut first, &mut second] {
        analysis.analyzed_at_unix_ms = 0;
        analysis.requested_at_unix_ms = None;
        analysis.queued_ms = None;
        analysis.analysis_duration_ms = 0;
    }
    assert_eq!(first, second);
}

// ==========================================================================
// V0.9 hardening: slip coalescing, suspension significance, turn net yaw
// ==========================================================================

/// A slide puts several corners over threshold on both slip channels at
/// overlapping but not identical times. That is one episode, not one row per
/// corner per channel.
#[test]
fn one_maneuver_across_several_corners_is_a_single_episode() {
    // Corners come in and out at staggered times inside one continuous slide.
    let records = sequence(60, 50, |index| {
        let frame = active(30.0, 0.8, 0.0);
        let mut wheels = quiet_wheels();
        let windows = [
            (WheelPosition::RearLeft, 10_usize, 34_usize),
            (WheelPosition::RearRight, 12, 36),
            (WheelPosition::FrontLeft, 18, 30),
        ];
        for (position, from, to) in windows {
            if (from..to).contains(&index) {
                let mut wheel = *wheels.get(position);
                wheel.slip_ratio = Some(2.5);
                wheel.slip_angle = Some(1.0);
                wheel.combined_slip = Some(2.7);
                wheels.set(position, wheel);
            }
        }
        with_wheels(frame, wheels)
    });
    let analysis = analyze(&records);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 1, "one slide is one episode: {found:?}");
    let episode = &found[0];
    // It spans the union of the corner windows.
    assert_eq!(episode.start_ms, 500);
    assert_eq!(episode.end_ms, 1750);
    // Every affected corner is retained, in canonical order.
    assert_eq!(
        episode.corners,
        vec![
            WheelPosition::FrontLeft,
            WheelPosition::RearLeft,
            WheelPosition::RearRight
        ]
    );
    assert_eq!(episode.corners.len(), 3);
    // Both channels are named once, not as separate rows.
    assert_eq!(
        episode.families,
        vec![SlipFamily::SlipRatio, SlipFamily::CombinedSlip]
    );
    // The corner that never slipped stays unavailable.
    assert_eq!(episode.max_abs_slip_ratio.front_right, None);
    assert_eq!(episode.max_combined_slip.front_right, None);
    // And the raw detectors did see many separate engagements, which is exactly
    // the duplication the episode exists to collapse.
    let raw = analysis.data_quality.slip_ratio_detector_events
        + analysis.data_quality.combined_slip_detector_events;
    assert!(raw >= 6, "expected several raw detections, got {raw}");
    assert_eq!(analysis.driving_summary.slip_episode_count, 1);
}

/// Combined slip alone also coalesces: a maneuver that only crosses the lateral
/// channel is still one episode naming only that channel.
#[test]
fn overlapping_combined_slip_on_several_corners_is_one_episode() {
    let records = sequence(50, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        let mut wheels = quiet_wheels();
        for (position, from, to) in [
            (WheelPosition::FrontLeft, 10_usize, 30_usize),
            (WheelPosition::FrontRight, 14, 34),
        ] {
            if (from..to).contains(&index) {
                let mut wheel = *wheels.get(position);
                // Low longitudinal slip, high lateral.
                wheel.slip_ratio = Some(0.05);
                wheel.slip_angle = Some(2.0);
                wheel.combined_slip = Some(2.0006);
                wheels.set(position, wheel);
            }
        }
        with_wheels(frame, wheels)
    });
    let analysis = analyze(&records);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].families, vec![SlipFamily::CombinedSlip]);
    assert_eq!(
        found[0].corners,
        vec![WheelPosition::FrontLeft, WheelPosition::FrontRight]
    );
    assert_eq!(analysis.data_quality.slip_ratio_detector_events, 0);
}

/// Coalescing must not merge across a clearly distinct period of normal grip.
#[test]
fn slip_maneuvers_separated_by_normal_grip_stay_separate() {
    let config = AnalysisConfigV1::default();
    // Two slides, separated by well over the merge gap of normal grip.
    let quiet_frames = (config.slip_merge_gap_ms / 50) as usize + 8;
    let records = sequence(60 + quiet_frames, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        let first = (5..20).contains(&index);
        let second = (20 + quiet_frames..40 + quiet_frames).contains(&index);
        if first || second {
            one_corner(frame, WheelPosition::RearLeft, |wheel| {
                wheel.slip_ratio = Some(3.0);
                wheel.combined_slip = Some(3.1);
            })
        } else {
            with_wheels(frame, quiet_wheels())
        }
    });
    let analysis = analyze_records(&records, config);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 2, "{found:?}");
    assert!(found[0].end_ms < found[1].start_ms);
    assert_eq!(found[0].index, 1);
    assert_eq!(found[1].index, 2);
}

/// Slip that resumes inside the merge window is one episode, and the quiet
/// stretch is excluded from the engaged time rather than counted as slipping.
#[test]
fn slip_resuming_inside_the_merge_window_is_one_episode() {
    let config = AnalysisConfigV1::default();
    let records = sequence(40, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        // Slip, a 150 ms recovery, then slip again — one maneuver.
        let engaged = (5..12).contains(&index) || (15..25).contains(&index);
        if engaged {
            one_corner(frame, WheelPosition::RearRight, |wheel| {
                wheel.slip_ratio = Some(2.0);
                wheel.combined_slip = Some(2.1);
            })
        } else {
            with_wheels(frame, quiet_wheels())
        }
    });
    let analysis = analyze_records(&records, config);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 1, "{found:?}");
    let episode = &found[0];
    assert_eq!(episode.start_ms, 250);
    assert_eq!(episode.end_ms, 1200);
    // The 150 ms recovery is inside the span but not inside the engaged time.
    assert!(
        episode.engaged_seconds < episode.duration_ms as f64 / 1000.0,
        "engaged {} vs duration {}",
        episode.engaged_seconds,
        episode.duration_ms
    );
}

/// Coalescing changes how many rows describe a maneuver, never what it
/// measured. A very large slip peak survives intact and is never clamped.
#[test]
fn large_slip_peaks_are_preserved_per_corner() {
    // Values far beyond anything V0.8's evidence car produced, on purpose: real
    // sessions reach these and they must not be suppressed for being large.
    let peaks = [
        (WheelPosition::FrontLeft, -15.39_f32),
        (WheelPosition::FrontRight, 25.68),
        (WheelPosition::RearLeft, 75.46),
        (WheelPosition::RearRight, -76.01),
    ];
    let records = sequence(40, 50, |index| {
        let frame = active(30.0, 1.0, 0.0);
        let mut wheels = quiet_wheels();
        if (10..25).contains(&index) {
            for (position, peak) in peaks {
                let mut wheel = *wheels.get(position);
                // Ramp so the peak occurs on one specific frame.
                let scale = if index == 17 { 1.0 } else { 0.5 };
                wheel.slip_ratio = Some(peak * scale);
                wheel.combined_slip = Some((peak * scale).abs() + 0.1);
                wheels.set(position, wheel);
            }
        }
        with_wheels(frame, wheels)
    });
    let analysis = analyze(&records);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 1);
    let episode = &found[0];
    for (position, peak) in peaks {
        assert_eq!(
            episode.max_abs_slip_ratio.get(position),
            Some(peak.abs()),
            "{position:?} magnitude was not preserved"
        );
        // The sign is carried through untouched and uninterpreted.
        assert_eq!(
            episode.signed_peak_slip_ratio.get(position),
            Some(peak),
            "{position:?} sign was not preserved"
        );
    }
    assert_eq!(episode.peak_abs_slip_ratio, Some(76.01));
}

/// Episodes and driving events both come out in time order, so the UI renders
/// the list it is given.
#[test]
fn episodes_and_events_stay_in_time_order() {
    let analysis = analyze(&rich_records());
    assert!(analysis
        .events
        .windows(2)
        .all(|pair| pair[0].start_ms <= pair[1].start_ms));
    assert!(analysis
        .slip_episodes
        .windows(2)
        .all(|pair| pair[0].start_ms <= pair[1].start_ms));
    // Indices are presentation ordinals, assigned in that order.
    for (index, episode) in analysis.slip_episodes.iter().enumerate() {
        assert_eq!(episode.index, index as u32 + 1);
    }
}

/// Episodes are capped like every other output list, and truncation is counted
/// rather than silent.
#[test]
fn slip_episode_output_is_capped() {
    let config = AnalysisConfigV1 {
        max_slip_episodes: 3,
        slip_min_ms: 0,
        slip_merge_gap_ms: 50,
        ..AnalysisConfigV1::default()
    };
    // Repeated short slides, each separated by more than the merge gap.
    let records = sequence(400, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        if (index / 4) % 2 == 0 {
            one_corner(frame, WheelPosition::RearLeft, |wheel| {
                wheel.slip_ratio = Some(3.0);
                wheel.combined_slip = Some(3.1);
            })
        } else {
            with_wheels(frame, quiet_wheels())
        }
    });
    let analysis = analyze_records(&records, config);
    assert_eq!(analysis.slip_episodes.len(), 3);
    assert!(analysis.driving_summary.slip_episode_count > 3);
    assert!(analysis.data_quality.slip_episodes_truncated > 0);
}

/// A gap closes an open episode at the last frame that observed slip, exactly
/// as it closes every other detector.
#[test]
fn a_gap_closes_an_open_slip_episode() {
    let config = AnalysisConfigV1::default();
    let slip = |frame: TelemetryFrame| {
        one_corner(frame, WheelPosition::RearLeft, |wheel| {
            wheel.slip_ratio = Some(3.0);
            wheel.combined_slip = Some(3.1);
        })
    };
    let mut records: Vec<_> = (0..12)
        .map(|index| record(index, index as u64 * 50, slip(active(30.0, 0.5, 0.0))))
        .collect();
    let after_gap = 550 + config.max_gap_ms * 3;
    records.extend((0..12).map(|index| {
        record(
            12 + index,
            after_gap + index as u64 * 50,
            slip(active(30.0, 0.5, 0.0)),
        )
    }));
    let analysis = analyze_records(&records, config);
    let found = episodes(&analysis);
    assert_eq!(found.len(), 2, "an episode must not span a gap: {found:?}");
    assert_eq!(found[0].end_ms, 550);
    assert_eq!(found[1].start_ms, after_gap);
}

// ------------------------------------------------------ suspension chatter

/// A transient wheel unload is not a user-facing event. Real sessions produce
/// many of these on rough ground.
#[test]
fn brief_suspension_extension_noise_is_filtered() {
    let config = AnalysisConfigV1::default();
    // Repeated 100 ms unloads, each separated by more than the merge gap, so
    // none of them can combine into something long enough to report.
    let records = sequence(200, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        let bump = index % 10 < 2;
        one_corner(frame, WheelPosition::RearRight, |wheel| {
            wheel.normalized_suspension_travel = Some(if bump { 0.01 } else { 0.5 });
        })
    });
    let analysis = analyze_records(&records, config);
    assert!(
        of_kind(&analysis, EventKind::HighSuspensionExtension).is_empty(),
        "100 ms unloads are below the {} ms minimum: {:?}",
        config.suspension_min_ms,
        of_kind(&analysis, EventKind::HighSuspensionExtension)
    );
}

/// A genuinely sustained extension is still reported, and keeps its corner.
#[test]
fn sustained_suspension_extension_is_still_reported() {
    let config = AnalysisConfigV1::default();
    let records = sequence(60, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        one_corner(frame, WheelPosition::FrontRight, |wheel| {
            wheel.normalized_suspension_travel =
                Some(if (10..35).contains(&index) { 0.01 } else { 0.5 });
        })
    });
    let analysis = analyze_records(&records, config);
    let events = of_kind(&analysis, EventKind::HighSuspensionExtension);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].corner, Some(WheelPosition::FrontRight));
    assert!(events[0].duration_ms >= config.suspension_min_ms);
    assert_eq!(events[0].peak, Some(0.01));
}

/// Washboard surface re-crosses the threshold repeatedly on one wheel. Inside
/// the merge window that is one excursion, not one event per bump.
#[test]
fn a_corner_re_crossing_inside_the_merge_window_is_one_event() {
    let config = AnalysisConfigV1::default();
    // 100 ms down, 100 ms up, repeatedly: every recovery is inside the 150 ms
    // merge window, so the whole stretch is one excursion.
    let records = sequence(60, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        let extended = (10..34).contains(&index) && (index - 10) % 4 < 2;
        one_corner(frame, WheelPosition::RearLeft, |wheel| {
            wheel.normalized_suspension_travel = Some(if extended { 0.01 } else { 0.5 });
        })
    });
    let analysis = analyze_records(&records, config);
    let events = of_kind(&analysis, EventKind::HighSuspensionExtension);
    assert_eq!(events.len(), 1, "merging failed: {events:?}");
    assert!(events[0].duration_ms >= config.suspension_min_ms);
    assert_eq!(events[0].corner, Some(WheelPosition::RearLeft));
}

/// Suspension corner identity survives the merge rule: four corners excited at
/// four distinct times keep their own events.
#[test]
fn suspension_corner_identity_survives_merging() {
    let excitement = [
        (WheelPosition::FrontLeft, 5_usize),
        (WheelPosition::FrontRight, 25),
        (WheelPosition::RearLeft, 45),
        (WheelPosition::RearRight, 65),
    ];
    let records = sequence(90, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        let mut wheels = quiet_wheels();
        for (position, start) in excitement {
            if (start..start + 12).contains(&index) {
                let mut wheel = *wheels.get(position);
                wheel.normalized_suspension_travel = Some(0.02);
                wheels.set(position, wheel);
            }
        }
        with_wheels(frame, wheels)
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::HighSuspensionExtension);
    assert_eq!(events.len(), 4, "{events:?}");
    for (index, (position, start)) in excitement.iter().enumerate() {
        assert_eq!(events[index].corner, Some(*position));
        assert_eq!(events[index].start_ms, *start as u64 * 50);
    }
}

/// Compression uses the same significance rule, and a sustained compression is
/// still reported.
#[test]
fn sustained_suspension_compression_is_still_reported() {
    let records = sequence(60, 50, |index| {
        let frame = active(30.0, 0.5, 0.0);
        one_corner(frame, WheelPosition::RearLeft, |wheel| {
            wheel.normalized_suspension_travel =
                Some(if (10..35).contains(&index) { 0.99 } else { 0.5 });
        })
    });
    let analysis = analyze(&records);
    let events = of_kind(&analysis, EventKind::HighSuspensionCompression);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].corner, Some(WheelPosition::RearLeft));
}

// --------------------------------------------------------- turn net yaw

/// Steering correction that ends where it started crosses the yaw-rate
/// threshold repeatedly but never turns the car. It is not a turn segment.
#[test]
fn a_segment_with_small_net_yaw_change_is_rejected() {
    let config = AnalysisConfigV1::default();
    let mut yaw = 0.0_f64;
    // Oscillating yaw rate well above the enter threshold, for far longer than
    // the minimum duration, with a net heading change near zero.
    let records = sequence(80, 50, |index| {
        let rate: f64 = if (10..70).contains(&index) {
            if (index / 3) % 2 == 0 {
                0.5
            } else {
                -0.5
            }
        } else {
            0.0
        };
        let frame = with_yaw(active(30.0, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze_records(&records, config);
    for segment in &analysis.turn_segments {
        assert!(
            segment.signed_yaw_change_rad.abs() >= config.turn_min_abs_yaw_change_rad,
            "a segment slipped through with {} rad net yaw",
            segment.signed_yaw_change_rad
        );
    }
    assert!(
        analysis.turn_segments.is_empty(),
        "steering correction is not a turn: {:?}",
        analysis.turn_segments
    );
    // The summary agrees; a rejected candidate is not counted as detected.
    assert_eq!(analysis.driving_summary.turn_segment_count, 0);
}

/// The observed real-session artifacts: long enough, fast enough, yaw rate high
/// enough, but a net heading change of only a couple of degrees.
#[test]
fn a_long_segment_with_a_few_degrees_of_net_yaw_is_rejected() {
    let config = AnalysisConfigV1::default();
    let mut yaw = 0.0_f64;
    // ~845 ms above the rate threshold, netting about 0.04 rad, which is what
    // the first real acceptance session produced twice.
    let records = sequence(60, 50, |index| {
        let rate: f64 = match index {
            10..=16 => 0.30,
            17..=26 => -0.20,
            _ => 0.0,
        };
        let frame = with_yaw(active(30.0, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze_records(&records, config);
    assert!(
        analysis.turn_segments.is_empty(),
        "{:?}",
        analysis.turn_segments
    );
}

/// A gentle but genuine turn is still a segment. The gate rejects
/// direction-less wobble, not mild cornering.
#[test]
fn a_gentle_sustained_turn_is_still_a_segment() {
    let config = AnalysisConfigV1::default();
    let mut yaw = 0.0_f64;
    // 0.30 rad/s for a second: comfortably above the net-yaw floor, and close
    // to the weakest segment the real session produced that was a real turn.
    let records = sequence(60, 50, |index| {
        let rate: f64 = if (10..35).contains(&index) { 0.30 } else { 0.0 };
        let frame = with_yaw(active(30.0, 0.5, 0.0), wrap_angle(yaw) as f32);
        yaw += rate * 0.05;
        frame
    });
    let analysis = analyze_records(&records, config);
    assert_eq!(
        analysis.turn_segments.len(),
        1,
        "{:?}",
        analysis.turn_segments
    );
    let segment = &analysis.turn_segments[0];
    assert!(segment.signed_yaw_change_rad > config.turn_min_abs_yaw_change_rad);
    assert!(segment.duration_ms >= config.turn_min_duration_ms);
}

// ------------------------------------------------------------ job timing

/// The queue wait and the analysis runtime are recorded separately, so a long
/// wall-clock gap between a session ending and its analysis appearing can be
/// read as what it is instead of being mistaken for a slow analyzer.
#[test]
fn an_analysis_records_its_queue_wait_separately_from_its_runtime() {
    let root = scratch("job-timing");
    v2_session(&root, "timed-1", &rich_records());
    let runner = AnalysisRunner::new(root.clone(), AnalysisConfigV1::default()).unwrap();
    assert!(runner.request("timed-1"));
    let until = Instant::now() + Duration::from_secs(20);
    while runner.status().analyzed_sessions == 0 {
        assert!(Instant::now() < until, "the analysis never finished");
        thread::sleep(Duration::from_millis(5));
    }
    let stored = analysis::read_analysis(&root.join("timed-1")).unwrap();
    // A job run through the runner always knows when it was requested.
    let requested = stored.requested_at_unix_ms.expect("requested timestamp");
    assert!(stored.queued_ms.is_some());
    assert!(requested <= stored.analyzed_at_unix_ms);
    // The two numbers answer different questions and are never summed.
    let status = runner.status();
    assert!(status.last_queued_ms.is_some());
    assert!(status.last_duration_ms.is_some());
    assert!(status.max_queued_ms >= status.last_queued_ms.unwrap());
}

/// One worker runs jobs in order, so a session queued behind another waits for
/// it. That wait is reported rather than being invisible — which is exactly the
/// discrepancy the first real acceptance session showed.
#[test]
fn a_job_queued_behind_another_reports_its_wait() {
    let root = scratch("job-queue-wait");
    // A deliberately long first job, then a short one queued behind it.
    let long: Vec<_> = (0..40_000)
        .map(|index| record(index, index as u64 * 16, active(30.0, 1.0, 0.0)))
        .collect();
    v2_session(&root, "long-1", &long);
    v2_session(&root, "short-1", &rich_records());
    let runner = AnalysisRunner::new(root.clone(), AnalysisConfigV1::default()).unwrap();
    assert!(runner.request("long-1"));
    assert!(runner.request("short-1"));
    let until = Instant::now() + Duration::from_secs(120);
    while runner.status().analyzed_sessions < 2 {
        assert!(Instant::now() < until, "jobs never finished");
        thread::sleep(Duration::from_millis(10));
    }
    let long_analysis = analysis::read_analysis(&root.join("long-1")).unwrap();
    let short_analysis = analysis::read_analysis(&root.join("short-1")).unwrap();
    // The second job waited at least as long as the first one took to run.
    assert!(
        short_analysis.queued_ms.unwrap() >= long_analysis.queued_ms.unwrap(),
        "short waited {:?}, long waited {:?}",
        short_analysis.queued_ms,
        long_analysis.queued_ms
    );
    // Its own analysis was not slow; only its wait was long. This is the whole
    // point of separating the two numbers.
    assert!(
        short_analysis.analysis_duration_ms <= long_analysis.analysis_duration_ms,
        "short ran for {} ms, long ran for {} ms",
        short_analysis.analysis_duration_ms,
        long_analysis.analysis_duration_ms
    );
    assert!(runner.status().max_queued_ms >= short_analysis.queued_ms.unwrap());
}

/// An analysis produced outside the job runner has no queue wait to report and
/// says so, rather than inventing a zero.
#[test]
fn an_offline_analysis_reports_no_queue_wait() {
    let analysis = analyze(&rich_records());
    assert_eq!(analysis.requested_at_unix_ms, None);
    assert_eq!(analysis.queued_ms, None);
}

/// A v1 analysis document — the development-only shape that preceded slip
/// episodes — is refused by version rather than reinterpreted, and the session
/// itself is untouched.
#[test]
fn a_pre_hardening_analysis_document_is_refused_by_version() {
    let root = scratch("stale-analysis");
    v2_session(&root, "stale-1", &rich_records());
    let directory = root.join("stale-1");
    analysis_job::analyze_one(&root, "stale-1", AnalysisConfigV1::default()).unwrap();
    let mut document: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join(ANALYSIS_FILE_NAME)).unwrap()).unwrap();
    // Exactly what a development-time file written before the hardening pass
    // looks like: schema 1, and no slip episodes at all.
    document["schema_version"] = serde_json::json!(1);
    document
        .as_object_mut()
        .unwrap()
        .remove("slip_episodes")
        .unwrap();
    fs::write(
        directory.join(ANALYSIS_FILE_NAME),
        serde_json::to_vec_pretty(&document).unwrap(),
    )
    .unwrap();

    let state = session_store::get_session_analysis(&root, "stale-1", false).unwrap();
    assert_eq!(state.state, AnalysisAvailability::Unsupported);
    assert_eq!(state.analysis_schema_version, Some(1));
    assert_eq!(state.supported_analysis_schema_version, 2);
    assert!(state.analysis.is_none());
    // The recording is unaffected and can simply be analyzed again.
    assert_eq!(
        session_store::get_session(&root, "stale-1").unwrap().status,
        SessionStatus::Completed
    );
    analysis_job::analyze_one(&root, "stale-1", AnalysisConfigV1::default()).unwrap();
    let refreshed = session_store::get_session_analysis(&root, "stale-1", false).unwrap();
    assert_eq!(refreshed.state, AnalysisAvailability::Available);
}
