/// Single source of truth for every unit conversion and nullable rendering in
/// the dashboard. Components never convert; they render strings produced here.
///
/// Rules this module enforces:
/// - An unavailable measurement renders as `UNAVAILABLE`, never as 0.
/// - A measured 0 renders as "0", because 0 is a real reading.
/// - Conversions are exact presentation arithmetic on canonical values. The
///   canonical value itself is never mutated or rounded in application state.

export const UNAVAILABLE = "—";

/// Standard gravity, the exact CGPM 1901 definition. Used only to present
/// canonical m/s² in g; the canonical acceleration stays in m/s².
export const STANDARD_GRAVITY_MPS2 = 9.80665;

/// Exactly 3600 s/h over 1000 m/km.
export const MPS_TO_KMH = 3.6;

export type Nullable = number | null | undefined;

function usable(raw: Nullable): raw is number {
  return raw != null && Number.isFinite(raw);
}

export function number(raw: Nullable, digits = 1): string {
  return usable(raw) ? raw.toFixed(digits) : UNAVAILABLE;
}

/// m/s -> km/h. Presentation only.
export function speedKmh(mps: Nullable, digits = 0): string {
  return usable(mps) ? (mps * MPS_TO_KMH).toFixed(digits) : UNAVAILABLE;
}

/// m/s² -> g. Presentation only; the axis is never renamed.
export function gForce(mps2: Nullable, digits = 2): string {
  return usable(mps2)
    ? (mps2 / STANDARD_GRAVITY_MPS2).toFixed(digits)
    : UNAVAILABLE;
}

/// W -> kW. Presentation only: canonical power stays in watts. Exactly 1000 W
/// per kW, so this asserts nothing beyond the established canonical unit.
export function kilowatts(watts: Nullable, digits = 1): string {
  return usable(watts) ? (watts / 1000).toFixed(digits) : UNAVAILABLE;
}

/// m -> mm. Presentation only; suspension travel is canonically metres and
/// spans a few centimetres, which is unreadable at metre precision.
export function millimetres(metres: Nullable, digits = 1): string {
  return usable(metres) ? (metres * 1000).toFixed(digits) : UNAVAILABLE;
}

/// rad/s -> rev/min for a rotating wheel. Presentation only.
export function revolutionsPerMinute(radiansPerSecond: Nullable): string {
  return usable(radiansPerSecond)
    ? ((radiansPerSecond * 60) / (2 * Math.PI)).toFixed(0)
    : UNAVAILABLE;
}

/// Normalized 0..1 (or -1..1) -> percent. A signed input keeps its sign, so
/// left steering stays visibly negative.
export function percent(normalized: Nullable, digits = 0): string {
  return usable(normalized) ? (normalized * 100).toFixed(digits) : UNAVAILABLE;
}

/// Clamped 0..100 magnitude for bar widths only. Never used for a printed
/// value: a reading outside the declared range must stay visible as a number.
export function barPercent(normalized: Nullable): number {
  if (!usable(normalized)) return 0;
  return Math.min(100, Math.abs(normalized) * 100);
}

/// radians -> degrees. Presentation only.
export function degrees(radians: Nullable, digits = 1): string {
  return usable(radians)
    ? ((radians * 180) / Math.PI).toFixed(digits)
    : UNAVAILABLE;
}

/// Seconds -> m:ss.mmm. Values below zero are not a lap time and stay
/// unavailable rather than being rendered as a negative clock.
export function lapTime(seconds: Nullable): string {
  if (!usable(seconds) || seconds < 0) return UNAVAILABLE;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

/// Milliseconds since the start of a session -> m:ss.mmm. This is an offset
/// into a recording, not a lap time and not a clock time: derived analysis
/// reports session-relative monotonic milliseconds and this is how they read.
export function offsetClock(milliseconds: Nullable): string {
  if (!usable(milliseconds) || milliseconds < 0) return UNAVAILABLE;
  const total = Math.round(milliseconds);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const rest = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
}

/// Seconds -> h:mm:ss / m:ss. For elapsed wall time, not lap timing.
export function elapsed(seconds: Nullable): string {
  if (!usable(seconds) || seconds < 0) return UNAVAILABLE;
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}`
    : `${minutes}:${secs}`;
}

/// A counted quantity, grouped for the reader's locale.
export function integer(raw: Nullable): string {
  return usable(raw) ? Math.trunc(raw).toLocaleString() : UNAVAILABLE;
}

/// An identifier, port or opaque code. Never grouped: digit grouping would
/// imply a magnitude that an identifier does not have.
export function code(raw: Nullable): string {
  return usable(raw) ? String(Math.trunc(raw)) : UNAVAILABLE;
}

export function text(raw: string | null | undefined): string {
  return raw == null || raw === "" ? UNAVAILABLE : raw;
}

export function hertz(raw: Nullable): string {
  return usable(raw) ? `${raw.toFixed(1)} Hz` : UNAVAILABLE;
}

export function ageMs(raw: Nullable): string {
  return usable(raw) ? `${Math.trunc(raw).toLocaleString()} ms` : UNAVAILABLE;
}

/// Position within an inclusive range, 0..100, for a progress bar. Returns null
/// when the range is unavailable or degenerate, so no bar is drawn at all
/// rather than a misleading empty one.
export function rangeFraction(
  value: Nullable,
  low: Nullable,
  high: Nullable,
): number | null {
  if (!usable(value) || !usable(low) || !usable(high) || high <= low) {
    return null;
  }
  return Math.min(100, Math.max(0, ((value - low) / (high - low)) * 100));
}
