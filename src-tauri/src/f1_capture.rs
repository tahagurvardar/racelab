//! Development-only F1 25 fixture capture, V2.0 Phase B.
//!
//! Not a recorder. Nothing is ever captured automatically: one explicit
//! request writes one snapshot of exactly four datagrams, the latest held
//! Car Telemetry, Car Status, Lap Data and Motion Ex packets, and stops.
//!
//! Gates and bounds, all hard:
//! - `RACELAB_F1_CAPTURE=1` **and** a debug build. Unset, `0` or a release
//!   build: there is no capture path at all.
//! - At most `MAX_SNAPSHOTS_PER_RUN` snapshots per process and
//!   `MAX_SNAPSHOT_DIRECTORIES` in the capture directory, ever. Each snapshot
//!   is four files of at most 1352 bytes plus a small manifest.
//! - All four packets must belong to the same session and player and be at
//!   most `MAX_PACKET_AGE_MS` old, or nothing is written.
//! - The label is restricted to `[a-z0-9-]`, so it cannot name a path.
//! - Files go to a temporary directory that is renamed into place, so a
//!   failed capture never leaves a partial snapshot.
//!
//! Raw bytes are never sent to the UI; it only receives the manifest.
use crate::{adapters::f1_25::PacketKind, f1_live::RawLatest};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub const CAPTURE_ENV: &str = "RACELAB_F1_CAPTURE";
pub const MAX_SNAPSHOTS_PER_RUN: u32 = 16;
pub const MAX_SNAPSHOT_DIRECTORIES: usize = 64;
pub const MAX_PACKET_AGE_MS: u64 = 1_000;
pub const MAX_DELAY_MS: u64 = 15_000;
pub const MAX_LABEL_CHARS: usize = 32;

/// Reads `RACELAB_F1_CAPTURE`. `Ok(false)` unless it is `1`/`true` in a debug
/// build. In a release build a set variable is ignored and reported, not
/// fatal: a stray development variable must not stop the product launching.
pub fn enabled_from_environment() -> Result<bool, String> {
    match std::env::var(CAPTURE_ENV) {
        Err(_) => Ok(false),
        Ok(value) => match value.trim() {
            "0" | "false" => Ok(false),
            "1" | "true" if cfg!(debug_assertions) => Ok(true),
            "1" | "true" => {
                crate::logging::warn(format!(
                    "{CAPTURE_ENV} is ignored in a release build; F1 fixture capture is development-only"
                ));
                Ok(false)
            }
            _ => Err(format!("{CAPTURE_ENV} must be 1, 0, true or false")),
        },
    }
}

