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
import { publish, subscribe, type AppResumeSignal } from "@/lib/event-bus";
import { resetReconnectCursor } from "@/lib/streaming/reconnect-cursor";
import {
  clearSseReconnectHandler,
  setSseReconnectHandler,
} from "@/lib/streaming/sse-reconnect-control";
import {
  subscribeEvents,
  type EventStream,
} from "@/lib/streaming/stream-transport";
import { isNativeMobile } from "@/runtime/platform-detection";
import { useSSEConnectedStore } from "@/stores/sse-connected-store";

const RESUME_DEDUP_WINDOW_MS = 1000;

// Grace window before a hidden tab tears its SSE connection down. A
// brief tab-out — alt-tab, a glance at another window, tapping a
// notification — shouldn't kill a live streaming turn: tearing down
// forces a cold reopen + reconcile on return, which the user perceives
// as a frozen transcript they have to refresh to clear. Only a tab that
// stays hidden past this window is treated as real backgrounding and
// torn down; a resume inside the window cancels the pending teardown and
// keeps the socket. `power.suspend` (system sleep) is deliberately NOT
// debounced — it still tears down immediately so the daemon sees a clean
// disconnect.
const DESKTOP_HIDDEN_TEARDOWN_GRACE_MS = 5_000;

// Native mobile gets a far longer grace. Switching apps is the normal way
// to use a phone, so at the desktop window every glance at another app
// paid a teardown, a cold reopen, and the whole `sse.opened` reconcile
// fan-out on return. A minute covers the quick switch and keeps the live
// socket through it.
const NATIVE_MOBILE_HIDDEN_TEARDOWN_GRACE_MS = 60_000;

// How long a background has to run before a socket we still hold a handle
// to is treated as dead on resume. iOS freezes JS shortly after
// backgrounding, so under the native grace the teardown timer usually
// never fires: the OS kills the connection while `current` still points
// at it, and the resume path would otherwise keep that corpse until the
// 45s stream watchdog notices. Past this threshold we reconnect
// deliberately; below it the socket is assumed healthy and kept as is.
const SUSPECT_SOCKET_AFTER_MS = 30_000;

// Test-only override of the resolved grace window; `null` means use the
// platform default.
let hiddenTeardownGraceOverrideMs: number | null = null;

// Resolved when the grace timer is armed rather than at module load, so
// the platform probe cannot run before the Capacitor bridge is ready.
const resolveHiddenTeardownGraceMs = (): number => {
  if (hiddenTeardownGraceOverrideMs !== null) {
    return hiddenTeardownGraceOverrideMs;
  }
  return isNativeMobile()
    ? NATIVE_MOBILE_HIDDEN_TEARDOWN_GRACE_MS
    : DESKTOP_HIDDEN_TEARDOWN_GRACE_MS;
};

/**
 * Override the hidden-teardown grace window. Test-only seam so specs can
 * exercise the debounce without real-time waits; pass `null` to restore
 * the platform default. Never call from production code.
 * @internal
 */
