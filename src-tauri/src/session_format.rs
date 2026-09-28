//! RLFRAMES v1 normalized session storage. See docs/V0.6-SESSION-FORMAT.md and
//! docs/V0.8-TELEMETRY-SCHEMA.md. The container framing is version 1; the
//! canonical frame payload it carries is separately versioned and is now 2.
//! Stores canonical `TelemetryFrame` records, never raw game datagrams.
use crate::{
    session_summary::SessionSummaryV1, telemetry::TelemetryFrame, telemetry_v1::StoredFrameV1,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Read, Write},
    path::{Path, PathBuf},
};

const MAGIC: &[u8; 8] = b"RLFRM\r\n\0";
/// Container framing version. Bump only for framing/record-envelope changes.
pub const FRAME_FORMAT_VERSION: u32 = 1;
/// Canonical `TelemetryFrame` schema version *written* by this build. Bump when
/// canonical fields change. The container framing above is independent of it.
pub const TELEMETRY_FRAME_SCHEMA_VERSION: u32 = 2;
/// Canonical schema versions this build can *read*. Old recordings are decoded
/// through a frozen compatibility struct and converted; they are never
/// rewritten, and an unlisted version is rejected rather than guessed at.
pub const SUPPORTED_TELEMETRY_FRAME_SCHEMA_VERSIONS: &[u32] = &[1, 2];

pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
/// One canonical frame, including its source-specific envelope, stays far below
/// this. The guard bounds reader memory on a truncated or corrupt file.
pub const MAX_RECORD_BYTES: usize = 1 << 20;
pub const MAX_SESSION_ID_BYTES: usize = 128;
pub const FRAME_FILE_NAME: &str = "frames.rlframes";
pub const MANIFEST_FILE_NAME: &str = "manifest.json";

pub fn supports_telemetry_frame_schema(version: u32) -> bool {
    SUPPORTED_TELEMETRY_FRAME_SCHEMA_VERSIONS.contains(&version)
}

pub fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Session IDs become directory names. Only the `SessionEngine` alphabet is
/// accepted; a foreign or crafted ID must never escape the sessions root.
pub fn is_safe_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_SESSION_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Recording,
    Completed,
    Interrupted,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recording => "recording",
            Self::Completed => "completed",
            Self::Interrupted => "interrupted",
        }
    }
}

/// Human-readable, versioned session metadata. Recent Sessions and Session
/// Details are served from this file alone; frame bodies are never decoded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionManifestV1 {
    pub schema_version: u32,
    pub session_id: String,
    pub status: SessionStatus,
    pub game: Option<String>,
    pub protocol: Option<String>,
    pub vehicle_id: Option<String>,
    pub started_at_unix_ms: Option<u64>,
    pub ended_at_unix_ms: Option<u64>,
    /// Monotonic session duration owned by `SessionEngine`; includes grace.
    pub duration_us: u64,
    pub frame_count: u64,
    pub active_frame_count: u64,
    pub inactive_frame_count: u64,
    pub recorder_dropped_frames: u64,
    pub completion_reason: Option<String>,
    pub frame_file: String,
    pub frame_format_version: u32,
    pub telemetry_frame_schema_version: u32,
    /// Absent while recording and for interrupted sessions: incomplete data
    /// must never present itself as a finished summary.
    pub summary: Option<SessionSummaryV1>,
    pub created_by_racelab_version: String,
}

impl SessionManifestV1 {
    pub fn new(session_id: String, started_at_unix_ms: Option<u64>) -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            session_id,
            status: SessionStatus::Recording,
            game: None,
            protocol: None,
            vehicle_id: None,
            started_at_unix_ms,
            ended_at_unix_ms: None,
            duration_us: 0,
            frame_count: 0,
            active_frame_count: 0,
            inactive_frame_count: 0,
            recorder_dropped_frames: 0,
            completion_reason: None,
            frame_file: FRAME_FILE_NAME.into(),
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            summary: None,
            created_by_racelab_version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

/// Temp file + rename. A reader either sees the previous manifest or the new
/// one, never a partially written file, and never an unfinished "completed".
pub fn write_manifest_atomically(directory: &Path, manifest: &SessionManifestV1) -> io::Result<()> {
    let target = directory.join(MANIFEST_FILE_NAME);
    let temporary = directory.join("manifest.json.tmp");
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, manifest)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&temporary, &target)
}

pub fn read_manifest(directory: &Path) -> io::Result<SessionManifestV1> {
    let bytes = fs::read(directory.join(MANIFEST_FILE_NAME))?;
    let manifest: SessionManifestV1 =
        serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(invalid(format!(
            "Unsupported manifest schema version {}",
            manifest.schema_version
        )));
    }
    // The manifest advertises the versions of the stream it describes. A
    // manifest this build cannot interpret is rejected here rather than being
    // listed with fields that may no longer mean what this build assumes.
    if manifest.frame_format_version != FRAME_FORMAT_VERSION {
        return Err(invalid(format!(
            "Unsupported frame stream version {}",
            manifest.frame_format_version
        )));
    }
    if !supports_telemetry_frame_schema(manifest.telemetry_frame_schema_version) {
        return Err(invalid(format!(
            "Unsupported telemetry frame schema version {}",
            manifest.telemetry_frame_schema_version
        )));
    }
    Ok(manifest)
}

