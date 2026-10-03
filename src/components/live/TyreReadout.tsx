import type { Reading } from "../../telemetry/live-layout.ts";
import { Readout } from "./Readout";

export function TyreReadout({
  corner,
  temperature,
  pressure,
}: {
  corner: string;
  temperature: Reading;
  pressure: Reading;
}) {
  return (
    <div className="tyre-readout" aria-label={`${corner} tyre`}>
      <span className="corner-code">{corner}</span>
      <Readout reading={{ ...temperature, role: "mirror" }} size="compact" />
      <Readout reading={{ ...pressure, role: "mirror" }} size="compact" />
    </div>
  );
}
