//! Development tool for F1 25 fixtures (V2.0 Phase B). Not shipped.
//!
//!   f1_fixture capture <label> [--delay-ms N] [--out DIR] [--port P]
//!       Binds 127.0.0.1:20777 (RaceLab must not be running), waits for the
//!       four decoded packet families, then writes ONE bounded snapshot with
//!       the same code path as the app. Requires RACELAB_F1_CAPTURE=1.
//!   f1_fixture inspect <file.bin>...
//!       Classifies and decodes each datagram and prints the player values.
//!   f1_fixture sanitize <in.bin> <out.bin>
//!       Copies a datagram with its sessionUID replaced by SANITIZED_UID.
//!       Nothing else is changed; the result must still classify identically.
use racelab_lib::{
    adapters::f1_25::{
        self, car_status, car_telemetry, classify, lap_data, motion_ex, offset, Classification,
        PacketKind,
    },
    f1_capture,
    f1_evidence::F1EvidenceService,
};
use std::{
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

/// "RACELAB!" in ASCII, little endian. Replaces the game's session UID in
/// committed fixtures.
const SANITIZED_UID: u64 = u64::from_le_bytes(*b"RACELAB!");

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("capture") => capture(&args[1..]),
        Some("inspect") => inspect(&args[1..]),
        Some("sanitize") => sanitize(&args[1..]),
        _ => Err("usage: f1_fixture capture|inspect|sanitize ...".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

fn capture(args: &[String]) -> Result<(), String> {
    let label = args.first().ok_or("capture needs a label")?;
    if !f1_capture::enabled_from_environment()? {
        return Err("Set RACELAB_F1_CAPTURE=1 to capture (debug builds only)".into());
    }
    let delay_ms: u64 = flag(args, "--delay-ms")
        .map(|v| v.parse().map_err(|_| "--delay-ms must be an integer"))
        .transpose()?
        .unwrap_or(0);
    let port: u16 = flag(args, "--port")
        .map(|v| v.parse().map_err(|_| "--port must be an integer"))
        .transpose()?
        .unwrap_or(f1_25::DEFAULT_PORT);
    let out = flag(args, "--out")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("target/dev-f1-fixtures"));
    let service = F1EvidenceService::new(true, port).with_capture(out);
    service.start()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let live = service.status().live;
        if live.car_telemetry.is_some()
            && live.car_status.is_some()
            && live.lap_data.is_some()
            && live.motion_ex.is_some()
        {
            break;
        }
        if Instant::now() > deadline {
            let _ = service.stop();
            return Err("No complete set of packets within 10 s; is the car on track?".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let result = service.capture_fixtures(label, delay_ms);
    let _ = service.stop();
    let manifest = result?;
    println!(
        "{}",
        serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn inspect(files: &[String]) -> Result<(), String> {
    for file in files {
        let bytes = std::fs::read(file).map_err(|e| format!("{file}: {e}"))?;
        println!("== {file} ({} bytes)", bytes.len());
        let kind = match classify(&bytes) {
            Classification::Accepted { kind, header } => {
                println!(
                    "{} | frame {} overall {} | t {:.3} s | player {} secondary {}",
                    kind.name(),
                    header.frame_identifier,
                    header.overall_frame_identifier,
                    header.session_time,
                    header.player_car_index,
                    header.secondary_player_car_index
                );
                kind
            }
            Classification::Rejected { rejection, .. } => {
                println!("rejected: {rejection:?}");
                continue;
            }
        };
        let json = match kind {
            PacketKind::CarTelemetry => car_telemetry::decode(&bytes)
                .map(|(_, p)| serde_json::to_string_pretty(&p).unwrap_or_default()),
            PacketKind::CarStatus => car_status::decode(&bytes)
                .map(|(_, p)| serde_json::to_string_pretty(&p).unwrap_or_default()),
            PacketKind::LapData => lap_data::decode(&bytes)
                .map(|(_, p)| serde_json::to_string_pretty(&p).unwrap_or_default()),
            PacketKind::MotionEx => motion_ex::decode(&bytes)
                .map(|(_, p)| serde_json::to_string_pretty(&p).unwrap_or_default()),
            _ => Ok("(no Phase B decoder for this packet type)".into()),
        }
        .map_err(|e| format!("{file}: {e:?}"))?;
        println!("{json}");
    }
    Ok(())
}

fn sanitize(args: &[String]) -> Result<(), String> {
    let [input, output] = args else {
        return Err("sanitize needs <in.bin> <out.bin>".into());
    };
    let mut bytes = std::fs::read(input).map_err(|e| format!("{input}: {e}"))?;
    let before = classify(&bytes);
    let Classification::Accepted { kind, .. } = before else {
        return Err(format!(
            "{input} is not an accepted F1 25 packet: {before:?}"
        ));
    };
    bytes[offset::SESSION_UID..offset::SESSION_UID + 8]
        .copy_from_slice(&SANITIZED_UID.to_le_bytes());
    match classify(&bytes) {
        Classification::Accepted {
            kind: after,
            header,
        } if after == kind => {
            assert_eq!(header.session_uid, SANITIZED_UID);
        }
        other => {
            return Err(format!(
                "sanitized packet changed classification: {other:?}"
            ))
        }
    }
    std::fs::write(output, &bytes).map_err(|e| format!("{output}: {e}"))?;
    println!("{output}: {} with sessionUID replaced", kind.name());
    Ok(())
}
