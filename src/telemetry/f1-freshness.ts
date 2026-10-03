/// How old an F1 25 packet family may be and still be presented as current.
///
/// The four decoded families (Car Telemetry, Car Status, Lap Data, Motion Ex)
/// arrive independently and the backend reports each one's age. A family is
/// judged on its own age only, so one family going quiet never hides the
/// others, and nothing pretends the four share a frame.
///
/// - fresh: at most `FAMILY_FRESH_MS` old. At the verified 20 Hz a family
///   arrives every 50 ms; the captured high-speed snapshot was 441 ms old and
///   is still fresh, a whole second is not.
/// - stale: older than that, up to `FAMILY_STALE_MS`. Shown, marked "not
///   updating", never as live.
/// - unavailable: older still, or never received. Not shown at all; a value
///   seconds old is not kept on screen.
///
/// No interpolation and no hold beyond these limits.
export const FAMILY_FRESH_MS = 1000;
export const FAMILY_STALE_MS = 3000;

export type FamilyFreshness = "fresh" | "stale" | "unavailable";

export function familyFreshness(
  ageMs: number | null | undefined,
): FamilyFreshness {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0)
    return "unavailable";
  if (ageMs <= FAMILY_FRESH_MS) return "fresh";
  if (ageMs <= FAMILY_STALE_MS) return "stale";
  return "unavailable";
}
