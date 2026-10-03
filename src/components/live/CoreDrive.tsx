import type { Reading } from "../../telemetry/live-layout.ts";
import { Region } from "../Region";
import { Readout } from "./Readout";
import { RpmBar } from "./RpmBar";

export function CoreDrive({
  speed,
  gear,
  rpm,
  f1 = false,
}: {
  speed: Reading;
  gear: Reading;
  rpm: Reading & { fraction: number | null; idle?: Reading; max: Reading };
  f1?: boolean;
}) {
  return (
    <Region title="Core Drive" className="overview-drive">
      <div className="drive-main">
        <Readout reading={speed} size="hero" className="drive-speed" />
        <Readout
          reading={gear}
          size="display"
          className={`drive-gear${f1 ? " f1-gear" : ""}`}
        />
        <div className="drive-rpm">
          <Readout reading={rpm} size="display" />
        </div>
      </div>
      <RpmBar fraction={rpm.fraction} idle={rpm.idle} max={rpm.max} />
    </Region>
  );
}