pub fn validate_label(label: &str) -> Result<(), String> {
    let valid = !label.is_empty()
        && label.len() <= MAX_LABEL_CHARS
        && label
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !label.starts_with('-');
    if valid {
        Ok(())
    } else {
        Err(format!(
            "Capture label must be 1-{MAX_LABEL_CHARS} characters of a-z, 0-9 and '-', e.g. 'braking'"
        ))
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CapturedPacket {
    pub packet_id: u8,
    pub name: &'static str,
    pub file: String,
    pub size: usize,
    pub frame_identifier: u32,
    pub overall_frame_identifier: u32,
    pub session_time: f32,
    pub player_car_index: u8,
    pub age_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CaptureManifest {
    pub label: String,
    pub captured_unix_ms: u64,
    pub racelab_version: &'static str,
    pub packet_format: u16,
    pub game_major_version: u8,
    pub game_minor_version: u8,
    pub directory: String,
    pub packets: Vec<CapturedPacket>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CaptureStatus {
    pub directory: String,
    pub snapshots_taken: u32,
    pub max_snapshots: u32,
    pub last: Option<CaptureManifest>,
    pub last_error: Option<String>,
}

#[derive(Default)]
struct State {
    taken: u32,
    last: Option<CaptureManifest>,
    last_error: Option<String>,
}

pub struct FixtureCapture {
    directory: PathBuf,
    state: Mutex<State>,
}

fn file_name(kind: PacketKind) -> String {
    format!(
        "id{:02}-{}.bin",
        kind.id(),
        kind.name().to_ascii_lowercase().replace(' ', "-")
    )
}

impl FixtureCapture {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            state: Mutex::new(State::default()),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn status(&self) -> CaptureStatus {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        CaptureStatus {
            directory: self.directory.display().to_string(),
            snapshots_taken: state.taken,
            max_snapshots: MAX_SNAPSHOTS_PER_RUN,
            last: state.last.clone(),
            last_error: state.last_error.clone(),
        }
    }

    /// Writes one snapshot from `packets`, which must be exactly the four
    /// decoded families. Runs on the caller's thread; never on the receive
    /// thread.
    pub fn write(
        &self,
        label: &str,
        packets: Vec<RawLatest>,
        unix_ms: u64,
    ) -> Result<CaptureManifest, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let result = self.write_locked(&mut state, label, packets, unix_ms);
        match &result {
            Ok(manifest) => {
                state.taken += 1;
                state.last = Some(manifest.clone());
                state.last_error = None;
            }
            Err(error) => state.last_error = Some(error.clone()),
        }
        result
    }

    fn write_locked(
        &self,
        state: &mut State,
        label: &str,
        packets: Vec<RawLatest>,
        unix_ms: u64,
    ) -> Result<CaptureManifest, String> {
        validate_label(label)?;
        if state.taken >= MAX_SNAPSHOTS_PER_RUN {
            return Err(format!(
                "This run has already captured {MAX_SNAPSHOTS_PER_RUN} snapshots; restart to capture more"
            ));
        }
        let mut kinds: Vec<PacketKind> = packets.iter().map(|p| p.kind).collect();
        kinds.sort_by_key(|k| k.id());
        let mut wanted = crate::f1_live::FAMILIES.to_vec();
        wanted.sort_by_key(|k| k.id());
        if kinds != wanted {
            let missing: Vec<&str> = wanted
                .iter()
                .filter(|k| !kinds.contains(k))
                .map(|k| k.name())
                .collect();
            return Err(format!(
                "Not every packet type has arrived yet (missing: {}). Drive, then capture again.",
                missing.join(", ")
            ));
        }
        if let Some(stale) = packets.iter().find(|p| p.age_ms > MAX_PACKET_AGE_MS) {
            return Err(format!(
                "{} is {} ms old; capture needs every packet within {MAX_PACKET_AGE_MS} ms",
                stale.kind.name(),
                stale.age_ms
            ));
        }
        let first = packets[0].header;
        if packets.iter().any(|p| {
            p.header.session_uid != first.session_uid
                || p.header.player_car_index != first.player_car_index
        }) {
            return Err("Packets span a session or player change; capture again".into());
        }

        fs::create_dir_all(&self.directory)
            .map_err(|e| format!("Could not create {}: {e}", self.directory.display()))?;
        let existing = fs::read_dir(&self.directory)
            .map_err(|e| format!("Could not read {}: {e}", self.directory.display()))?
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .count();
        if existing >= MAX_SNAPSHOT_DIRECTORIES {
            return Err(format!(
                "{} already holds {existing} snapshots (limit {MAX_SNAPSHOT_DIRECTORIES}); review and delete old ones first",
                self.directory.display()
            ));
        }

        let name = format!("{unix_ms}-{label}");
        let target = self.directory.join(&name);
        let staging = self.directory.join(format!(".{name}.partial"));
        if target.exists() {
            return Err(format!("{} already exists", target.display()));
        }
        let _ = fs::remove_dir_all(&staging);
        let manifest = CaptureManifest {
            label: label.to_string(),
            captured_unix_ms: unix_ms,
            racelab_version: env!("CARGO_PKG_VERSION"),
            packet_format: first.packet_format,
            game_major_version: first.game_major_version,
            game_minor_version: first.game_minor_version,
            directory: target.display().to_string(),
            packets: packets
                .iter()
                .map(|p| CapturedPacket {
                    packet_id: p.kind.id(),
                    name: p.kind.name(),
                    file: file_name(p.kind),
                    size: p.bytes.len(),
                    frame_identifier: p.header.frame_identifier,
                    overall_frame_identifier: p.header.overall_frame_identifier,
                    session_time: p.header.session_time,
                    player_car_index: p.header.player_car_index,
                    age_ms: p.age_ms,
                })
                .collect(),
        };
        let written = (|| -> std::io::Result<()> {
            fs::create_dir(&staging)?;
            for packet in &packets {
                fs::write(staging.join(file_name(packet.kind)), &packet.bytes)?;
            }
            let json = serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?;
            fs::write(staging.join("manifest.json"), json)?;
            fs::rename(&staging, &target)
        })();
        if let Err(error) = written {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("Could not write the snapshot: {error}"));
        }
        crate::logging::info(format!(
            "F1 25 fixture snapshot written to {}",
            target.display()
        ));
        Ok(manifest)
    }
}
