/**
 * Wires the module-level {@link getEventBus} to its event sources:
 *
 * 1. A single assistant-scoped `/v1/events` SSE connection — opened
 *    when `assistantId` is set and `isAssistantActive` is true.
 *    Every received event is re-broadcast on the bus as `"sse.event"`.
 * 2. `document.visibilitychange` — publishes `"app.resume"` / `"app.hidden"`
 *    with `signal: "visibility"`.
 * 3. Capacitor `App.appStateChange` (native only) — publishes
 *    `"app.resume"` / `"app.hidden"` with `signal: "app_state"`.
 * 4. `window.online` / `window.offline` — publishes `"app.online"` /
 *    `"app.offline"`. An online transition also publishes `"app.resume"`
 *    with `signal: "online"` so consumers that only care about "we're
 *    probably stale, refresh" can subscribe to a single channel.
 *
 * Mount once from the chat layout. Idempotent across remounts and a
 * no-op when the assistant is not active.
 */
import { useEffect } from "react";
import * as Sentry from "@sentry/browser";
import type { PluginListenerHandle } from "@capacitor/core";

import { subscribeChatEvents } from "@/domains/chat/api/stream.js";
import { getEventBus } from "@/runtime/event-bus.js";
import { isNativePlatform } from "@/runtime/native-auth.js";

interface UseEventBusInitParams {
  assistantId: string | null;
  isAssistantActive: boolean;
}

export function useEventBusInit({
  assistantId,
  isAssistantActive,
}: UseEventBusInitParams): void {
  // SSE connection lifecycle — gated on assistant being active so we
  // don't open a connection for unauthenticated / pre-lifecycle paths.
  useEffect(() => {
    if (!assistantId || !isAssistantActive) return;

    const bus = getEventBus();
    const stream = subscribeChatEvents(
      assistantId,
      null,
      (event) => bus.publish("sse.event", event),
      (err) => {
        Sentry.captureException(err, {
          level: "warning",
          tags: { context: "event_bus_sse" },
        });
      },
    );

    return () => {
      stream.cancel();
    };
  }, [assistantId, isAssistantActive]);

  // DOM visibility + online/offline listeners. These are global to the
  // tab so we mount them once on first render; the gate on
  // `isAssistantActive` only blocks the SSE connection — synthetic
  // lifecycle events are always live so future subscribers can rely
  // on them even before the assistant is ready.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const bus = getEventBus();

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
