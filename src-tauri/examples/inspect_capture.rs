//! Validate all records/footer and reconstruct a summary without trusting a sidecar.
use racelab_lib::capture_format::CaptureReader;
use std::{collections::BTreeMap, fs::File, io::BufReader};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or("Usage: inspect_capture <file.rlcap>")?;
    let mut reader = CaptureReader::new(BufReader::new(File::open(path)?))?;
    let mut sizes = BTreeMap::<usize, u64>::new();
    let mut first = None;
    let mut last = None;
    while let Some(packet) = reader.next_packet()? {
        *sizes.entry(packet.bytes.len()).or_default() += 1;
        let preview = serde_json::json!({
            "capture_at_us": packet.capture_at_us, "listener_at_us": packet.listener_at_us,
            "received_at_ms": packet.received_at_ms, "source": packet.source.to_string(),
            "original_length": packet.bytes.len(),
            "hex_preview": packet.bytes.iter().take(32).map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(" ")
        });
        if first.is_none() {
            first = Some(preview.clone());
        }
        last = Some(preview);
    }
    let end = reader.end.ok_or("Missing footer")?;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "label": reader.header.label, "started_at_ms": reader.header.started_at_ms,
            "duration_us": end.duration_us, "captured_packets": end.captured_packets,
            "dropped_capture_frames": end.dropped_capture_frames, "packet_sizes": sizes,
            "first_packet": first, "last_packet": last,
            "complete_file": true, "loss_free_capture": end.dropped_capture_frames == 0
        }))?
    );
    Ok(())
}
