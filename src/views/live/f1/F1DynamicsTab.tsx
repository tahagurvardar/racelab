import { Readout } from "../../../components/live/Readout";
import { f1DynamicsLayout } from "../../../telemetry/f1-live-layout.ts";
import type { F1LiveSnapshot } from "../../../telemetry/f1-player.ts";
import type { Reading } from "../../../telemetry/live-layout.ts";
import { F1_CORNERS, F1_CORNER_LABELS } from "../../../telemetry/f1-wheels.ts";
import { F1Panel } from "./parts";

function Cell({ reading }: { reading: Reading }) {
  return (
    <td
      className={
        `${reading.available ? "" : "is-unavailable"}${
          reading.stale ? " is-stale" : ""
        }`.trim() || undefined
      }
      data-source={reading.source}
      data-available={reading.available}
    >
      {reading.available ? (
        <>
          {reading.value}
          {reading.stale ? (
            <span className="visually-hidden">, not updating</span>
          ) : null}
        </>
      ) : (
        <>
          <span aria-hidden="true">{reading.value}</span>
          <span className="visually-hidden">unavailable</span>
        </>
      )}
    </td>
  );
}

/// Motion Ex as measured values: the car's motion in its local axes, its
/// attitude, and every per-wheel channel. A technical table, not gauges, and
/// no conclusion is drawn — no understeer, oversteer or balance.
export default function F1DynamicsTab({
  live,
}: {
  live: F1LiveSnapshot | null;
}) {
  const model = f1DynamicsLayout(live);
  return (
    <div className="f1-dynamics">
      <div className="f1-dynamics-top">
        <F1Panel title="Motion" family={model.family} className="f1-motion">
          <table className="axis-table">
            <caption className="visually-hidden">
              Motion in the car&rsquo;s local axes
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
                    <Cell key={reading.source} reading={reading} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </F1Panel>
        <F1Panel title="Attitude" family={model.family} className="f1-attitude">
          <div className="f1-readings">
            {model.scalars.map((reading) => (
              <Readout key={reading.key} reading={reading} size="compact" />
            ))}
          </div>
        </F1Panel>
      </div>
      <F1Panel
        title="Per wheel"
        family={model.family}
        className="f1-wheel-table"
      >
        <div className="table-scroll">
          <table className="axis-table">
            <caption className="visually-hidden">
              Per-wheel motion values, front left to rear right
            </caption>
            <thead>
              <tr>
                <th scope="col">Channel</th>
                <th scope="col" className="axis-unit">
                  Unit
                </th>
                {F1_CORNERS.map((corner) => (
                  <th key={corner} scope="col">
                    <abbr title={F1_CORNER_LABELS[corner]}>{corner}</abbr>
                    <span className="visually-hidden">
                      {" "}
                      {F1_CORNER_LABELS[corner]}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.wheels.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td className="axis-unit">{row.unit || "—"}</td>
                  {row.values.map((reading) => (
                    <Cell key={reading.source} reading={reading} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </F1Panel>
      <p className="live-footnote">
        Units are shown only where F1 25 states one; a dash in the unit column
        means the value is shown exactly as sent. Local axes are F1 25&rsquo;s
        own, with no transform applied.
      </p>
    </div>
  );
}
