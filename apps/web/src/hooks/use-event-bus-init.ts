/**
 * Owns the bus's event sources at app-root scope.
 *
 * Two concerns, two effects:
 *
 * 1. DOM / Capacitor / Electron lifecycle + inbound deep links.
 *    Listens to `document.visibilitychange`, `window.online` /
 *    `window.offline`, Capacitor `App.appStateChange`, and (on the
 *    Electron host) the main-process `powerMonitor` and deep-link
 *    bridges. Publishes `"app.resume"` / `"app.hidden"` /
 *    `"app.online"` / `"app.offline"` /  `"power.suspend"` /
 *    `"power.resume"` / `"power.lock"` / `"power.unlock"` /
 *    `"power.active"` / `"deeplink.send"` / `"deeplink.openThread"` /
 *    `"deeplink.unknown"` on the bus.
 *
 * 2. Single assistant-scoped SSE connection. Opens one unfiltered
 *    `/v1/events` stream per assistant and re-broadcasts every event
 *    on `"sse.event"`. Publishes `"sse.opened"` after each successful
 *    open and `"sse.closed"` on transport errors. Tears down on
 *    `"app.hidden"` and `"power.suspend"`. Reopens on `"app.resume"`
 *    (only if torn down). Force-bounces (teardown + reopen) on
 *    `"power.resume"` / `"power.unlock"` because the renderer may
 *    have stayed visible during system sleep — the SSE looks "open"
 *    but the remote may have TCP-RST'd. All resume paths share a 1s
 *    dedup window so a sleep that ALSO triggered a visibility change
 *    doesn't double-bounce. `"reachability.retry-requested"` also
 *    bounces.
 *
 * The daemon dedups SSE subscribers by `clientId`, so this hook MUST
 * be the only place that opens a connection. Consumers subscribe to
 * `bus.sse.event` instead of opening their own SSE handles.
 */
import { useEffect } from "react";
import * as Sentry from "@sentry/browser";
import type { PluginListenerHandle } from "@capacitor/core";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { subscribeChatEvents } from "@/lib/streaming/stream-transport";
import type { ChatEventStream } from "@/lib/streaming/stream-transport";
import {
  drainPendingDeepLinks,
  subscribeToDeepLinks,
  type DeepLink,
} from "@/runtime/deep-links";
import { subscribeToPowerEvents } from "@/runtime/power-events";
import { useEventBusStore } from "@/stores/event-bus-store";
import { isNativePlatform } from "@/runtime/native-auth";

interface UseEventBusInitParams {
  /** Resolved assistant id, or `null` when not yet loaded. */
  assistantId: string | null;
  /** `true` once the assistant lifecycle reports `kind === "active"`. */
  isAssistantActive: boolean;
}

const RESUME_DEDUP_WINDOW_MS = 1000;

