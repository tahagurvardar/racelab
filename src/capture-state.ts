export interface PacketTimestamp {
  capture_at_us: number;
  listener_at_us: number;
  received_at_ms: number;
}

export interface CaptureSnapshot {
  revision: number;
  status: "idle" | "recording" | "stopping" | "complete" | "error";
  accepting_packets: boolean;
  label: string;
  directory: string;
  file_path: string | null;
  started_at_ms: number | null;
  duration_us: number;
  captured_packets: number;
  dropped_capture_frames: number;
  queue_capacity: number;
  packet_sizes: Record<string, number>;
  first_packet_timestamp: PacketTimestamp | null;
  last_packet_timestamp: PacketTimestamp | null;
  first_packet_hex_preview: string | null;
  last_packet_hex_preview: string | null;
  last_error: string | null;
}

export function newerCapture(
  current: CaptureSnapshot | null,
  incoming: CaptureSnapshot,
): CaptureSnapshot {
  return !current || incoming.revision > current.revision ? incoming : current;
}
