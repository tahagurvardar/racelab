import {
  liveStore,
  recorderStore,
  setupStore,
  transportStore,
} from "../../state/stores.ts";
import { useDerived } from "../../state/use-store.ts";
import { shellAlert } from "../../telemetry/shell-view-model.ts";
import { Notice } from "./Notice";

const STORES = [liveStore, recorderStore, transportStore, setupStore];

/// The application-level alert: a failure that affects every view, such as a
/// port that cannot be opened or a recording that cannot be written. It is the
/// one place such a failure is stated: a short title, what it means, and the
/// backend's own words on request. Never a browser dialog; present for as
/// long as the condition holds.
export function AlertSlot() {
  const alert = useDerived(STORES, () =>
    shellAlert({
      live: liveStore.get(),
      recorder: recorderStore.get(),
      transport: transportStore.get(),
      setup: setupStore.get(),
    }),
  );
  if (alert == null) return null;
  return (
    <div className="shell-alert-slot">
      <Notice tone="bad" title={alert.title} technical={alert.detail}>
        {alert.summary}
      </Notice>
    </div>
  );
}
