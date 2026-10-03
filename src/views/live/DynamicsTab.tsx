import { Readout } from "../../components/live/Readout";
import { dynamicsLayout, type Reading } from "../../telemetry/live-layout.ts";
import type { LiveFrameState } from "../../telemetry/telemetry-view-model.ts";

function Cell({ reading }: { reading: Reading }) {
  return (
    <td
      className={reading.available ? undefined : "is-unavailable"}
      data-source={reading.source}
      data-role={reading.role}
      data-available={reading.available}
    >
      {reading.available ? (
        reading.value
      ) : (
        <>
          <span aria-hidden="true">{reading.value}</span>
          <span className="visually-hidden">unavailable</span>
        </>
      )}
    </td>
  );
}

/// Motion in the source's own axes. A technical table, not a set of gauges:
/// the vehicle-axis orientation of these vectors is not established, so the
/// columns stay X, Y and Z and no component is called lateral or
/// longitudinal, and no value is turned into a driving conclusion.
export default function DynamicsTab({ state }: { state: LiveFrameState }) {
  const model = dynamicsLayout(state);
  return (
    <div className="live-dynamics">
      <section className="live-panel dynamics-motion" aria-label="Motion">
        <div className="dynamics-header">
          <h2 className="live-section-title">Motion</h2>
          <div className="dynamics-speed">
            <Readout reading={model.speed} size="figure" />
            <Readout
              reading={model.speedMps}
              size="figure"
              className="readout-detail"
              hideLabel
            />
          </div>
        </div>
        <table className="axis-table">
          <caption className="visually-hidden">
            Motion vectors in the source axes
          </caption>
          <thead>
            <tr>
              <th scope="col">Quantity</th>
              <th scope="col" className="axis-unit">
                Unit
              </th>
              <th scope="col">X</th>
              <th scope="col">Y</th>
              <th scope="col">Z</th>
            </tr>
          </thead>
          <tbody>
            {model.axes.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  {row.label}
                  <span className="visually-hidden">, {row.unit}</span>
                </th>
                <td className="axis-unit">{row.unit}</td>
                {row.values.map((reading) => (
                  <Cell key={reading.key} reading={reading} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="live-footnote">
          Components are named X, Y and Z because which way these axes point
          relative to the car has not been established. g = m/s² ÷ 9.80665, the
          same value converted for display. Position is metres in the game's own
          coordinates, with no transform applied.
        </p>
      </section>

      <section className="live-panel dynamics-attitude" aria-label="Attitude">
        <h2 className="live-section-title">Attitude</h2>
        <table className="axis-table attitude-table">
          <caption className="visually-hidden">Orientation in degrees</caption>
          <thead>
            <tr>
              {model.attitude.map((reading) => (
                <th key={reading.key} scope="col">
                  {reading.label}
                </th>
              ))}
              <th scope="col" className="axis-unit">
                Unit
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              {model.attitude.map((reading) => (
                <Cell key={reading.key} reading={reading} />
              ))}
              <td className="axis-unit">°</td>
            </tr>
          </tbody>
        </table>
        <p className="live-footnote">
          Orientation is recorded as x = yaw, y = pitch, z = roll; radians are
          converted to degrees for display only.
        </p>
      </section>
    </div>
  );
}
