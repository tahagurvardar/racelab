/// The frontend's one F1 25 corner lookup.
///
/// F1 25 sends every wheel array as RL, RR, FL, FR. The backend turns that
/// wire order into named corners in exactly one place
/// (`Wheels::from_wire` in `adapters/f1_25.rs`), confirmed on real captures:
/// higher pressures and hotter brakes on the fronts, drive force on the
/// rears, load on the outside wheels in a right-hand turn. This module reads
/// those names into the presentation order — front left, front right, rear
/// left, rear right — and nothing else in the frontend indexes an F1 wheel.
///
/// It shares nothing with the Forza Horizon 6 corner mapping
/// (`telemetry-view-model.ts`), which rests on different evidence.

/// An F1 25 per-wheel value set as the backend serializes it: already named
/// corners, never wire positions.
export interface Wheels<T> {
  rear_left: T;
  rear_right: T;
  front_left: T;
  front_right: T;
}

export type F1Corner = "FL" | "FR" | "RL" | "RR";

/// Presentation order: the front axle first, left before right.
export const F1_CORNERS: readonly F1Corner[] = ["FL", "FR", "RL", "RR"];

export const F1_CORNER_LABELS: Record<F1Corner, string> = {
  FL: "Front left",
  FR: "Front right",
  RL: "Rear left",
  RR: "Rear right",
};

const F1_CORNER_FIELDS: Record<F1Corner, keyof Wheels<unknown>> = {
  FL: "front_left",
  FR: "front_right",
  RL: "rear_left",
  RR: "rear_right",
};

export function f1Wheel<T>(wheels: Wheels<T>, corner: F1Corner): T {
  return wheels[F1_CORNER_FIELDS[corner]];
}

/// The four values in presentation order, each with its corner.
export function f1WheelValues<T>(
  wheels: Wheels<T>,
): { corner: F1Corner; label: string; value: T }[] {
  return F1_CORNERS.map((corner) => ({
    corner,
    label: F1_CORNER_LABELS[corner],
    value: f1Wheel(wheels, corner),
  }));
}
