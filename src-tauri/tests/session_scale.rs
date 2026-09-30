//! Long-session and backpressure hardening.
//!
//! Every test here drives the real hub, the real `SessionEngine`, the real
//! recorder and the real analysis runner, wired exactly as `lib.rs` wires them.
//! Only the frames are synthetic, and they are published as fast as the calling
//! thread can manage rather than paced, which is strictly harsher than the
//! 60–75 Hz a game actually sends.
//!
//! The properties under test are the ones that decide whether RaceLab can be a
//! V1.0 baseline:
//!
//! - the publishing thread — which in production is the UDP ingestion thread —
//!   never waits for disk or for analysis;
//! - the recorder queue and the analysis queue are both bounded;
//! - anything dropped is counted, so loss is never silent;
//! - shutdown cannot deadlock, whatever is still queued.
//!
//! Runtime and peak memory are printed by the long-stream tests. Run them with
//! `--nocapture` to see the figures.
use racelab_lib::{
    analysis::AnalysisConfigV1,
    analysis_job::AnalysisRunner,
    session_format::SessionStatus,
    session_recorder::{SessionRecorder, RECORDER_QUEUE_CAPACITY},
    session_store,
    telemetry::{Controls, Engine, TelemetryFrame, Vector3, Wheel, Wheels, WHEEL_POSITIONS},
    telemetry_hub::{SessionRecorderHook, TelemetryHub},
};
use std::{
    fs,
    sync::Arc,
    time::{Duration, Instant},
};

/// Frames per second a running FH6 session produces. Used only to turn a
/// wall-clock duration into a frame count, so a test can be described in the
/// units a driver thinks in.
const FRAME_RATE_HZ: usize = 75;

/// One frame interval at `FRAME_RATE_HZ`, to the nearest millisecond.
const FRAME_INTERVAL: Duration = Duration::from_millis(1000 / FRAME_RATE_HZ as u64);

mod scratch;
use scratch::Scratch;

fn scratch(name: &str) -> Scratch {
    Scratch::new(&format!("scale-{name}"))
}

/// A full schema-2 frame, wheels included, so the per-frame encoding cost is
/// the real one rather than a stripped-down approximation.
fn frame(index: usize) -> TelemetryFrame {
    let phase = index as f32 * 0.01;
    let mut wheels = Wheels::default();
    for (corner, position) in WHEEL_POSITIONS.into_iter().enumerate() {
        wheels.set(
            position,
            Wheel {
                temperature_c: Some(80.0 + corner as f32),
                slip_ratio: Some(phase.sin() * 0.4),
                slip_angle: Some(phase.cos() * 0.2),
                combined_slip: Some(phase.sin().abs() * 0.5),
                rotation_rad_s: Some(90.0),
                normalized_suspension_travel: Some(0.5 + phase.sin() * 0.1),
                suspension_travel_m: Some(0.01),
            },
        );
    }
    let speed = 30.0 + phase.sin() * 10.0;
    TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some("3520".into()),
        engine: Engine {
            rpm: Some(4_000.0 + phase.cos() * 1_500.0),
            idle_rpm: Some(800.0),
            max_rpm: Some(7_000.0),
            power_w: Some(120_000.0),
            torque_nm: Some(300.0),
        },
        speed_mps: Some(speed),
        velocity: Some(Vector3 {
            x: speed,
            y: 0.0,
            z: 0.0,
        }),
        acceleration: Some(Vector3 {
            x: phase.cos(),
            y: 0.0,
            z: 0.0,
        }),
        angular_velocity: Some(Vector3 {
            x: 0.0,
            y: phase.sin() * 0.3,
            z: 0.0,
        }),
        orientation: Some(Vector3 {
            x: phase * 0.05,
            y: 0.0,
            z: 0.0,
        }),
        controls: Controls {
            throttle: Some(if index % 300 < 200 { 1.0 } else { 0.0 }),
            brake: Some(if index % 300 < 200 { 0.0 } else { 0.85 }),
            clutch: Some(0.0),
            handbrake: Some(0.0),
            steering: Some(phase.sin() * 0.5),
        },
        wheels,
        ..TelemetryFrame::default()
    }
}

