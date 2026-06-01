import { subscribeToPowerEvents } from "@/runtime/power-events";
import type { EventBusPublisher } from "@/stores/event-bus-store";

/**
 * Electron main-process `powerMonitor` → five typed bus events:
 * `power.suspend` / `power.resume` / `power.lock` / `power.unlock`
 * / `power.active`. Off Electron the runtime wrapper is a no-op and
 * the returned unsubscribe-noop drops through cleanly — web / iOS
 * get their resume signals from `app.resume` instead.
 *
 * The renderer wrapper is the platform gate; this helper is just the
 * narrow mapping from `kind` → typed bus event so consumers don't
 * have to switch on `kind` themselves.
 */
export function publishElectronPowerSource(
  bus: EventBusPublisher,
): () => void {
  return subscribeToPowerEvents(({ kind }) => {
    switch (kind) {
      case "suspend":
        bus.publish("power.suspend", {});
        break;
      case "resume":
        bus.publish("power.resume", {});
        break;
      case "lock":
        bus.publish("power.lock", {});
        break;
      case "unlock":
        bus.publish("power.unlock", {});
        break;
      case "active":
        bus.publish("power.active", {});
        break;
    }
  });
}
