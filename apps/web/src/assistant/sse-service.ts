/**
 * Assistant-scoped SSE connection — the non-React core.
 *
 * Owns: opening the daemon's `/v1/events` stream for the active
 * assistant, republishing every envelope on the bus as `sse.event`,
 * publishing `sse.opened` / `sse.closed` lifecycle signals, and the
 * bounce policy that recovers half-dead sockets across renderer
 * visibility, system suspend/wake, screen lock/unlock, and
 * reachability-driven retries.
 *
 * Producer + consumer: republishes SSE events into the bus AND
 * subscribes to bus events (`app.hidden`, `app.resume`, `power.*`,
 * `reachability.retry-requested`) to derive when to bounce. That
 * dual role is the reason this exists as a service — `useEffect`
 * cleanups can express either side but mixing both produces a
 * state-machine-in-a-hook that's hard to read.
 *
 * No module-level state. `attach()` returns a fresh per-attachment
 * closure so swapping assistants drops a clean state boundary (no
 * leaked dedup timestamps, no stale `current` reference). Exported
 * as an object rather than a bare function so the React adapter's
 * test can `spyOn(sseService, "attach")` without resorting to
 * `mock.module` (which is process-global in bun and would shadow
 * the real implementation in `sse-service.test.ts`).
 */

import * as Sentry from "@sentry/react";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { publish, subscribe } from "@/lib/event-bus";
import {
  clearSseReconnectHandler,
  setSseReconnectHandler,
} from "@/lib/streaming/sse-reconnect-control";
import {
  subscribeEvents,
  type EventStream,
} from "@/lib/streaming/stream-transport";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";

const RESUME_DEDUP_WINDOW_MS = 1000;

export interface SseService {
  /**
   * Open the SSE connection for `assistantId`, wire the bounce-policy
   * subscriptions, and return a detach function that closes the
   * connection and unsubscribes. Each call creates a fresh per-
   * attachment closure; the React adapter calls `attach` when the
   * assistant becomes active and the returned detach when it changes
   * or unmounts.
   */
  attach(assistantId: string): () => void;
}

export const sseService: SseService = {
  attach(assistantId) {
    let current: EventStream | null = null;
    let cancelled = false;
    // Mirror live-stream presence into the shared store so consumers can read
    // SSE liveness reactively — the menu-bar status dot
    // (`useElectronStatusSync`) and push-notification suppression. Driven off
    // the `current` transition rather than the bus: `sse.opened` / `sse.closed`
    // are discrete reconnect *triggers* (carrying a cause) used for reconcile
    // passes, and graceful teardowns (hide, suspend, detach) deliberately do
    // not publish `sse.closed` (it would wrongly end in-flight turns), so a
    // bus subscription would leave the store stuck `true` after a clean close.
    const setCurrent = (stream: EventStream | null): void => {
      current = stream;
      useSSEConnectedStore.getState().setConnected(stream !== null);
    };
    // Independent dedup windows per handler. A shared timestamp was
    // wrong: `app.resume`'s no-op (current already non-null) would
    // update the shared mark and then suppress a `power.resume` that
    // genuinely needed to bounce a half-dead socket. Each handler
    // self-dedups against its own action's recency.
    let lastAppResumeAt = 0;
    let lastPowerActionAt = 0;
    let nextOpenCause: "fresh" | "error" | "watchdog" | "resume" | "debug" =
      "fresh";
    // Pending timer for a delayed debug-triggered reconnect, so detach
    // can cancel a reconnect that hasn't fired yet.
    let debugReconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (cancelled || current) return;
      const causeAtOpen = nextOpenCause;
      nextOpenCause = "resume";
      const stream = subscribeEvents(
        assistantId,
        (envelope) => {
          publish("sse.event", envelope);
        },
        (err) => {
          setCurrent(null);
          publish("sse.closed", { reason: err.message });
          Sentry.addBreadcrumb({
            category: "event_bus.sse",
            level: "warning",
            message: err.message,
          });
        },
        {
          onReconnect: (cause) => {
            publish("sse.opened", { assistantId, cause });
          },
        },
      );
      if (cancelled) {
        stream.cancel();
        return;
      }
      setCurrent(stream);
      publish("sse.opened", { assistantId, cause: causeAtOpen });
    };

    const teardown = () => {
      current?.cancel();
      setCurrent(null);
    };

    // App lifecycle (renderer-visibility resume): tear down on
    // hidden, reopen on resume IF the connection was already torn
    // down. The self-dedup window collapses double-fires from
    // visibilitychange + Capacitor appStateChange (both arrive in
    // close succession on foregrounding the iOS native shell).
    const handleAppResume = () => {
      const now = Date.now();
      if (now - lastAppResumeAt < RESUME_DEDUP_WINDOW_MS) return;
      lastAppResumeAt = now;
      // Daemon health check via the lifecycle store. The no-op
      // default covers the pre-registration window but no
      // foreground resume event can fire before `RootLayout` has
      // mounted.
      void lifecycleService.checkAssistant();
      // App-resume means the renderer became visible; if a
      // connection is already live, it was either never torn down
      // or just opened moments ago — either way, leave it alone.
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

    // Manual reconnect for QA of the disconnect/reconnect path, driven
    // by `_vellumDebug.events.reconnectClient(timeout?)`. Tears the
    // connection down now and reopens after `delayMs` so a tester can
    // observe the offline window and the post-reconnect catch-up. The
    // reopen is labeled `cause: "debug"` so reconcile consumers still
    // fire (they only skip on `"fresh"`) and telemetry stays honest.
    const reconnectForDebug = (delayMs: number) => {
      if (cancelled) {
        return;
      }
      if (debugReconnectTimer !== null) {
        clearTimeout(debugReconnectTimer);
        debugReconnectTimer = null;
      }
      teardown();
      const reopen = () => {
        debugReconnectTimer = null;
        if (cancelled) {
          return;
        }
        nextOpenCause = "debug";
        open();
      };
      if (delayMs <= 0) {
        reopen();
      } else {
        debugReconnectTimer = setTimeout(reopen, delayMs);
      }
    };

    open();
    setSseReconnectHandler(reconnectForDebug);

    const unsubHidden = subscribe("app.hidden", teardownIfOpen);
    // System-level suspend: gracefully close the SSE so the daemon
    // sees us go away cleanly instead of waiting for TCP timeouts.
    // The resume / unlock handlers above will reopen on wake; if
    // the teardown here is missed (suspend events occasionally
    // drop on macOS), the bounce-on-resume path still recovers a
    // half-dead socket.
    const unsubPowerSuspend = subscribe("power.suspend", teardownIfOpen);
    const unsubResume = subscribe("app.resume", handleAppResume);
    const unsubPowerResume = subscribe("power.resume", handlePowerResume);
    const unsubPowerUnlock = subscribe("power.unlock", handlePowerResume);
    const unsubReachabilityRetry = subscribe(
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
      clearSseReconnectHandler(reconnectForDebug);
      if (debugReconnectTimer !== null) {
        clearTimeout(debugReconnectTimer);
        debugReconnectTimer = null;
      }
      unsubHidden();
      unsubPowerSuspend();
      unsubResume();
      unsubPowerResume();
      unsubPowerUnlock();
      unsubReachabilityRetry();
      current?.cancel();
      setCurrent(null);
    };
  },
};