/// One stored canonical frame, always in this build's current canonical
/// schema. Decoding target; the writer serializes a borrowed equivalent so
/// ingestion never clones a frame. A record read from an older schema is
/// converted into this shape by `decode_record`, so callers never branch on a
/// stored schema version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecordedFrame {
    /// Hub publication sequence; strictly increasing within a session.
    pub sequence: u64,
    /// Capture monotonic milliseconds, the authoritative timing source for all
    /// duration statistics. Never derived from wall-clock time.
    pub monotonic_ms: u64,
    pub frame: TelemetryFrame,
}

#[derive(Serialize)]
struct RecordedFrameRef<'a> {
    sequence: u64,
    monotonic_ms: u64,
    frame: &'a TelemetryFrame,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameStreamHeader {
    pub frame_format_version: u32,
    pub telemetry_frame_schema_version: u32,
    pub session_id: String,
    pub started_at_unix_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameStreamEnd {
    pub frame_count: u64,
    pub duration_us: u64,
    pub recorder_dropped_frames: u64,
}

/// The one place a stored schema version turns into the current canonical
/// frame. Schema 2 is this build's own shape; schema 1 is decoded through the
/// frozen `telemetry_v1` structs and converted, preserving every V1 value and
/// leaving every V2-only field unavailable. Nothing on disk is modified.
fn decode_record(schema_version: u32, payload: &[u8]) -> io::Result<RecordedFrame> {
    let failed =
        |error: rmp_serde::decode::Error| invalid(format!("Could not decode frame: {error}"));
    match schema_version {
        TELEMETRY_FRAME_SCHEMA_VERSION => rmp_serde::from_slice(payload).map_err(failed),
        1 => {
            let stored: StoredFrameV1 = rmp_serde::from_slice(payload).map_err(failed)?;
            Ok(RecordedFrame {
                sequence: stored.sequence,
                monotonic_ms: stored.monotonic_ms,
                frame: TelemetryFrame::from(stored.frame),
            })
        }
        other => Err(invalid(format!(
            "Unsupported telemetry frame schema version {other}"
        ))),
    }
}

const RECORD_TAG: u8 = 1;
const END_TAG: u8 = 2;

pub fn write_stream_header(writer: &mut impl Write, header: &FrameStreamHeader) -> io::Result<()> {
    if !is_safe_session_id(&header.session_id) {
        return Err(invalid("Unsupported session identifier"));
    }
    writer.write_all(MAGIC)?;
    writer.write_all(&header.frame_format_version.to_le_bytes())?;
    writer.write_all(&header.telemetry_frame_schema_version.to_le_bytes())?;
    writer.write_all(&(header.session_id.len() as u32).to_le_bytes())?;
    writer.write_all(&header.started_at_unix_ms.to_le_bytes())?;
    writer.write_all(header.session_id.as_bytes())
}

/// Length-prefixed MessagePack record. Named MessagePack keeps null canonical
/// fields null and preserves the adapter's source-specific envelope verbatim.
pub fn write_frame(
    writer: &mut impl Write,
    sequence: u64,
    monotonic_ms: u64,
    frame: &TelemetryFrame,
) -> io::Result<()> {
    let payload = rmp_serde::to_vec_named(&RecordedFrameRef {
        sequence,
        monotonic_ms,
        frame,
    })
    .map_err(|error| invalid(format!("Could not encode telemetry frame: {error}")))?;
    if payload.len() > MAX_RECORD_BYTES {
        return Err(invalid("Encoded telemetry frame exceeds the record limit"));
    }
    writer.write_all(&[RECORD_TAG])?;
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)
}

pub fn write_stream_end(writer: &mut impl Write, end: &FrameStreamEnd) -> io::Result<()> {
    writer.write_all(&[END_TAG])?;
    writer.write_all(&end.frame_count.to_le_bytes())?;
    writer.write_all(&end.duration_us.to_le_bytes())?;
    writer.write_all(&end.recorder_dropped_frames.to_le_bytes())
}

/// Streaming reader; memory is bounded to one record. Unlike RLCAP the footer
/// is optional, because a crashed session keeps an append-only prefix that must
/// still be readable. `end` is `None` for such a file.
pub struct FrameStreamReader<R> {
    reader: R,
    pub header: FrameStreamHeader,
    pub end: Option<FrameStreamEnd>,
    finished: bool,
    count: u64,
    last_monotonic_ms: u64,
}

fn read_bytes<const N: usize>(reader: &mut impl Read) -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

