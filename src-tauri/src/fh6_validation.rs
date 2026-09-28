//! Bounded-memory offline validation of private RLCAP files.
use crate::{
    adapters::fh6::{self, Issue, TimestampEvent, TimestampValidator},
    capture_format::CaptureReader,
    telemetry::{TelemetryFrame, WHEEL_POSITIONS},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    io::{self, Read},
    net::SocketAddr,
};

#[derive(Debug, Default, Serialize)]
pub struct Range {
    pub min: Option<f64>,
    pub max: Option<f64>,
}
impl Range {
    fn add(&mut self, value: f64) {
        self.min = Some(self.min.map_or(value, |v| v.min(value)));
        self.max = Some(self.max.map_or(value, |v| v.max(value)));
    }
}
#[derive(Debug, Serialize)]
pub struct PacketIssue {
    pub packet_index: u64,
    pub issues: Vec<Issue>,
}
#[derive(Debug, Default, Serialize)]
pub struct ValidationReport {
    pub packets: u64,
    pub active_packets: u64,
    pub inactive_packets: u64,
    pub invalid_packets: u64,
    pub decode_failures: u64,
    pub physical_failures: u64,
    pub timestamp_regressions: u64,
    pub timestamp_wraps: u64,
    pub inactive_resets: u64,
    pub explicit_resets: u64,
    pub dropped_capture_frames: u64,
    pub capture_duration_us: u64,
    pub sizes: BTreeMap<usize, u64>,
    pub speed_error_max_mps: f64,
    pub rpm: Range,
    pub rpm_to_max_ratio: Range,
    pub throttle: Range,
    pub brake: Range,
    pub steering: Range,
    pub gear_codes: BTreeMap<u8, u64>,
    /// V0.8 promoted-field ranges over active packets, keyed
    /// `corner.channel` for per-wheel channels and by field name otherwise.
    /// This is the evidence table docs/V0.8-VALIDATION.md reports.
    pub promoted: BTreeMap<String, Range>,
    /// Largest observed `|combined_slip - hypot(slip_ratio, slip_angle)|`.
    /// Reported, never enforced: it is the measured invariant that identified
    /// the three slip blocks, not a protocol guarantee.
    pub combined_slip_residual_max: f64,
    /// Largest observed relative error of `power == torque * angular velocity`
    /// where `|torque * omega| > 1000 W`. Establishes watts and newton-metres.
    pub power_torque_relative_error_max: f64,
    pub power_torque_samples: u64,
    pub issue_samples: Vec<PacketIssue>,
    pub omitted_issue_packets: u64,
    pub valid: bool,
}

impl ValidationReport {
    fn add(&mut self, key: &str, value: Option<f32>) {
        if let Some(value) = value {
            self.promoted
                .entry(key.into())
                .or_default()
                .add(f64::from(value));
        }
    }

    /// Bounded work per packet: four corners times seven channels plus a
    /// handful of scalars, all folded into running ranges.
    fn observe_promoted(&mut self, frame: &TelemetryFrame) {
        for position in WHEEL_POSITIONS {
            let wheel = frame.wheels.get(position);
            let corner = match position {
                crate::telemetry::WheelPosition::FrontLeft => "front_left",
                crate::telemetry::WheelPosition::FrontRight => "front_right",
                crate::telemetry::WheelPosition::RearLeft => "rear_left",
                crate::telemetry::WheelPosition::RearRight => "rear_right",
            };
            self.add(&format!("{corner}.temperature_c"), wheel.temperature_c);
            self.add(&format!("{corner}.slip_ratio"), wheel.slip_ratio);
            self.add(&format!("{corner}.slip_angle"), wheel.slip_angle);
            self.add(&format!("{corner}.combined_slip"), wheel.combined_slip);
            self.add(&format!("{corner}.rotation_rad_s"), wheel.rotation_rad_s);
            self.add(
                &format!("{corner}.normalized_suspension_travel"),
                wheel.normalized_suspension_travel,
            );
            self.add(
                &format!("{corner}.suspension_travel_m"),
                wheel.suspension_travel_m,
            );
            if let (Some(combined), Some(ratio), Some(angle)) =
                (wheel.combined_slip, wheel.slip_ratio, wheel.slip_angle)
            {
                let residual =
                    (f64::from(combined) - f64::from(ratio).hypot(f64::from(angle))).abs();
                self.combined_slip_residual_max = self.combined_slip_residual_max.max(residual);
            }
        }
        self.add("engine.power_w", frame.engine.power_w);
        self.add("engine.torque_nm", frame.engine.torque_nm);
        self.add("race.race_time_seconds", frame.race.race_time_seconds);
        self.add(
            "race.lap_number",
            frame.race.lap_number.map(|value| value as f32),
        );
        self.add(
            "race.race_position",
            frame.race.race_position.map(|value| value as f32),
        );
        self.add(
            "vehicle.class_code",
            frame.vehicle.class_code.map(|value| value as f32),
        );
        self.add(
            "vehicle.performance_index",
            frame.vehicle.performance_index.map(|value| value as f32),
        );
        self.add(
            "vehicle.drivetrain_code",
            frame.vehicle.drivetrain_code.map(|value| value as f32),
        );
        self.add(
            "vehicle.cylinders",
            frame.vehicle.cylinders.map(|value| value as f32),
        );
        if let (Some(power), Some(torque), Some(rpm)) = (
            frame.engine.power_w,
            frame.engine.torque_nm,
            frame.engine.rpm,
        ) {
            let omega = f64::from(rpm) * std::f64::consts::TAU / 60.0;
            let predicted = f64::from(torque) * omega;
            if predicted.abs() > 1000.0 {
                self.power_torque_samples += 1;
                self.power_torque_relative_error_max = self
                    .power_torque_relative_error_max
                    .max((f64::from(power) - predicted).abs() / predicted.abs());
            }
        }
    }
}

