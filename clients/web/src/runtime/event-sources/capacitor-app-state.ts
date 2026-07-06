import { publish } from "@/lib/event-bus";
import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";

/**
 * Capacitor iOS shell's `App.appStateChange` →
 * `app.resume(signal: "app_state")` on active, `app.hidden(signal:
 * "app_state")` on inactive. Off Capacitor iOS the function is a no-op
 * — web and Electron get their lifecycle signals from
 * `publishVisibilitySource` / `publishWindowOnlineSource`
 * / `publishElectronPowerSource` instead.
 *
 * `subscribeCapacitorListener` owns the platform guard, the
 * unsubscribe-before-import-resolves race, and failure reporting; the
 * `@capacitor/app` import stays lazy and inline here per CAPACITOR.md's
 * "lazy-import rule".
 */
export function publishCapacitorAppStateSource(): () => void {
  return subscribeCapacitorListener("event_bus_capacitor_init", async () => {
    const { App } = await import("@capacitor/app");
    return App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        publish("app.resume", { signal: "app_state" });
      } else {
        publish("app.hidden", { signal: "app_state" });
      }
    });
  });
}
