import * as Sentry from "@sentry/browser";
import type { PluginListenerHandle } from "@capacitor/core";

import { isNativePlatform } from "@/runtime/native-auth";
import type { EventBusPublisher } from "@/stores/event-bus-store";

/**
 * Capacitor iOS shell's `App.appStateChange` →
 * `app.resume(signal: "app_state")` on active, `app.hidden(signal:
 * "app_state")` on inactive. Off Capacitor iOS the function is a no-op
 * (`isNativePlatform()` returns false) — web and Electron get their
 * lifecycle signals from `publishVisibilitySource` / `publishWindowOnlineSource`
 * / `publishElectronPowerSource` instead.
 *
 * The `@capacitor/app` plugin import is lazy (per CAPACITOR.md's
 * "lazy-import rule"): Capacitor plugins are Proxy objects whose
 * `.then` trap hangs an outer `await` indefinitely if the Proxy
 * crosses a Promise-resolution context. The dynamic import inside
 * the helper keeps the Proxy out of any async return.
 *
 * The sync return + internal `cancelled` flag covers the case where
 * the caller unsubscribes before the import resolves: we mark
 * cancelled, the import-resolution path checks it and removes the
 * just-registered listener.
 */
export function publishCapacitorAppStateSource(
  bus: EventBusPublisher,
): () => void {
  if (!isNativePlatform()) return () => undefined;

  let handle: PluginListenerHandle | null = null;
  let cancelled = false;

  import("@capacitor/app")
    .then(({ App }) =>
      App.addListener("appStateChange", ({ isActive }) => {
        if (isActive) {
          bus.publish("app.resume", { signal: "app_state" });
        } else {
          bus.publish("app.hidden", { signal: "app_state" });
        }
      }),
    )
    .then((registered) => {
      if (cancelled) {
        void registered.remove();
        return;
      }
      handle = registered;
    })
    .catch((err) => {
      Sentry.captureException(err, {
        level: "warning",
        tags: { context: "event_bus_capacitor_init" },
      });
    });

  return () => {
    cancelled = true;
    void handle?.remove();
  };
}