pub fn validate_capture<R: Read>(
    reader: R,
    reset_at: &BTreeSet<u64>,
) -> io::Result<ValidationReport> {
    let mut capture = CaptureReader::new(reader)?;
    let mut report = ValidationReport::default();
    let mut clocks = HashMap::<SocketAddr, TimestampValidator>::new();
    let mut used_resets = BTreeSet::new();
    while let Some(packet) = capture.next_packet()? {
        report.packets += 1;
        *report.sizes.entry(packet.bytes.len()).or_default() += 1;
        let mut issues = Vec::new();
        match fh6::decode(&packet.bytes) {
            Err(errors) => {
                report.decode_failures += 1;
                issues.extend(errors);
            }
            Ok(decoded) => {
                let f = &decoded.frame;
                if f.active {
                    report.active_packets += 1;
                    report.speed_error_max_mps = report.speed_error_max_mps.max(
                        (f64::from(f.speed_mps.expect("active decoded FH6 speed"))
                            - f.velocity.expect("active decoded FH6 velocity").magnitude())
                        .abs(),
                    );
                    report
                        .rpm
                        .add(f64::from(f.engine.rpm.expect("active decoded FH6 RPM")));
                    if f.engine.max_rpm.unwrap_or_default() > 0.0 {
                        report.rpm_to_max_ratio.add(
                            f64::from(f.engine.rpm.expect("active decoded FH6 RPM"))
                                / f64::from(f.engine.max_rpm.expect("active decoded FH6 max RPM")),
                        );
                    }
                    report.throttle.add(f64::from(decoded.fh6.throttle));
                    report.brake.add(f64::from(decoded.fh6.brake));
                    report.steering.add(f64::from(decoded.fh6.steering));
                    *report.gear_codes.entry(decoded.fh6.gear).or_default() += 1;
                    report.observe_promoted(f);
                } else {
                    report.inactive_packets += 1;
                }
                let physical = fh6::physical_issues(f);
                if !physical.is_empty() {
                    report.physical_failures += 1;
                    issues.extend(physical);
                }
                if !clocks.contains_key(&packet.source) && clocks.len() >= 64 {
                    issues.push(Issue::new(
                        "source",
                        0,
                        "More than 64 telemetry sources in one file",
                    ));
                } else {
                    let explicit = reset_at.contains(&report.packets);
                    if explicit {
                        used_resets.insert(report.packets);
                    }
                    match clocks.entry(packet.source).or_default().observe(
                        decoded.fh6.timestamp_ms,
                        f.active,
                        explicit,
                    ) {
                        TimestampEvent::Regression => {
                            report.timestamp_regressions += 1;
                            issues.push(Issue::new(
                                "timestamp_ms",
                                4,
                                "Unexplained game timestamp regression",
                            ));
                        }
                        TimestampEvent::Wrap => report.timestamp_wraps += 1,
                        TimestampEvent::InactiveReset => report.inactive_resets += 1,
                        TimestampEvent::ExplicitReset => report.explicit_resets += 1,
                        _ => {}
                    }
                }
            }
        }
        if !issues.is_empty() {
            report.invalid_packets += 1;
            if report.issue_samples.len() < 100 {
                report.issue_samples.push(PacketIssue {
                    packet_index: report.packets,
                    issues,
                });
            } else {
                report.omitted_issue_packets += 1;
            }
        }
    }
    if &used_resets != reset_at {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Reset indices must identify successfully decoded packets in the file",
        ));
    }
    let end = capture
        .end
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "Missing capture footer"))?;
    report.dropped_capture_frames = end.dropped_capture_frames;
    report.capture_duration_us = end.duration_us;
    report.valid =
        report.packets > 0 && report.invalid_packets == 0 && report.dropped_capture_frames == 0;
    Ok(report)
}
