import { publish, subscribe } from "@/lib/event-bus";
import {
  reportDeviceOnline,
  subscribeToConnectivity,
} from "@/runtime/connectivity";

/**
 * Two concerns in one source:
 *
 * 1. Forward main→renderer connectivity state broadcasts into the bus
 *    so domain consumers subscribe to `connectivity.state` uniformly.
 *
 * 2. Forward browser online/offline bus events to main via
 *    `reportDeviceOnline` so the main-process state machine fuses
 *    device-level reachability with its own health probes. Subscribes
 *    to `app.online`/`app.offline` rather than re-adding window
 *    listeners — `publishWindowOnlineSource` already owns those.
 *
 * Off Electron both halves are no-ops.
 */
export function publishElectronConnectivitySource(): () => void {
  const unsubConnectivity = subscribeToConnectivity((state) => {
    publish("connectivity.state", { state });
  });

  const unsubOnline = subscribe("app.online", () => reportDeviceOnline(true));
  const unsubOffline = subscribe("app.offline", () =>
    reportDeviceOnline(false),
  );

  return () => {
    unsubConnectivity();
    unsubOnline();
    unsubOffline();
  };
}
