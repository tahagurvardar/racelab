import type { F1LiveStatus } from "../telemetry/f1-player.ts";
import { f1Families } from "../telemetry/f1-live-layout.ts";
import {
  familyFreshness,
  type FamilyFreshness,
} from "../telemetry/f1-freshness.ts";

export interface OverlayPreferences {
  enabled: boolean;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  scale: number;
  opacity: number;
}
export interface OverlayStatus {
  preferences: OverlayPreferences;
  editing: boolean;
  visible: boolean;
  error: string | null;
}
export interface OverlayFrame {
  state: OverlayStatus;
  f1: F1LiveStatus | null;
  fh6_active: boolean;
  sample_age_ms: number;
}
export const DEFAULT_OVERLAY: OverlayPreferences = {
  enabled: false,
  x: null,
  y: null,
  width: 440,
  height: 210,
  scale: 1,
  opacity: 0.9,
};
export const OVERLAY_UPDATE_MS = 100;
export interface OverlayReading {
  text: string;
  freshness: FamilyFreshness;
}
export interface OverlayView {
  visible: boolean;
  editing: boolean;
  note: string;
  readings: Record<
    | "gear"
    | "speed"
    | "rpm"
    | "throttle"
    | "brake"
    | "lap"
    | "sector"
    | "position"
    | "drs"
    | "ers"
    | "fuel",
    OverlayReading
  >;
}
const number = (value: number | null | undefined, digits = 0) =>
  value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);

/// Advance every family's age locally. A hung IPC or stopped webview must
/// never hold old readings as live. No interpolation, no percentages for ERS.
export function overlayView(
  frame: OverlayFrame | null,
  elapsedMs = 0,
): OverlayView {
  const live = frame?.f1?.live;
  const age = Math.max(0, elapsedMs) + (frame?.sample_age_ms ?? 0);
  const advanced =
    live == null
      ? null
      : {
          ...live,
          car_telemetry: live.car_telemetry && {
            ...live.car_telemetry,
            age_ms: live.car_telemetry.age_ms + age,
          },
          car_status: live.car_status && {
            ...live.car_status,
            age_ms: live.car_status.age_ms + age,
          },
          lap_data: live.lap_data && {
            ...live.lap_data,
            age_ms: live.lap_data.age_ms + age,
          },
          motion_ex: null,
        };
  const f = f1Families(advanced);
  const t = f.telemetry.player,
    s = f.status.player,
    l = f.lap.player;
  const read = (text: string, freshness: FamilyFreshness): OverlayReading => ({
    text,
    freshness,
  });
  const telemetry = (text: string) => read(text, f.telemetry.freshness);
  const status = (text: string) => read(text, f.status.freshness);
  const lap = (text: string) => read(text, f.lap.freshness);
  const gear = t?.gear.raw;
  const sector = l?.sector.raw;
  const editing = frame?.state.editing ?? false;
  const valid =
    frame?.f1?.enabled &&
    frame.f1.listening &&
    live?.player_available &&
    !frame.fh6_active &&
    !frame.state.error;
  const current =
    valid &&
    t != null &&
    familyFreshness(advanced?.car_telemetry?.age_ms) !== "unavailable";
  return {
    visible:
      !!frame?.state.preferences.enabled &&
      !frame.fh6_active &&
      (editing || (!!frame.state.visible && !!current)),
    editing,
    note: !current
      ? "Waiting for F1 25 telemetry"
      : [f.telemetry, f.status, f.lap].some(
            (f) => f.freshness === "stale" && f.player != null,
          )
        ? "Not updating · dimmed readings"
        : "F1 25",
    readings: {
      gear: telemetry(
        gear === -1
          ? "R"
          : gear === 0
            ? "N"
            : gear != null && gear >= 1 && gear <= 8
              ? String(gear)
              : "—",
      ),
      speed: telemetry(number(t?.speed_kmh)),
      rpm: telemetry(number(t?.engine_rpm)),
      throttle: telemetry(t?.throttle == null ? "—" : number(t.throttle * 100)),
      brake: telemetry(t?.brake == null ? "—" : number(t.brake * 100)),
      lap: lap(number(l?.current_lap_num)),
      sector: lap(
        sector != null && sector >= 0 && sector <= 2 ? String(sector + 1) : "—",
      ),
      position: lap(number(l?.car_position)),
      drs: telemetry(t?.drs.raw === 1 ? "ON" : t?.drs.raw === 0 ? "OFF" : "—"),
      ers: status(
        s?.ers_store_energy_j == null
          ? "—"
          : `${number(s.ers_store_energy_j / 1e6, 2)} MJ`,
      ),
      fuel: status(number(s?.fuel_in_tank, 1)),
    },
  };
}
