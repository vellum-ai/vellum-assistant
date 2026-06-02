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
  subscribeChatEvents,
  type ChatEventStream,
} from "@/lib/streaming/stream-transport";

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
    let current: ChatEventStream | null = null;
    let cancelled = false;
    // Independent dedup windows per handler. A shared timestamp was
    // wrong: `app.resume`'s no-op (current already non-null) would
    // update the shared mark and then suppress a `power.resume` that
    // genuinely needed to bounce a half-dead socket. Each handler
    // self-dedups against its own action's recency.
    let lastAppResumeAt = 0;
    let lastPowerActionAt = 0;
    let nextOpenCause: "fresh" | "error" | "watchdog" | "resume" = "fresh";

    const open = () => {
      if (cancelled || current) return;
      const causeAtOpen = nextOpenCause;
      nextOpenCause = "resume";
      const stream = subscribeChatEvents(
        assistantId,
        null,
        (envelope) => {
          publish("sse.event", envelope);
        },
        (err) => {
          current = null;
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
      current = stream;
      publish("sse.opened", { assistantId, cause: causeAtOpen });
    };

    const teardown = () => {
      current?.cancel();
      current = null;
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

    open();

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
      unsubHidden();
      unsubPowerSuspend();
      unsubResume();
      unsubPowerResume();
      unsubPowerUnlock();
      unsubReachabilityRetry();
      current?.cancel();
      current = null;
    };
  },
};
