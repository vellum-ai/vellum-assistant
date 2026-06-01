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

import { lifecycleService } from "@/assistant/lifecycle-service";
import { subscribeChatEvents } from "@/lib/streaming/stream-transport";
import type { ChatEventStream } from "@/lib/streaming/stream-transport";
import { publishCapacitorAppStateSource } from "@/runtime/event-sources/capacitor-app-state";
import { publishVisibilitySource } from "@/runtime/event-sources/dom-visibility";
import { publishElectronDeepLinksSource } from "@/runtime/event-sources/electron-deep-links";
import { publishElectronPowerSource } from "@/runtime/event-sources/electron-power";
import { publishWindowOnlineSource } from "@/runtime/event-sources/window-online";
import { useEventBusStore } from "@/stores/event-bus-store";

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
  // Effect 1: signal sources publish into the bus
  //
  // Each helper in `runtime/event-sources/` wires one host-environment
  // event source (DOM visibility, network online/offline, Capacitor
  // app state, Electron powerMonitor, Electron deep links) and returns
  // its own unsubscribe. New signal sources land as a new file there,
  // not as another branch here — see the "Adding a new signal source"
  // section in `apps/web/docs/EVENT_BUS.md`.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const bus = useEventBusStore.getState();
    const unsubscribers = [
      publishVisibilitySource(bus),
      publishWindowOnlineSource(bus),
      publishCapacitorAppStateSource(bus),
      publishElectronPowerSource(bus),
      publishElectronDeepLinksSource(bus),
    ];
    return () => {
      for (const unsub of unsubscribers) unsub();
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
        (envelope) => {
          useEventBusStore.getState().publish("sse.event", envelope);
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
      void lifecycleService.checkAssistant();
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
      void lifecycleService.checkAssistant();
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
