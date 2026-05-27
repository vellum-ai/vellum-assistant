/**
 * Owns the bus's event sources at chat-layout scope.
 *
 * Two concerns, two effects:
 *
 * 1. DOM / Capacitor lifecycle. Listens to `document.visibilitychange`,
 *    `window.online` / `window.offline`, and Capacitor
 *    `App.appStateChange`; publishes `"app.resume"` / `"app.hidden"` /
 *    `"app.online"` / `"app.offline"` on the bus.
 *
 * 2. Single assistant-scoped SSE connection. Opens one unfiltered
 *    `/v1/events` stream per assistant and re-broadcasts every event
 *    on `"sse.event"`. Publishes `"sse.opened"` after each successful
 *    open and `"sse.closed"` on transport errors. Tears down +
 *    reopens on `"app.hidden"` / `"app.resume"` (with a 1s dedup
 *    window) and on `"reachability.retry-requested"`.
 *
 * The daemon dedups SSE subscribers by `clientId`, so this hook MUST
 * be the only place that opens a connection. Consumers subscribe to
 * `bus.sse.event` instead of opening their own SSE handles.
 */
import { useEffect } from "react";
import * as Sentry from "@sentry/browser";
import type { PluginListenerHandle } from "@capacitor/core";

import { subscribeChatEvents } from "@/domains/chat/api/stream";
import type { ChatEventStream } from "@/domains/chat/api/stream";
import { useEventBusStore } from "@/stores/event-bus-store";
import { isNativePlatform } from "@/runtime/native-auth";

interface UseEventBusInitParams {
  /** Resolved assistant id, or `null` when not yet loaded. */
  assistantId: string | null;
  /** `true` once the assistant lifecycle reports `kind === "active"`. */
  isAssistantActive: boolean;
  /**
   * Called on `app.resume`. Today this triggers a daemon health check
   * so assistant-state recovers after a long background pause. Pulled
   * in as a callback so the hook stays decoupled from
   * `useAssistantLifecycle`'s shape.
   */
  checkAssistant: () => void;
}

const RESUME_DEDUP_WINDOW_MS = 1000;

export function useEventBusInit({
  assistantId,
  isAssistantActive,
  checkAssistant,
}: UseEventBusInitParams): void {
  // -------------------------------------------------------------------------
  // Effect 1: DOM + Capacitor lifecycle event sources
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Effect 2: Single assistant-scoped SSE connection.
  //
  // Gated on a resolved + active assistant. `sse.opened` carries the
  // (re)open cause so conversation-scoped consumers can decide whether
  // to reconcile. `sse.closed` is only published on transport errors;
  // `stream.ts` retries internally on transient drops, so the bus only
  // manually reopens on app.resume + reachability-retry signals (which
  // indicate an environment change worth eagerly probing).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!assistantId || !isAssistantActive) return;
    const capturedAssistantId = assistantId;
    const bus = useEventBusStore.getState();

    let current: ChatEventStream | null = null;
    let cancelled = false;
    let lastResumeAt = 0;
    let nextOpenCause: "fresh" | "error" | "watchdog" | "resume" = "fresh";

    const open = () => {
      if (cancelled || current) return;
      const causeAtOpen = nextOpenCause;
      nextOpenCause = "resume";
      const stream = subscribeChatEvents(
        capturedAssistantId,
        null,
        (event) => {
          useEventBusStore.getState().publish("sse.event", event);
        },
        (err) => {
          current = null;
          useEventBusStore
            .getState()
            .publish("sse.closed", { reason: err.message });
          Sentry.addBreadcrumb({
            category: "event_bus.sse",
            level: "warning",
            message: err.message,
          });
        },
        {
          onReconnect: (cause) => {
            useEventBusStore.getState().publish("sse.opened", {
              assistantId: capturedAssistantId,
              cause,
            });
          },
        },
      );
      if (cancelled) {
        stream.cancel();
        return;
      }
      current = stream;
      useEventBusStore.getState().publish("sse.opened", {
        assistantId: capturedAssistantId,
        cause: causeAtOpen,
      });
    };

    const teardown = () => {
      current?.cancel();
      current = null;
    };

    open();

    // App lifecycle: tear down on hidden, reopen on resume. The 1s
    // dedup window collapses double-fires from visibilitychange +
    // Capacitor appStateChange (both arrive in close succession on
    // foregrounding the iOS native shell).
    const unsubHidden = bus.subscribe("app.hidden", () => {
      if (!current) return;
      teardown();
    });
    const unsubResume = bus.subscribe("app.resume", () => {
      const now = Date.now();
      if (now - lastResumeAt < RESUME_DEDUP_WINDOW_MS) return;
      lastResumeAt = now;
      checkAssistant();
      if (current) return;
      open();
    });
    const unsubReachabilityRetry = bus.subscribe(
      "reachability.retry-requested",
      () => {
        // Label the next open as a recovery rather than the default
        // `"resume"` so `sse.opened` consumers can distinguish a
        // tab-foreground recovery from a reachability-driven retry.
        teardown();
        nextOpenCause = "error";
        open();
      },
    );

    return () => {
      cancelled = true;
      unsubHidden();
      unsubResume();
      unsubReachabilityRetry();
      current?.cancel();
      current = null;
    };
  }, [assistantId, isAssistantActive, checkAssistant]);
}