impl<R: Read> FrameStreamReader<R> {
    pub fn new(mut reader: R) -> io::Result<Self> {
        if &read_bytes::<8>(&mut reader)? != MAGIC {
            return Err(invalid("Unsupported frame stream magic"));
        }
        let frame_format_version = u32::from_le_bytes(read_bytes(&mut reader)?);
        if frame_format_version != FRAME_FORMAT_VERSION {
            return Err(invalid(format!(
                "Unsupported frame stream version {frame_format_version}"
            )));
        }
        let telemetry_frame_schema_version = u32::from_le_bytes(read_bytes(&mut reader)?);
        // A *future* canonical `TelemetryFrame` is still not decoded on a
        // best-effort basis: named MessagePack would silently drop or default
        // unknown fields, which is exactly the silent compatibility assumption
        // this reader must never make. Known past schemas are different: each
        // has its own frozen decode target, so nothing is guessed.
        if !supports_telemetry_frame_schema(telemetry_frame_schema_version) {
            return Err(invalid(format!(
                "Unsupported telemetry frame schema version {telemetry_frame_schema_version}"
            )));
        }
        let id_len = u32::from_le_bytes(read_bytes(&mut reader)?) as usize;
        if id_len == 0 || id_len > MAX_SESSION_ID_BYTES {
            return Err(invalid("Invalid session identifier length"));
        }
        let started_at_unix_ms = u64::from_le_bytes(read_bytes(&mut reader)?);
        let mut id = vec![0; id_len];
        reader.read_exact(&mut id)?;
        let session_id =
            String::from_utf8(id).map_err(|_| invalid("Invalid UTF-8 session identifier"))?;
        if !is_safe_session_id(&session_id) {
            return Err(invalid("Unsupported session identifier"));
        }
        Ok(Self {
            reader,
            header: FrameStreamHeader {
                frame_format_version,
                telemetry_frame_schema_version,
                session_id,
                started_at_unix_ms,
            },
            end: None,
            finished: false,
            count: 0,
            last_monotonic_ms: 0,
        })
    }

    pub fn next_frame(&mut self) -> io::Result<Option<RecordedFrame>> {
        if self.finished {
            return Ok(None);
        }
        let mut tag = [0];
        // A truncated (crashed) stream ends cleanly here, without a footer.
        if self.reader.read(&mut tag)? == 0 {
            self.finished = true;
            return Ok(None);
        }
        match tag[0] {
            RECORD_TAG => {
                let len = u32::from_le_bytes(read_bytes(&mut self.reader)?) as usize;
                if len > MAX_RECORD_BYTES {
                    return Err(invalid("Frame record exceeds the record limit"));
                }
                let mut payload = vec![0; len];
                self.reader.read_exact(&mut payload)?;
                let record = decode_record(self.header.telemetry_frame_schema_version, &payload)?;
                if record.monotonic_ms < self.last_monotonic_ms {
                    return Err(invalid("Decreasing monotonic frame timestamp"));
                }
                self.last_monotonic_ms = record.monotonic_ms;
                self.count += 1;
                Ok(Some(record))
            }
            END_TAG => {
                let end = FrameStreamEnd {
                    frame_count: u64::from_le_bytes(read_bytes(&mut self.reader)?),
                    duration_us: u64::from_le_bytes(read_bytes(&mut self.reader)?),
                    recorder_dropped_frames: u64::from_le_bytes(read_bytes(&mut self.reader)?),
                };
                if end.frame_count != self.count {
                    return Err(invalid("Frame stream footer does not match records"));
                }
                self.finished = true;
                self.end = Some(end);
                Ok(None)
            }
            _ => Err(invalid("Unknown frame stream record type")),
        }
    }
}

/// Internal reader used by tests and future offline analysis. Deliberately not
/// exposed through a Tauri command: React never receives a frame array.
pub fn read_all_frames(path: &Path) -> io::Result<(FrameStreamHeader, Vec<RecordedFrame>)> {
    let mut reader = FrameStreamReader::new(io::BufReader::new(File::open(path)?))?;
    let mut frames = Vec::new();
    while let Some(frame) = reader.next_frame()? {
        frames.push(frame);
    }
    Ok((reader.header, frames))
}

/// Owns the open frame file for one session. Only the recorder writer thread
/// constructs or touches this type.
pub struct FrameStreamWriter {
    writer: BufWriter<File>,
    path: PathBuf,
}

impl FrameStreamWriter {
    pub fn create(directory: &Path, header: &FrameStreamHeader) -> io::Result<Self> {
        let path = directory.join(FRAME_FILE_NAME);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let mut writer = BufWriter::new(file);
        write_stream_header(&mut writer, header)?;
        writer.flush()?;
        Ok(Self { writer, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn write(
        &mut self,
        sequence: u64,
        monotonic_ms: u64,
        frame: &TelemetryFrame,
    ) -> io::Result<()> {
        write_frame(&mut self.writer, sequence, monotonic_ms, frame)
    }

    pub fn finish(mut self, end: &FrameStreamEnd) -> io::Result<()> {
        write_stream_end(&mut self.writer, end)?;
        self.writer.flush()?;
        self.writer.get_ref().sync_all()
    }

    /// Flush without a footer, so a checkpointed manifest never describes more
    /// frames than the frame file actually holds on disk.
    pub fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}