export function __setHiddenTeardownGraceMsForTesting(ms: number | null): void {
  hiddenTeardownGraceOverrideMs = ms;
}

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
    // `seq` is per-assistant, so the resumable cursor from a previous
    // assistant is meaningless on this connection's seq space. Clear it
    // so this attachment starts cold (like a fresh page load): the first
    // connect omits `lastSeenSeq` and the conversation's snapshot
    // watermark re-anchors the cursor via `anchorColdStartReplay`. A
    // transport reconnect within this attachment goes through
    // `openConnection()`, not `attach()`, so a live cursor is preserved
    // across reconnects.
    resetReconnectCursor();

    let current: EventStream | null = null;
    let cancelled = false;
    // Track the live stream handle for cancellation and the resume/bounce
    // dedup guards below. Holding a handle does NOT mean the socket is open:
    // `subscribeEvents` returns synchronously while its fetch is still in
    // flight and keeps the same handle across backoff retries, so liveness is
    // mirrored separately by `setConnected` off the transport's open/close
    // signals.
    const setCurrent = (stream: EventStream | null): void => {
      current = stream;
    };
    // Mirror *established* live-stream presence into the shared store so
    // consumers can read SSE liveness reactively — the menu-bar status dot
    // (`useElectronStatusSync`) and push-notification suppression. Driven by
    // the transport's `onStreamOpen` / `onStreamClose` (which fire when the
    // SSE response actually opens / ends), never by handle creation: keying
    // off the handle would report `connected` throughout a failing initial
    // connect and its backoff window, when nothing is open. Also set `false`
    // explicitly on intentional teardown and on give-up (`onError`), which
    // are authoritative "no live stream" points; the bus is not used because
    // `sse.opened` / `sse.closed` are reconnect *triggers* (carrying a cause)
    // and graceful teardowns deliberately don't publish `sse.closed`.
    const setConnected = (connected: boolean): void => {
      useSSEConnectedStore.getState().setConnected(connected);
    };
    // Independent dedup windows per handler. A shared timestamp was
    // wrong: `app.resume`'s no-op (current already non-null) would
    // update the shared mark and then suppress a `power.resume` that
    // genuinely needed to bounce a half-dead socket. Each handler
    // self-dedups against its own action's recency.
    let lastAppResumeAt = 0;
    let lastPowerActionAt = 0;
    let nextOpenCause:
      "fresh" | "error" | "watchdog" | "resume" | "debug" | "anchor" = "fresh";
    // Pending timer for a delayed debug-triggered reconnect, so detach
    // can cancel a reconnect that hasn't fired yet.
    let debugReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Pending grace timer for a hidden-tab teardown, so a resume within
    // the grace window (or a detach / other teardown) can cancel it.
    let hiddenTeardownTimer: ReturnType<typeof setTimeout> | null = null;
    // When the pending grace teardown was armed, so a resume can tell a
    // quick app switch from a background long enough that the socket we
    // still hold is probably dead. Null whenever no background is pending.
    let hiddenAt: number | null = null;
    const clearHiddenTeardownTimer = () => {
      if (hiddenTeardownTimer !== null) {
        clearTimeout(hiddenTeardownTimer);
        hiddenTeardownTimer = null;
      }
    };

    const openConnection = () => {
      if (cancelled || current) {
        return;
      }
      const causeAtOpen = nextOpenCause;
      nextOpenCause = "resume";
      // Did THIS stream ever genuinely establish (a frame arrived)? A transport
      // reconnect only triggers a reconcile when we'd actually been connected
      // before. Otherwise a stream that never opens — e.g. a 502 loop against
      // the gateway proxy — would publish `sse.opened` on every failed attempt,
      // and each one fans out to a full reconcile/refetch across domains
      // (conversations, messages, identity, flags…), storming the daemon's
      // request limiter. Reconciling has nothing to recover when we never went
      // live, so suppress it until the stream proves established.
      let everOpened = false;
      // The stream these callbacks belong to, so a late signal from one that
      // has already been replaced cannot act on behalf of the live one. The
      // daemon closes a superseded connection as soon as its replacement
      // registers (same clientId), and that close arrives here as an error on
      // the OLD stream. Clearing `current` on it would blank the pointer to
      // the healthy new stream, and the next trigger would open another
      // connection, which closes that one in turn: a reconnect loop that
      // sustains itself with no network fault at all.
      let ownStream: EventStream | null = null;
      const isLiveStream = (): boolean =>
        ownStream === null || ownStream === current;
      const stream = subscribeEvents(
        assistantId,
        (envelope) => {
          publish("sse.event", envelope);
        },
        (err) => {
          Sentry.addBreadcrumb({
            category: "event_bus.sse",
            level: "warning",
            message: err.message,
          });
          if (!isLiveStream()) {
            return;
          }
          setCurrent(null);
          setConnected(false);
          publish("sse.closed", { reason: err.message });
        },
        {
          onReconnect: (cause) => {
            if (everOpened && isLiveStream()) {
              publish("sse.opened", { assistantId, cause });
            }
          },
          onStreamOpen: () => {
            const firstOpen = !everOpened;
            everOpened = true;
            setConnected(true);
            // Announce the stream once it genuinely establishes rather than
            // when its handle is created, so an attempt that never connects
            // does not fan out a reconcile across every domain.
            if (firstOpen && isLiveStream()) {
              publish("sse.opened", { assistantId, cause: causeAtOpen });
            }
          },
          onStreamClose: () => {
            if (isLiveStream()) {
              setConnected(false);
            }
          },
        },
      );
      ownStream = stream;
      if (cancelled) {
        stream.cancel();
        return;
      }
      setCurrent(stream);
    };

    const teardown = () => {
      // A teardown by any path (grace timer, power, reachability, debug,
      // detach) makes a still-pending grace teardown moot — clear it so a
      // late fire can't cancel a connection opened after it. The hidden
      // mark goes with it: it describes the socket being dropped here, and
      // whatever opens next is fresh rather than suspect.
      clearHiddenTeardownTimer();
      hiddenAt = null;
      current?.cancel();
      setCurrent(null);
      setConnected(false);
    };

    // App lifecycle (renderer-visibility): a hidden tab does NOT tear the
    // connection down immediately — see `handleAppHidden`, which debounces
    // it behind the platform's grace window. On a foreground resume we
    // cancel any pending grace teardown (so a brief tab-out keeps its live
    // socket) and reopen only if the connection was torn down, or if the
    // background ran long enough that the socket we still hold is suspect.
    // `runtime/event-sources/lifecycle-edge.ts` is the primary collapse: the
    // visibilitychange + Capacitor appStateChange pair for one physical edge
    // reaches the bus as a single `app.resume`. The self-dedup window below
    // covers the redundant resumes that still arrive: an
    // `app.resume{signal:"online"}` landing next to a foreground resume, and a
    // visibility/app_state pair spread further apart than the edge window.
    const handleAppResume = ({ signal }: { signal: AppResumeSignal }) => {
      // Only a real foreground consumes the hidden state. `online` is a
      // network transition that can arrive while the app is still
      // backgrounded, so letting it clear the hidden mark and the pending
      // grace teardown would defeat the suspect-socket reconnect: the
      // visibility/app_state resume that eventually lands would find no
      // background to measure and would keep a socket the OS killed during
      // the freeze. `online` still reopens a connection that is already
      // down, which is all it ever did here.
      const isForegroundResume = signal !== "online";
      let hiddenSince: number | null = null;
      if (isForegroundResume) {
        // Resumed within the grace window → the socket was never torn down;
        // cancel the pending teardown and keep it. Resumed after it fired →
        // no-op here, and the reopen below handles the down connection.
        clearHiddenTeardownTimer();
        // Consume the hidden mark on this first resume edge, ahead of the
        // dedup window below, so the suspect check runs once per background
        // and cannot be skipped: a redundant second resume finds it null and
        // so can neither bypass nor re-run the bounce.
        hiddenSince = hiddenAt;
        hiddenAt = null;
      }
      const now = Date.now();
      if (
        current !== null &&
        hiddenSince !== null &&
        now - hiddenSince > SUSPECT_SOCKET_AFTER_MS
      ) {
        // Long background: JS was frozen, so the grace teardown never got
        // to run and the socket `current` names was almost certainly
        // killed by the OS behind our back. Drop it so the reopen paths
        // below treat this as a down connection rather than trusting a
        // handle that will never deliver another frame.
        teardown();
      }
      if (now - lastAppResumeAt < RESUME_DEDUP_WINDOW_MS) {
        // Inside the dedup window. This collapses a redundant second resume
        // (an `online` edge landing next to a foreground one, or a
        // visibility/app_state pair spread further apart than the
        // lifecycle-edge window) so the health check below runs once. But the
        // window must NOT suppress a genuine reopen: an `app.hidden` can land
        // *between* two resumes and (once its grace elapses) tear the socket
        // down (`current === null`), and a blanket early-return would then
        // strand the connection torn-down until the next foreground, leaving
        // the user a frozen transcript that only a refresh recovers. Reopen
        // whenever the connection is down; only the redundant health check
        // is skipped here.
        if (!current) {
          openConnection();
        }
        return;
      }
      lastAppResumeAt = now;
      // Daemon health check via the lifecycle store. The no-op
      // default covers the pre-registration window but no
      // foreground resume event can fire before `RootLayout` has
      // mounted.
      void lifecycleService.checkAssistant();
      // App-resume means the renderer became visible; if a
      // connection is already live, it was either never torn down
      // or just opened moments ago — either way, leave it alone.
      if (current) {
        return;
      }
      openConnection();
    };

    // Renderer went hidden. Debounce the teardown: schedule it behind the
    // grace window instead of cancelling the stream now, so a brief
    // tab-out doesn't drop a live turn. A resume inside the window clears
    // this timer; if the tab is still hidden when it fires, tear down for
    // real. Idempotent — a repeat `app.hidden` while already scheduled is
    // ignored.
    const handleAppHidden = () => {
      if (!current) {
        return;
      }
      if (hiddenTeardownTimer !== null) {
        return;
      }
      hiddenAt = Date.now();
      hiddenTeardownTimer = setTimeout(() => {
        hiddenTeardownTimer = null;
        teardownIfOpen();
      }, resolveHiddenTeardownGraceMs());
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
      if (now - lastPowerActionAt < RESUME_DEDUP_WINDOW_MS) {
        return;
      }
      lastPowerActionAt = now;
      void lifecycleService.checkAssistant();
      teardown();
      openConnection();
    };

    const teardownIfOpen = () => {
      if (!current) {
        return;
      }
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
        openConnection();
      };
      if (delayMs <= 0) {
        reopen();
      } else {
        debugReconnectTimer = setTimeout(reopen, delayMs);
      }
    };

    openConnection();
    setSseReconnectHandler(reconnectForDebug);

    const unsubHidden = subscribe("app.hidden", handleAppHidden);
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
        openConnection();
      },
    );
    // Cold-start anchored replay (see `cold-anchor.ts`): the cold
    // connect opened cursor-less before the `/messages` snapshot
    // watermark `S` was known. The cursor is now seeded at `S`, so
    // bounce the connection to re-open carrying `lastSeenSeq = S` and
    // let the daemon ring-replay the snapshot→attach gap. Labeled
    // `"anchor"` so `reconcile-on-reopen` skips a redundant `/messages`
    // reconcile — the ring replay is the catch-up. If no connection is
    // attached yet the upcoming cold connect carries the cursor itself,
    // so there is nothing to bounce.
    const unsubAnchorRequested = subscribe("sse.anchor-requested", () => {
      if (!current) {
        return;
      }
      teardown();
      nextOpenCause = "anchor";
      openConnection();
    });

    return () => {
      cancelled = true;
      clearSseReconnectHandler(reconnectForDebug);
      if (debugReconnectTimer !== null) {
        clearTimeout(debugReconnectTimer);
        debugReconnectTimer = null;
      }
      clearHiddenTeardownTimer();
      unsubHidden();
      unsubPowerSuspend();
      unsubResume();
      unsubPowerResume();
      unsubPowerUnlock();
      unsubReachabilityRetry();
      unsubAnchorRequested();
      current?.cancel();
      setCurrent(null);
      setConnected(false);
    };
  },
};
