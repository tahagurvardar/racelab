import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import type { OverlayPreferences, OverlayStatus } from "../overlay/model.ts";
import "../overlay/settings.css";

/// Coarse window state only, isolated inside Settings. Never reads telemetry.
export function OverlaySettings() {
  const [state, setState] = useState<OverlayStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = useRef("");
  const writing = useRef(false);
  useEffect(
    () =>
      startLatestPolling(
        () => invoke<OverlayStatus>("get_overlay_state"),
        (value) => {
          if (writing.current) return;
          const key = JSON.stringify(value);
          if (last.current !== key) {
            last.current = key;
            setState(value);
          }
        },
        (reason) => setError(String(reason)),
        1000,
      ),
    [],
  );
  async function save(
    patch: Partial<OverlayPreferences>,
    editing = state?.editing ?? false,
  ) {
    if (!state || writing.current) return;
    writing.current = true;
    setPending(true);
    setError(null);
    const preferences = { ...state.preferences, ...patch };
    try {
      const saved = await invoke<OverlayStatus>("configure_overlay", {
        enabled: preferences.enabled,
        scale: preferences.scale,
        opacity: preferences.opacity,
        editing,
      });
      last.current = JSON.stringify(saved);
      setState(saved);
    } catch (reason) {
      setError(String(reason));
    } finally {
      writing.current = false;
      setPending(false);
    }
  }
  async function move(dx: number, dy: number) {
    try {
      await invoke("move_overlay", { dx, dy });
    } catch (reason) {
      setError(String(reason));
    }
  }
  if (!state)
    return (
      <div>
        <p role="status">
          {error
            ? "Overlay settings could not be read. Reopen Settings to try again."
            : "Reading overlay settings…"}
        </p>
        {error && (
          <details>
            <summary>Technical details</summary>
            <p>{error}</p>
          </details>
        )}
      </div>
    );
  const p = state.preferences;
  return (
    <div className="overlay-settings">
      <label className="overlay-enable">
        <input
          type="checkbox"
          checked={p.enabled}
          disabled={pending}
          onChange={(event) =>
            void save({ enabled: event.target.checked }, false)
          }
        />{" "}
        Show in-game overlay
      </label>
      <div className="overlay-setting-controls">
        <label>
          Scale
          <select
            value={p.scale}
            disabled={pending}
            onChange={(event) =>
              void save({ scale: Number(event.target.value) })
            }
          >
            {[0.75, 1, 1.25, 1.5].map((value) => (
              <option key={value} value={value}>
                {Math.round(value * 100)}%
              </option>
            ))}
          </select>
        </label>
        <label>
          Opacity
          <select
            value={p.opacity}
            disabled={pending}
            onChange={(event) =>
              void save({ opacity: Number(event.target.value) })
            }
          >
            {[0.3, 0.6, 0.75, 0.9, 1].map((value) => (
              <option key={value} value={value}>
                {Math.round(value * 100)}%
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ghost"
          disabled={!p.enabled || pending}
          aria-pressed={state.editing}
          onClick={() => void save({}, !state.editing)}
        >
          {state.editing ? "Finish editing" : "Edit position"}
        </button>
      </div>
      {state.editing && (
        <div
          className="overlay-position-controls"
          role="group"
          aria-label="Move overlay position"
        >
          <p>
            Editing · drag the overlay header or resize its lower-right corner.
            These buttons move it by 20 pixels.
          </p>
          {(
            [
              [-20, 0, "Left"],
              [0, -20, "Up"],
              [0, 20, "Down"],
              [20, 0, "Right"],
            ] as const
          ).map(([dx, dy, label]) => (
            <button
              type="button"
              className="ghost"
              key={label}
              onClick={() => void move(dx, dy)}
            >
              Move {label.toLowerCase()}
            </button>
          ))}
        </div>
      )}
      <p className="settings-note">
        F1 25 only · appears with current telemetry. Play mode passes clicks
        through and keeps keyboard focus with the game. Use windowed or
        borderless-windowed mode.
      </p>
      {(error || state.error) && (
        <p className="tone-bad" role="alert">
          {error ?? state.error}
        </p>
      )}
    </div>
  );
}
