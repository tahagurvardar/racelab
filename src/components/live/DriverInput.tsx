import type { BarReading } from "../../telemetry/live-layout.ts";
import { Region } from "../Region";
import { ControlBar } from "./ControlBar";

export function DriverInput({
  pedals,
  steering,
  auxiliary,
}: {
  pedals: BarReading[];
  steering: BarReading;
  auxiliary: BarReading[];
}) {
  return (
    <Region title="Driver Input" className="overview-inputs">
      <div className="inputs-primary">
        {pedals.map((reading) => (
          <ControlBar key={reading.key} reading={reading} />
        ))}
        <ControlBar reading={steering} />
      </div>
      <div className="inputs-auxiliary">
        {auxiliary.map((reading) => (
          <ControlBar key={reading.key} reading={reading} size="compact" />
        ))}
      </div>
    </Region>
  );
}