export function useEventBusInit({
  assistantId,
  isAssistantActive,
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

    // Electron host: subscribe to `powerMonitor` via the runtime
    // wrapper. The bridge fans every system-level event in as a
    // typed bus event. Off Electron the wrapper is a no-op and the
    // unsubscribe-noop is returned — no effect on web / iOS.
    const unsubPower = subscribeToPowerEvents(({ kind }) => {
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

    // Electron host: deep-link bridge. Subscribe-then-drain order
    // matters — a link arriving between drain completion and
    // subscription would be lost otherwise. Subscribe first, drain
    // second; any in-flight link is delivered via `onLink` and the
    // drained buffer carries the pre-renderer-ready backlog. The
    // bus delivers handlers in registration order so duplicate
    // delivery (live link also enqueued in main between subscribe
    // and drain) is consumer's problem if it ever happens — the
    // current main-side implementation buffers + broadcasts, so
    // drain after subscribe sees no duplicates in practice.
    const publishDeepLink = (link: DeepLink) => {
      switch (link.kind) {
        case "send":
          bus.publish("deeplink.send", { message: link.message });
          break;
        case "openThread":
          bus.publish("deeplink.openThread", { threadId: link.threadId });
          break;
        case "unknown":
          bus.publish("deeplink.unknown", { url: link.url });
          break;
      }
    };
    const unsubDeepLinks = subscribeToDeepLinks(publishDeepLink);
    void drainPendingDeepLinks()
      .then((pending) => {
        for (const link of pending) publishDeepLink(link);
      })
      .catch((err) => {
        Sentry.captureException(err, {
          level: "warning",
          tags: { context: "deep_link_drain" },
        });
      });

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      appStateCancelled = true;
      void appStateHandle?.remove();
      unsubPower();
      unsubDeepLinks();
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
    // Independent dedup windows per handler. A shared timestamp was
    // wrong: `app.resume`'s no-op (current already non-null) would
    // update the shared mark and then suppress a `power.resume` that
    // genuinely needed to bounce a half-dead socket. Each handler now
    // self-dedups against its own action's recency.
    let lastAppResumeAt = 0;
    let lastPowerActionAt = 0;
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

    // App lifecycle (renderer-visibility resume): tear down on hidden,
    // reopen on resume IF the connection was already torn down. The
    // self-dedup window collapses double-fires from visibilitychange +
    // Capacitor appStateChange (both arrive in close succession on
    // foregrounding the iOS native shell).
    const handleAppResume = () => {
      const now = Date.now();
      if (now - lastAppResumeAt < RESUME_DEDUP_WINDOW_MS) return;
      lastAppResumeAt = now;
      // Daemon health check via the lifecycle store. The no-op
      // default covers the pre-registration window but no foreground
      // resume event can fire before `RootLayout` has mounted.
      void useAssistantLifecycleStore.getState().checkAssistant();
      // App-resume means the renderer became visible; if a connection
      // is already live, it was either never torn down or just opened
      // moments ago — either way, leave it alone.
      if (current) return;
      open();
    };
    // System-level resume (Electron host): bounce the connection
    // UNCONDITIONALLY. The renderer may have stayed visible during
    // system sleep (tray-resident, full-screen) so there's no
    // app.hidden → app.resume cycle; `current` is still non-null
    // but the socket may be half-dead because the remote side
    // TCP-RST'd while we slept. Self-dedups against close-together
    // `power.resume` + `power.unlock` (sleep → wake → unlock).
    // Independent from `lastAppResumeAt` because an `app.resume`
    // no-op (current non-null) MUST NOT suppress a power-driven
    // bounce — half-dead sockets persist otherwise.
    const handlePowerResume = () => {
      const now = Date.now();
      if (now - lastPowerActionAt < RESUME_DEDUP_WINDOW_MS) return;
      lastPowerActionAt = now;
      void useAssistantLifecycleStore.getState().checkAssistant();
      teardown();
      open();
    };
    const teardownIfOpen = () => {
      if (!current) return;
      teardown();
    };
    const unsubHidden = bus.subscribe("app.hidden", teardownIfOpen);
    // System-level suspend: gracefully close the SSE so the daemon
    // sees us go away cleanly instead of waiting for TCP timeouts.
    // The resume / unlock handlers above will reopen on wake; if the
    // teardown here is missed (suspend events occasionally drop on
    // macOS), the bounce-on-resume path still recovers a half-dead
    // socket.
    const unsubPowerSuspend = bus.subscribe("power.suspend", teardownIfOpen);
    const unsubResume = bus.subscribe("app.resume", handleAppResume);
    const unsubPowerResume = bus.subscribe("power.resume", handlePowerResume);
    const unsubPowerUnlock = bus.subscribe("power.unlock", handlePowerResume);
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
      unsubPowerSuspend();
      unsubResume();
      unsubPowerResume();
      unsubPowerUnlock();
      unsubReachabilityRetry();
      current?.cancel();
      current = null;
    };
  }, [assistantId, isAssistantActive]);
}
