import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";
import { publishLifecycleEdge } from "@/runtime/event-sources/lifecycle-edge";

/**
 * Capacitor iOS shell's `App.appStateChange` →
 * `app.resume(signal: "app_state")` on active, `app.hidden(signal:
 * "app_state")` on inactive. Off Capacitor iOS the function is a no-op
 * — web and Electron get their lifecycle signals from
 * `publishVisibilitySource` / `publishWindowOnlineSource`
 * / `publishElectronPowerSource` instead.
 *
 * On iOS `visibilitychange` fires for the same physical edge, so both this
 * source and `publishVisibilitySource` go through
 * `runtime/event-sources/lifecycle-edge.ts` and the bus sees the edge once.
 *
 * Lazy inline `@capacitor/app` import per CAPACITOR.md's "lazy-import rule".
 */
export function publishCapacitorAppStateSource(): () => void {
  return subscribeCapacitorListener("event_bus_capacitor_init", async () => {
    const { App } = await import("@capacitor/app");
    return App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        publishLifecycleEdge("resume", "app_state");
      } else {
        publishLifecycleEdge("hidden", "app_state");
      }
    });
  });
}