struct Rig {
    hub: Arc<TelemetryHub>,
    recorder: Arc<SessionRecorder>,
    analyzer: Arc<AnalysisRunner>,
    /// Owns the directory and removes it when the test finishes. One run of
    /// this suite writes about 360 MB of frame streams, so leaving them behind
    /// would grow the temporary directory without bound.
    root: Scratch,
}

impl Drop for Rig {
    fn drop(&mut self) {
        // The writer and the analyzer hold frame files open, and Windows will
        // not remove a directory whose files are still open. Field drop order
        // would run these after this method, so they are stopped explicitly.
        // Both shutdowns are idempotent.
        self.recorder.shutdown();
        self.analyzer.shutdown();
    }
}

/// The production wiring, with an optional recorder queue capacity so a test
/// can create genuine backpressure without waiting for a real slow disk.
fn rig(name: &str, capacity: usize) -> Rig {
    let root = scratch(name);
    let recorder = SessionRecorder::with_capacity(root.to_path_buf(), capacity).unwrap();
    let hub = Arc::new(TelemetryHub::new(8, "scale".into(), 200, 60_000).unwrap());
    hub.attach_recorder(Arc::clone(&recorder) as Arc<dyn SessionRecorderHook>)
        .unwrap();
    let analyzer = AnalysisRunner::new(root.to_path_buf(), AnalysisConfigV1::default()).unwrap();
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

/// What one run of `drive` cost.
struct Drive {
    session_id: String,
    /// Wall time spent inside `hub.publish` alone. Time the test spent in its
    /// own flow control is deliberately excluded: the question is how long the
    /// ingestion thread is occupied, not how long the test took.
    publishing: Duration,
    /// The slowest single `hub.publish` call. Reported, but never asserted on:
    /// on a loaded machine the maximum is a scheduler quantum, which says
    /// nothing about RaceLab.
    worst_publish: Duration,
    /// Publishes that took longer than one frame interval.
    ///
    /// This is the statistic that actually distinguishes "the publisher waited
    /// for the disk" from "the OS preempted the thread". A publisher that
    /// waited on disk would exceed a frame interval *systematically*; an
    /// occasional preemption shows up a handful of times in hundreds of
    /// thousands of calls.
    slow_publishes: u64,
    /// Wall time from the first publish to the last, flow control included.
    /// Frames divided by this is the rate the pipeline actually sustained.
    wall: Duration,
}

impl Rig {
    /// Publishes `frames` frames as fast as the *recorder* can accept them.
    ///
    /// Publishing at full CPU speed would be meaningless here. An unthrottled
    /// loop reaches millions of frames per second — tens of thousands of times
    /// what a game sends — so it overruns any bounded queue by construction,
    /// and a drop under those conditions says nothing about whether a real
    /// hour of driving would lose a frame. Backing off while the queue is deep
    /// keeps the producer inside what the writer can sustain, and the rate that
    /// results is exactly the measurement worth having: compared against 75 Hz
    /// it is the margin RaceLab actually has.
    ///
    /// Deliberate overflow is tested separately, by
    /// `a_saturated_recorder_queue_drops_frames_instead_of_blocking_the_publisher`,
    /// which uses no flow control at all.
    fn drive(&self, frames: usize) -> Drive {
        let watermark = self.recorder.status().queue_capacity / 2;
        let wall_started = Instant::now();
        let mut publishing = Duration::ZERO;
        let mut worst = Duration::ZERO;
        let mut slow = 0_u64;
        for index in 0..frames {
            while self.recorder.status().queued_frames > watermark {
                std::hint::spin_loop();
            }
            let at = Instant::now();
            // Monotonic milliseconds at the nominal frame rate. The clock is
            // supplied, so a long session is simulated exactly without taking
            // a long time to run.
            self.hub.publish(
                frame(index),
                (index * 1000 / FRAME_RATE_HZ) as u64,
                Some(1_800_000_000_000 + (index * 1000 / FRAME_RATE_HZ) as u64),
            );
            let elapsed = at.elapsed();
            publishing += elapsed;
            worst = worst.max(elapsed);
            if elapsed > FRAME_INTERVAL {
                slow += 1;
            }
        }
        Drive {
            session_id: self.hub.session().expect("a session must be open").id,
            publishing,
            worst_publish: worst,
            slow_publishes: slow,
            wall: wall_started.elapsed(),
        }
    }

    /// Publishes with no flow control at all, which is how a saturated queue is
    /// produced on purpose.
    fn flood(&self, frames: usize) -> Drive {
        let wall_started = Instant::now();
        let mut publishing = Duration::ZERO;
        let mut worst = Duration::ZERO;
        let mut slow = 0_u64;
        for index in 0..frames {
            let at = Instant::now();
            self.hub.publish(
                frame(index),
                (index * 1000 / FRAME_RATE_HZ) as u64,
                Some(1_800_000_000_000 + (index * 1000 / FRAME_RATE_HZ) as u64),
            );
            let elapsed = at.elapsed();
            publishing += elapsed;
            worst = worst.max(elapsed);
            if elapsed > FRAME_INTERVAL {
                slow += 1;
            }
        }
        Drive {
            session_id: self.hub.session().expect("a session must be open").id,
            publishing,
            worst_publish: worst,
            slow_publishes: slow,
            wall: wall_started.elapsed(),
        }
    }

    fn finish(&self, frames: usize) {
        self.hub
            .finish_session((frames * 1000 / FRAME_RATE_HZ) as u64, "scale_test");
    }

    fn await_finalized(&self, id: &str) {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if let Ok(manifest) = session_store::get_session(&self.root, id) {
                if manifest.status != SessionStatus::Recording {
                    return;
                }
            }
            assert!(
                Instant::now() < deadline,
                "{id} was never finalized: {:?}",
                self.recorder.status()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn bytes(&self, id: &str) -> u64 {
        fs::metadata(self.root.join(id).join("frames.rlframes"))
            .map(|meta| meta.len())
            .unwrap_or(0)
    }
}

/// One long stream, recorded and analyzed, with its cost reported.
fn long_stream(name: &str, minutes: usize) {
    let frames = minutes * 60 * FRAME_RATE_HZ;
    let rig = rig(name, RECORDER_QUEUE_CAPACITY);
    let drive = rig.drive(frames);
    rig.finish(frames);
    rig.await_finalized(&drive.session_id);

    let manifest = session_store::get_session(&rig.root, &drive.session_id).unwrap();
    let bytes = rig.bytes(&drive.session_id);
    let sustained = frames as f64 / drive.wall.as_secs_f64();
    let per_publish_us = drive.publishing.as_secs_f64() * 1e6 / frames as f64;
    println!(
        "{name}: {minutes} min equivalent ({frames} frames) recorded in {:?}\n  sustained {sustained:.0} frames/s = {:.0}x the {FRAME_RATE_HZ} Hz a game sends\n  publishing occupied {:?} total, {per_publish_us:.1} us per frame; {} of {frames} publishes exceeded one frame interval (worst {:?})\n  {bytes} bytes on disk ({:.1} MB, {:.0} B/frame) = {:.2} GB/hour for frames of this size; a real FH6 frame is larger because it also carries the adapter envelope\n  queue capacity {} frames, {} dropped",
        drive.wall,
        sustained / FRAME_RATE_HZ as f64,
        drive.publishing,
        drive.slow_publishes,
        drive.worst_publish,
        bytes as f64 / 1_048_576.0,
        bytes as f64 / frames as f64,
        (bytes as f64 / frames as f64) * FRAME_RATE_HZ as f64 * 3600.0 / 1e9,
        RECORDER_QUEUE_CAPACITY,
        manifest.recorder_dropped_frames,
    );

    assert_eq!(manifest.status, SessionStatus::Completed);
    assert_eq!(manifest.frame_count, frames as u64);
    assert_eq!(
        manifest.recorder_dropped_frames, 0,
        "no frame may be lost at a rate the writer can sustain"
    );
    assert!(manifest.summary.is_some());
    // The margin over the real arrival rate is the whole point of the
    // measurement. Ten times is a deliberately loose floor: the observed figure
    // is far higher, and this exists to catch a collapse, not to pin a number.
    assert!(
        sustained > FRAME_RATE_HZ as f64 * 10.0,
        "the pipeline sustained only {sustained:.0} frames/s against a {FRAME_RATE_HZ} Hz source"
    );
    // The publishing thread is the UDP thread in production. A publisher that
    // waited on disk or on analysis would exceed a frame interval on a large
    // fraction of calls; a stray scheduler preemption on a loaded machine shows
    // up a handful of times in hundreds of thousands, so the bound is on the
    // rate rather than on the maximum.
    let slow_rate = drive.slow_publishes as f64 / frames as f64;
    assert!(
        slow_rate < 0.0005,
        "{} of {frames} publishes ({:.4}%) exceeded a frame interval, which is a publisher that waits",
        drive.slow_publishes,
        slow_rate * 100.0
    );
}

/// Ten minutes of continuous telemetry, recorded end to end with no loss.
#[test]
fn a_ten_minute_stream_records_without_loss() {
    long_stream("ten-minute", 10);
}

/// An hour of continuous telemetry. This is the case that motivated bounded
/// storage: it is where a session stops being a few megabytes and starts being
/// a meaningful fraction of a disk.
#[test]
fn a_sixty_minute_stream_records_without_loss() {
    long_stream("sixty-minute", 60);
}

/// The recorder queue is bounded, and a writer that cannot keep up costs
/// dropped frames rather than a stalled publisher.
///
/// A deliberately tiny queue stands in for a slow disk. The substitution is
/// exact for the property under test: what matters is that admission is refused
/// once the queue is full, and that refusal is what a slow disk produces.
#[test]
fn a_saturated_recorder_queue_drops_frames_instead_of_blocking_the_publisher() {
    let frames = 40_000;
    let rig = rig("slow-disk", 8);
    let drive = rig.flood(frames);
    rig.finish(frames);
    rig.await_finalized(&drive.session_id);

    let manifest = session_store::get_session(&rig.root, &drive.session_id).unwrap();
    println!(
        "slow-disk: {frames} frames flooded into an 8-slot queue in {:?} (worst single publish {:?}); {} written, {} dropped",
        drive.wall, drive.worst_publish, manifest.frame_count, manifest.recorder_dropped_frames
    );

    assert!(
        manifest.recorder_dropped_frames > 0,
        "an 8-slot queue under a flood must overflow"
    );
    // Nothing is lost silently: every frame is either written or counted.
    assert_eq!(
        manifest.frame_count + manifest.recorder_dropped_frames,
        frames as u64
    );
    // And publishing never waited for the disk. This is the property that
    // matters: overflow costs frames, never the ingestion thread.
    assert!(
        (drive.slow_publishes as f64 / frames as f64) < 0.0005,
        "{} of {frames} publishes exceeded a frame interval while the queue was saturated",
        drive.slow_publishes
    );
    // A recording that dropped frames is never presented as a clean dataset.
    assert!(manifest.summary.is_some());
    assert!(!manifest.summary.unwrap().data_quality.complete);
}

/// Analysis of a finished session runs while the next session is being
/// recorded, and neither interferes with the other.
#[test]
fn analysis_runs_while_the_next_session_records() {
    let first_frames = 20_000;
    let second_frames = 20_000;
    let rig = rig("concurrent", RECORDER_QUEUE_CAPACITY);

    let first = rig.drive(first_frames).session_id;
    rig.finish(first_frames);
    rig.await_finalized(&first);
    // The completion hook has queued the analysis by now; the second session
    // starts recording while it runs.
    let started = Instant::now();
    let drive = rig.drive(second_frames);
    let second = drive.session_id.clone();
    rig.finish(second_frames);
    rig.await_finalized(&second);
    let total = started.elapsed();

    let deadline = Instant::now() + Duration::from_secs(120);
    while rig.analyzer.status().analyzed_sessions < 2 {
        assert!(
            Instant::now() < deadline,
            "analysis never caught up: {:?}",
            rig.analyzer.status()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    println!(
        "concurrent: second session recorded in {:?} (worst publish {:?}) while the first was analyzed; {total:?} including analysis",
        drive.wall, drive.worst_publish
    );

    for id in [&first, &second] {
        let manifest = session_store::get_session(&rig.root, id).unwrap();
        assert_eq!(manifest.status, SessionStatus::Completed);
        assert_eq!(
            manifest.recorder_dropped_frames, 0,
            "{id} lost frames to concurrent analysis"
        );
    }
    assert_eq!(rig.analyzer.status().failed_sessions, 0);
}

/// Several completed sessions queue up and are all analyzed, in order, without
/// any of them being lost.
#[test]
fn several_completed_sessions_queue_and_all_get_analyzed() {
    let per_session = 3_000;
    let rig = rig("queued-batch", RECORDER_QUEUE_CAPACITY);
    let mut ids = Vec::new();
    for _ in 0..5 {
        let id = rig.drive(per_session).session_id;
        rig.finish(per_session);
        rig.await_finalized(&id);
        ids.push(id);
    }

    let deadline = Instant::now() + Duration::from_secs(120);
    while rig.analyzer.status().analyzed_sessions < 5 {
        assert!(
            Instant::now() < deadline,
            "not every session was analyzed: {:?}",
            rig.analyzer.status()
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let status = rig.analyzer.status();
    println!(
        "queued-batch: 5 sessions analyzed, longest queue wait {} ms",
        status.max_queued_ms
    );

    assert_eq!(status.failed_sessions, 0);
    assert_eq!(status.rejected_requests, 0);
    for id in &ids {
        assert!(rig.root.join(id).join("analysis.json").is_file(), "{id}");
    }
}

/// Shutting down with work still queued drains it and cannot deadlock. The
/// recorder is drained before the analyzer, exactly as `lib.rs` does it.
#[test]
fn shutdown_with_queued_analysis_drains_and_cannot_deadlock() {
    let per_session = 4_000;
    let rig = rig("shutdown-queued", RECORDER_QUEUE_CAPACITY);
    let mut ids = Vec::new();
    for _ in 0..4 {
        let id = rig.drive(per_session).session_id;
        rig.finish(per_session);
        rig.await_finalized(&id);
        ids.push(id);
    }

    // Shut down immediately, while analyses are still outstanding.
    let started = Instant::now();
    rig.recorder.shutdown();
    rig.analyzer.shutdown();
    let elapsed = started.elapsed();
    println!(
        "shutdown-queued: drained {} sessions in {elapsed:?}",
        ids.len()
    );

    assert!(
        elapsed < Duration::from_secs(120),
        "shutdown took {elapsed:?}"
    );
    // Everything that was queued ran; nothing was abandoned half-written.
    let status = rig.analyzer.status();
    assert_eq!(status.pending, 0, "work was left in flight after shutdown");
    assert_eq!(
        status.analyzed_sessions + status.failed_sessions + status.rejected_requests,
        ids.len() as u64
    );
    for id in &ids {
        let manifest = session_store::get_session(&rig.root, id).unwrap();
        assert_eq!(manifest.status, SessionStatus::Completed);
    }
}

/// Shutting down mid-recording finalizes the open session as interrupted rather
/// than losing it or claiming it finished.
#[test]
fn shutdown_mid_recording_finalizes_the_open_session_as_interrupted() {
    let rig = rig("shutdown-recording", RECORDER_QUEUE_CAPACITY);
    let id = rig.drive(5_000).session_id;

    rig.recorder.shutdown();
    rig.analyzer.shutdown();

    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.status, SessionStatus::Interrupted);
    assert!(
        manifest.summary.is_none(),
        "an interrupted recording never gains a summary"
    );
    assert!(manifest.frame_count > 0, "the frames written are kept");
    assert_eq!(
        manifest.completion_reason.as_deref(),
        Some("recorder_stopped_before_completion")
    );
}
