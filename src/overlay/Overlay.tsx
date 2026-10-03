import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { startLatestPolling } from "../latest-poller.ts";
import {
  DEFAULT_OVERLAY,
  OVERLAY_UPDATE_MS,
  overlayView,
  type OverlayFrame,
  type OverlayReading,
} from "./model.ts";

function Reading({
  label,
  reading,
  unit = "",
}: {
  label: string;
  reading: OverlayReading;
  unit?: string;
}) {
  return (
    <div
      className={`overlay-reading overlay-${label.toLowerCase()}`}
      data-freshness={reading.freshness}
    >
      <dt>{label}</dt>
      <dd>
        {reading.text}
        {unit && <small>{unit}</small>}
      </dd>
    </div>
  );
}

export default function Overlay() {
  const latest = useRef<{ frame: OverlayFrame; at: number } | null>(null);
  const [paint, setPaint] = useState<{
    frame: OverlayFrame | null;
    elapsed: number;
  }>({ frame: null, elapsed: 0 });
  useEffect(() => {
    const stop = startLatestPolling(
      () => invoke<OverlayFrame>("get_overlay_frame"),
      (frame) => {
        latest.current = { frame, at: performance.now() };
      },
      () => {
        /* Keep aging the previous sample; it expires at the same cutoff. */
      },
      OVERLAY_UPDATE_MS,
    );
    const timer = setInterval(() => {
      const sample = latest.current;
      setPaint({
        frame: sample?.frame ?? null,
        elapsed: sample ? performance.now() - sample.at : 0,
      });
    }, OVERLAY_UPDATE_MS);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, []);
  const view = overlayView(paint.frame, paint.elapsed);
  const preferences = paint.frame?.state.preferences ?? DEFAULT_OVERLAY;
  const r = view.readings;
  const gesture = (resize: boolean) => {
    if (!view.editing) return;
    const window = getCurrentWindow();
    void (
      resize ? window.startResizeDragging("SouthEast") : window.startDragging()
    ).catch(() => {});
  };
  return (
    <main
      className={`telemetry-overlay ${view.editing ? "is-editing" : "is-playing"}`}
      aria-label="F1 25 telemetry overlay"
      hidden={!view.visible}
      style={{ zoom: preferences.scale, opacity: preferences.opacity }}
    >
      <header onPointerDown={() => gesture(false)}>
        <span>
          RaceLab · {view.editing ? "EDITING · drag to move" : view.note}
        </span>
        {view.editing && <span>Finish in Settings</span>}
      </header>
      <dl className="overlay-primary">
        <Reading label="Gear" reading={r.gear} />
        <Reading label="Speed" reading={r.speed} unit="km/h" />
        <Reading label="RPM" reading={r.rpm} />
      </dl>
      <dl className="overlay-inputs">
        {(["throttle", "brake"] as const).map((key) => (
          <div key={key} data-freshness={r[key].freshness}>
            <dt>{key}</dt>
            <dd>
              {r[key].text}
              {r[key].text !== "—" && "%"}
            </dd>
            <span className="overlay-input-track" aria-hidden="true">
              <span
                style={{
                  width: `${Math.min(100, Math.max(0, Number(r[key].text) || 0))}%`,
                }}
              />
            </span>
          </div>
        ))}
      </dl>
      <dl className="overlay-context">
        <Reading label="Lap" reading={r.lap} />
        <Reading label="Sector" reading={r.sector} />
        <Reading label="Position" reading={r.position} />
      </dl>
      <dl className="overlay-car">
        <Reading label="DRS" reading={r.drs} />
        <Reading label="ERS" reading={r.ers} />
        <Reading label="Fuel" reading={r.fuel} />
      </dl>
      {view.editing && (
        <p className="overlay-edit-note">
          {view.note} · resize at lower-right corner
        </p>
      )}
      {view.editing && (
        <div
          className="overlay-resize"
          onPointerDown={() => gesture(true)}
          aria-hidden="true"
        >
          ↘
        </div>
      )}
    </main>
  );
}
