import { publish } from "@/lib/event-bus";
import { subscribeToPowerEvents } from "@/runtime/power-events";

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
export function publishElectronPowerSource(): () => void {
  return subscribeToPowerEvents(({ kind }) => {
    switch (kind) {
      case "suspend":
        publish("power.suspend", {});
        break;
      case "resume":
        publish("power.resume", {});
        break;
      case "lock":
        publish("power.lock", {});
        break;
      case "unlock":
        publish("power.unlock", {});
        break;
      case "active":
        publish("power.active", {});
        break;
    }
  });
}
