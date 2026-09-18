//! RLCAP v1: schema-free binary datagrams. See docs/RAW-CAPTURE-FORMAT.md.
use crate::packet::{CapturedPacket, PacketSink};
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV6};

const MAGIC: &[u8; 8] = b"RLCAP\r\n\0";
pub const MAX_PACKET_BYTES: usize = 65_535;
pub const MAX_LABEL_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawPacket {
    /// Monotonic microseconds since Start Capture, sampled at the sink boundary.
    pub capture_at_us: u64,
    /// Original, unmodified listener-session timestamp from PacketSink.
    pub listener_at_us: u64,
    pub received_at_ms: u64,
    pub source: SocketAddr,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureHeader {
    pub label: String,
    pub started_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureEnd {
    pub duration_us: u64,
    pub dropped_capture_frames: u64,
    pub captured_packets: u64,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn read_bytes<const N: usize>(reader: &mut impl Read) -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

pub fn write_header(writer: &mut impl Write, header: &CaptureHeader) -> io::Result<()> {
    if header.label.is_empty() || header.label.len() > MAX_LABEL_BYTES {
        return Err(invalid("Capture label must be 1..=256 UTF-8 bytes"));
    }
    writer.write_all(MAGIC)?;
    writer.write_all(&1_u32.to_le_bytes())?;
    writer.write_all(&(header.label.len() as u32).to_le_bytes())?;
    writer.write_all(&header.started_at_ms.to_le_bytes())?;
    writer.write_all(header.label.as_bytes())
}

pub fn write_packet(writer: &mut impl Write, packet: &RawPacket) -> io::Result<()> {
    if packet.bytes.len() > MAX_PACKET_BYTES {
        return Err(invalid("Datagram exceeds capture format limit"));
    }
    writer.write_all(&[1])?;
    writer.write_all(&packet.capture_at_us.to_le_bytes())?;
    writer.write_all(&packet.listener_at_us.to_le_bytes())?;
    writer.write_all(&packet.received_at_ms.to_le_bytes())?;
    let (family, ip, flow, scope) = match packet.source {
        SocketAddr::V4(address) => {
            let mut bytes = [0; 16];
            bytes[..4].copy_from_slice(&address.ip().octets());
            (4, bytes, 0, 0)
        }
        SocketAddr::V6(address) => (
            6,
            address.ip().octets(),
            address.flowinfo(),
            address.scope_id(),
        ),
    };
    writer.write_all(&[family])?;
    writer.write_all(&ip)?;
    writer.write_all(&packet.source.port().to_le_bytes())?;
    writer.write_all(&flow.to_le_bytes())?;
    writer.write_all(&scope.to_le_bytes())?;
    writer.write_all(&(packet.bytes.len() as u32).to_le_bytes())?;
    writer.write_all(&packet.bytes)
}

pub fn write_end(writer: &mut impl Write, end: &CaptureEnd) -> io::Result<()> {
    writer.write_all(&[2])?;
    writer.write_all(&end.duration_us.to_le_bytes())?;
    writer.write_all(&end.dropped_capture_frames.to_le_bytes())?;
    writer.write_all(&end.captured_packets.to_le_bytes())
}

/// Streaming reader; memory is bounded to one datagram. Consume through `None`
/// to validate the mandatory footer. Missing/truncated footers are errors.
pub struct CaptureReader<R> {
    reader: R,
    pub header: CaptureHeader,
    pub end: Option<CaptureEnd>,
    count: u64,
    last_time: u64,
}

impl<R: Read> CaptureReader<R> {
    pub fn new(mut reader: R) -> io::Result<Self> {
        if &read_bytes::<8>(&mut reader)? != MAGIC
            || u32::from_le_bytes(read_bytes(&mut reader)?) != 1
        {
            return Err(invalid("Unsupported capture magic/version"));
        }
        let label_len = u32::from_le_bytes(read_bytes(&mut reader)?) as usize;
        if label_len == 0 || label_len > MAX_LABEL_BYTES {
            return Err(invalid("Invalid capture label length"));
        }
        let started_at_ms = u64::from_le_bytes(read_bytes(&mut reader)?);
        let mut label = vec![0; label_len];
        reader.read_exact(&mut label)?;
        let label = String::from_utf8(label).map_err(|_| invalid("Invalid UTF-8 label"))?;
        Ok(Self {
            reader,
            header: CaptureHeader {
                label,
                started_at_ms,
            },
            end: None,
            count: 0,
            last_time: 0,
        })
    }

    pub fn next_packet(&mut self) -> io::Result<Option<RawPacket>> {
        if self.end.is_some() {
            return Ok(None);
        }
        match read_bytes::<1>(&mut self.reader)?[0] {
            1 => {
                let capture_at_us = u64::from_le_bytes(read_bytes(&mut self.reader)?);
                let listener_at_us = u64::from_le_bytes(read_bytes(&mut self.reader)?);
                let received_at_ms = u64::from_le_bytes(read_bytes(&mut self.reader)?);
                let family = read_bytes::<1>(&mut self.reader)?[0];
                let ip = read_bytes::<16>(&mut self.reader)?;
                let port = u16::from_le_bytes(read_bytes(&mut self.reader)?);
                let flow = u32::from_le_bytes(read_bytes(&mut self.reader)?);
                let scope = u32::from_le_bytes(read_bytes(&mut self.reader)?);
                let source = match family {
                    4 if ip[4..] == [0; 12] && flow == 0 && scope == 0 => {
                        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3])), port)
                    }
                    6 => SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::from(ip), port, flow, scope)),
                    _ => return Err(invalid("Invalid capture source address")),
                };
                let len = u32::from_le_bytes(read_bytes(&mut self.reader)?) as usize;
                if len > MAX_PACKET_BYTES || capture_at_us < self.last_time {
                    return Err(invalid(
                        "Invalid packet length or decreasing capture timestamp",
                    ));
                }
                let mut bytes = vec![0; len];
                self.reader.read_exact(&mut bytes)?;
                self.last_time = capture_at_us;
                self.count += 1;
                Ok(Some(RawPacket {
                    capture_at_us,
                    listener_at_us,
                    received_at_ms,
                    source,
                    bytes,
                }))
            }
            2 => {
                let end = CaptureEnd {
                    duration_us: u64::from_le_bytes(read_bytes(&mut self.reader)?),
                    dropped_capture_frames: u64::from_le_bytes(read_bytes(&mut self.reader)?),
                    captured_packets: u64::from_le_bytes(read_bytes(&mut self.reader)?),
                };
                if end.captured_packets != self.count || end.duration_us < self.last_time {
                    return Err(invalid("Capture footer does not match records"));
                }
                let mut trailing = [0];
                if self.reader.read(&mut trailing)? != 0 {
                    return Err(invalid("Unexpected bytes after capture footer"));
                }
                self.end = Some(end);
                Ok(None)
            }
            _ => Err(invalid("Unknown capture record type")),
        }
    }
}

/// Offline, unpaced replay (no sockets, sleeping, wall-clock substitutions or parsing).
/// Check the return value: malformed files can fail after a valid prefix was delivered.
/// `captured_at_us` uses the capture-session clock; the reader also exposes the
/// original listener clock for tools that need it.
pub fn replay<R: Read>(reader: R, sink: &dyn PacketSink) -> io::Result<CaptureEnd> {
    let mut capture = CaptureReader::new(reader)?;
    while let Some(packet) = capture.next_packet()? {
        sink.on_packet(&CapturedPacket {
            bytes: &packet.bytes,
            source: packet.source,
            received_at_ms: packet.received_at_ms,
            captured_at_us: packet.capture_at_us,
        });
    }
    capture.end.ok_or_else(|| invalid("Missing capture footer"))
}
