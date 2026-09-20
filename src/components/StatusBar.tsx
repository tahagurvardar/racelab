import type { StatusModel } from "../telemetry/telemetry-view-model.ts";

/// Persistent global status. Every state carries text and a glyph in addition
/// to its colour, so nothing here depends on colour perception.
export function StatusBar({ model }: { model: StatusModel }) {
  return (
    <header className="statusbar">
      <div className="statusbar-identity">
        <p className="statusbar-product">{model.product}</p>
        <p className="statusbar-game">{model.game}</p>
      </div>
      <div className="statusbar-states">
        {model.items.map((item) => (
          <div key={item.key} className={`state-chip tone-${item.tone}`}>
            <span className="state-glyph" aria-hidden="true">
              {item.glyph}
            </span>
            <span className="state-text">
              <em>{item.label}</em>
              {item.value}
            </span>
          </div>
        ))}
      </div>
      <dl className="statusbar-facts">
        <div>
          <dt>Vehicle</dt>
          <dd>{model.vehicleId}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{model.sessionDuration}</dd>
        </div>
      </dl>
    </header>
  );
}
