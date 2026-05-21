/**
 * Wires `useEventBusStore` to its DOM event sources:
 *
 * 1. `document.visibilitychange` — publishes `"app.resume"` / `"app.hidden"`
 *    with `signal: "visibility"`.
 * 2. Capacitor `App.appStateChange` (native only) — publishes
 *    `"app.resume"` / `"app.hidden"` with `signal: "app_state"`.
 * 3. `window.online` / `window.offline` — publishes `"app.online"` /
 *    `"app.offline"`. An online transition also publishes `"app.resume"`
 *    with `signal: "online"` so consumers that only care about "we're
 *    probably stale, refresh" can subscribe to a single channel.
 *
 * The SSE channel (`"sse.event"`) is intentionally not wired in this
 * PR — the daemon dedups subscribers by `clientId`, so adding a second
 * SSE handle alongside ChatPage's conversation-scoped stream would
 * re-trigger the LUM-1791 regression (see `chat-layout.tsx`). SSE
 * delivery comes when the conversation-scoped stream is folded onto
 * the bus.
 *
 * Mount once from the chat layout. Idempotent across remounts.
 */
import { useEffect } from "react";
import * as Sentry from "@sentry/browser";
import type { PluginListenerHandle } from "@capacitor/core";

import { useEventBusStore } from "@/stores/event-bus-store.js";
import { isNativePlatform } from "@/runtime/native-auth.js";

export function useEventBusInit(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const bus = useEventBusStore.getState();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        bus.publish("app.hidden", { signal: "visibility" });
      } else {
        bus.publish("app.resume", { signal: "visibility" });
      }
    };
    const handleOnline = () => {
      bus.publish("app.online", {});
      bus.publish("app.resume", { signal: "online" });
    };
    const handleOffline = () => {
      bus.publish("app.offline", {});
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    let appStateHandle: PluginListenerHandle | null = null;
    let appStateCancelled = false;
    if (isNativePlatform()) {
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
          if (appStateCancelled) {
            void registered.remove();
            return;
          }
          appStateHandle = registered;
        })
        .catch((err) => {
          Sentry.captureException(err, {
            level: "warning",
            tags: { context: "event_bus_capacitor_init" },
          });
        });
    }

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      appStateCancelled = true;
      void appStateHandle?.remove();
    };
  }, []);
}
