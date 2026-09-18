//! Bounded-memory offline validation of private RLCAP files.
use crate::{
    adapters::fh6::{self, Issue, TimestampEvent, TimestampValidator},
    capture_format::CaptureReader,
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
    pub issue_samples: Vec<PacketIssue>,
    pub omitted_issue_packets: u64,
    pub valid: bool,
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
                    report.speed_error_max_mps = report
                        .speed_error_max_mps
                        .max((f64::from(f.speed_mps) - f.velocity.magnitude()).abs());
                    report.rpm.add(f64::from(f.engine.rpm));
                    if f.engine.max_rpm > 0.0 {
                        report
                            .rpm_to_max_ratio
                            .add(f64::from(f.engine.rpm) / f64::from(f.engine.max_rpm));
                    }
                    report.throttle.add(f64::from(decoded.fh6.throttle));
                    report.brake.add(f64::from(decoded.fh6.brake));
                    report.steering.add(f64::from(decoded.fh6.steering));
                    *report.gear_codes.entry(decoded.fh6.gear).or_default() += 1;
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
