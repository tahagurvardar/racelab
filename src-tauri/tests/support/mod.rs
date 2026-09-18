//! Test-only decoding of the synthetic sender protocol. Never linked into product logic.
use racelab_lib::packet::{CapturedPacket, PacketSink};
use std::{collections::BTreeMap, sync::Mutex};

#[derive(Debug, Clone)]
pub struct Observation {
    pub sequence: Option<u32>,
    pub monotonic_us: u64,
}

pub struct SequenceObserver {
    observations: Mutex<Vec<Observation>>,
    overflow: Mutex<usize>,
    limit: usize,
}

impl SequenceObserver {
    pub fn observations(&self) -> Vec<Observation> {
        self.observations.lock().unwrap().clone()
    }

    pub fn new(expected: usize) -> Self {
        Self {
            observations: Mutex::new(Vec::with_capacity(expected * 2)),
            overflow: Mutex::new(0),
            limit: expected * 2,
        }
    }

    pub fn report(&self, expected: u32) -> SequenceReport {
        let observations = self.observations.lock().unwrap();
        let mut counts = BTreeMap::new();
        for sequence in observations.iter().filter_map(|value| value.sequence) {
            *counts.entry(sequence).or_insert(0_usize) += 1;
        }
        SequenceReport {
            observed: observations.len(),
            missing: (1..=expected).filter(|n| !counts.contains_key(n)).collect(),
            duplicates: counts
                .iter()
                .filter(|(_, count)| **count > 1)
                .map(|(n, count)| (*n, *count))
                .collect(),
            unexpected: counts
                .keys()
                .filter(|n| **n == 0 || **n > expected)
                .copied()
                .collect(),
            malformed: observations
                .iter()
                .filter(|value| value.sequence.is_none())
                .count(),
            overflow: *self.overflow.lock().unwrap(),
            tail: observations
                .iter()
                .rev()
                .take(10)
                .filter_map(|value| value.sequence)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
            monotonic: observations
                .windows(2)
                .all(|pair| pair[0].monotonic_us <= pair[1].monotonic_us),
        }
    }
}

impl PacketSink for SequenceObserver {
    fn on_packet(&self, packet: &CapturedPacket<'_>) {
        let sequence = std::str::from_utf8(packet.bytes)
            .ok()
            .and_then(|text| text.strip_prefix("RACELAB_TEST|seq="))
            .and_then(|text| text.split('|').next())
            .and_then(|text| text.parse().ok());
        let mut observations = self.observations.lock().unwrap();
        if observations.len() == self.limit {
            *self.overflow.lock().unwrap() += 1;
            return;
        }
        observations.push(Observation {
            sequence,
            monotonic_us: packet.captured_at_us,
        });
    }
}

#[derive(Debug)]
pub struct SequenceReport {
    pub observed: usize,
    pub missing: Vec<u32>,
    pub duplicates: Vec<(u32, usize)>,
    pub unexpected: Vec<u32>,
    pub malformed: usize,
    pub overflow: usize,
    pub tail: Vec<u32>,
    pub monotonic: bool,
}

impl SequenceReport {
    pub fn complete(&self, expected: u32) -> bool {
        self.observed == expected as usize
            && self.missing.is_empty()
            && self.duplicates.is_empty()
            && self.unexpected.is_empty()
            && self.malformed == 0
            && self.overflow == 0
            && self.tail.contains(&expected)
            && self.monotonic
    }

    pub fn diagnostics(&self) -> String {
        format!("observed={} missing=[{}] duplicates={:?} unexpected={:?} malformed={} observer_overflow={} tail={:?} monotonic={}",
            self.observed, ranges(&self.missing), self.duplicates, self.unexpected,
            self.malformed, self.overflow, self.tail, self.monotonic)
    }
}

fn ranges(values: &[u32]) -> String {
    let mut ranges = Vec::new();
    let mut index = 0;
    while index < values.len() {
        let first = values[index];
        let mut last = first;
        index += 1;
        while index < values.len() && values[index] == last + 1 {
            last = values[index];
            index += 1;
        }
        ranges.push(if first == last {
            first.to_string()
        } else {
            format!("{first}-{last}")
        });
    }
    ranges.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observe(observer: &SequenceObserver, sequence: u32, time: u64) {
        let bytes = format!("RACELAB_TEST|seq={sequence}|utc=0");
        observer.on_packet(&CapturedPacket {
            bytes: bytes.as_bytes(),
            source: "127.0.0.1:1".parse().unwrap(),
            received_at_ms: 0,
            captured_at_us: time,
        });
    }

    #[test]
    fn exact_gap_ranges_include_missing_tail() {
        let observer = SequenceObserver::new(1000);
        for n in 1..=1000 {
            if ![2, 3, 7, 998, 999, 1000].contains(&n) {
                observe(&observer, n, n as u64);
            }
        }
        let report = observer.report(1000);
        assert_eq!(ranges(&report.missing), "2-3, 7, 998-1000");
        assert!(!report.tail.contains(&1000));
        assert!(!report.complete(1000));
        println!("Injected gap diagnostic: {}", report.diagnostics());
    }

    #[test]
    fn duplicate_cannot_hide_missing_packet_even_with_correct_count_and_tail() {
        let observer = SequenceObserver::new(1000);
        for n in 1..=1000 {
            observe(&observer, if n == 2 { 1 } else { n }, n as u64);
        }
        let report = observer.report(1000);
        assert_eq!(report.observed, 1000);
        assert_eq!(report.missing, vec![2]);
        assert_eq!(report.duplicates, vec![(1, 2)]);
        assert!(report.tail.contains(&1000));
        assert!(!report.complete(1000));
    }

    #[test]
    fn complete_sequence_includes_final_1000_and_nondecreasing_timestamps() {
        let observer = SequenceObserver::new(1000);
        for n in 1..=1000 {
            observe(&observer, n, n as u64);
        }
        let report = observer.report(1000);
        assert_eq!(report.tail.last(), Some(&1000));
        assert!(report.complete(1000));
        assert_eq!(observer.observations().first().unwrap().sequence, Some(1));
    }

    #[test]
    fn timing_regressions_and_observer_overflow_fail_validation() {
        let observer = SequenceObserver::new(1);
        observe(&observer, 1, 20);
        observe(&observer, 2, 10);
        observe(&observer, 3, 30);
        let report = observer.report(1);
        assert!(!report.monotonic);
        assert_eq!(report.overflow, 1);
        assert_eq!(report.unexpected, vec![2]);
        assert!(!report.complete(1));
    }
}
