/**
 * Post-reconnect reconciliation handoff for the bus-owned SSE stream.
 *
 * Listens to `sse.opened` and runs the reconcile pass for the active
 * conversation. `cause` discriminates the path:
 *
 *   - `"fresh"`  — first open per assistant; the regular history-load
 *                  path owns the initial fetch, no reconcile here.
 *   - `"anchor"` — cold-start anchored-replay reopen (see
 *                  `cold-anchor.ts`); the connection re-attaches at the
 *                  snapshot watermark `S` so the daemon ring-replays the
 *                  snapshot→attach gap. No reconcile here: the ring
 *                  replay is the catch-up, and ring eviction falls back
 *                  to the consumer's seq-gap reconcile.
 *   - `"resume"` — visibility-driven reopen; standalone reconcile +
 *                  start the reconciliation loop on the new epoch.
 *   - `"debug"`  — manual `_vellumDebug.events.reconnectClient()`
 *                  trigger; takes the same standalone-reconcile path as
 *                  `"resume"` so QA can exercise post-reconnect catch-up.
 *   - `"watchdog"` / `"error"` — transport-level recovery; runs
 *                  `reconcileActive()` to refresh the active
 *                  conversation's messages.
 *                  `"watchdog"` additionally records the rescue
 *                  outcome to Sentry so stalled-turn recoveries are
 *                  observable.
 *
 * Stateless module — every input is passed in via deps. The epoch
 * lives in a caller-owned ref so a later reopen can bump it and
 * stale completions self-cancel.
 */

import * as Sentry from "@sentry/react";
import { captureError } from "@/lib/sentry/capture-error";

import { useStreamStore } from "@/domains/chat/stream-store";
import {
  recordDiagnostic,
  recordLifecycleDiagnostic,
  resolvePlatformTag,
} from "@/lib/diagnostics";
import type { BusEventPayload } from "@/lib/event-bus";
import type { ReconcileActiveConversationResult } from "@/domains/chat/hooks/use-message-reconciliation";

// Derived from the bus payload so this handler can't drift from the
// canonical `sse.opened` cause union in `event-bus.ts`.
type SseOpenedCause = BusEventPayload<"sse.opened">["cause"];

export interface ReconcileOnReopenDeps {
  /** Assistant ID the bus is dispatching for; events for other assistants are ignored. */
  assistantId: string;
  /** Active conversation key; included in every diagnostic. */
  conversationId: string;
  /** Reconcile the active conversation against the server transcript. */
  reconcileActive: () => Promise<ReconcileActiveConversationResult>;
  /** Start the reconciliation loop on a given epoch. */
  startReconciliationLoop: (epoch: number) => void;
}

export interface ReconcileOnReopen {
  handleSseOpened(payload: {
    assistantId: string;
    cause: SseOpenedCause;
  }): void;
}

export function createReconcileOnReopen(
  deps: ReconcileOnReopenDeps,
): ReconcileOnReopen {
  const { assistantId, conversationId } = deps;
  return {
    handleSseOpened({ assistantId: openedFor, cause }) {
      if (openedFor !== assistantId) return;
      const epoch = useStreamStore.getState().bumpEpoch();
      recordLifecycleDiagnostic("sse_stream_opened", {
        assistantId,
        conversationId,
        epoch,
        cause,
      });
      if (cause === "fresh" || cause === "anchor") return;
      if (cause === "watchdog" || cause === "error") {
        void runTransportRecoveryReconcile(deps, epoch, cause);
        return;
      }
      // `"resume"` and any future non-fresh cause. Reconcile and
      // loop-start fire in parallel: the loop's polling is the
      // primary catch-up mechanism, so we don't gate it on the
      // best-effort one-shot reconcile. A rejected reconcile gets
      // logged + dropped — without the `.catch` it would surface
      // as an unhandled promise rejection (same shape as the
      // transport-recovery hardening in this module, just with
      // parallel-fire instead of sequential).
      void deps.reconcileActive().catch((err) => {
        recordDiagnostic("sse_post_reconnect_reconcile_failed", {
          assistantId,
          conversationId,
          epoch,
          cause,
          message: err instanceof Error ? err.message : String(err),
        });
        captureError(err, {
          context: "sse_resume_reconcile",
          level: "warning",
          tags: { cause, platform: resolvePlatformTag() },
          extra: { assistantId, conversationId, epoch },
        });
      });
      deps.startReconciliationLoop(epoch);
    },
  };
}

async function runTransportRecoveryReconcile(
  deps: ReconcileOnReopenDeps,
  epoch: number,
  cause: "watchdog" | "error",
): Promise<void> {
  const { assistantId, conversationId } = deps;
  recordLifecycleDiagnostic("sse_stream_reconnect", {
    assistantId,
    conversationId,
    epoch,
    cause,
  });
  const startedAt = Date.now();
  let reconcileResult: ReconcileActiveConversationResult;
  // The reconcile can reject (daemon unreachable, network error).
  // Failure here is a transport-recovery failure — log it and bail.
  // Without the catch, the rejection would surface as an unhandled
  // promise rejection because the bus subscriber that calls us is
  // `void`-firing this fn.
  try {
    reconcileResult = await deps.reconcileActive();
  } catch (err) {
    recordDiagnostic("sse_post_reconnect_reconcile_failed", {
      assistantId,
      conversationId,
      epoch,
      cause,
      message: err instanceof Error ? err.message : String(err),
    });
    captureError(err, {
      context: "sse_transport_recovery",
      level: "warning",
      tags: { cause, platform: resolvePlatformTag() },
      extra: { assistantId, conversationId, epoch },
    });
    // Still start the polling loop — it's the primary catch-up mechanism
    // and shouldn't be blocked by a transient fetch failure. The loop
    // will independently retry via fetchConversationMessages.
    const currentEpoch = useStreamStore.getState().streamEpoch;
    if (epoch === currentEpoch) {
      deps.startReconciliationLoop(epoch);
    }
    return;
  }

  // Stale-epoch guard: two close-together reopens can race — if a
  // newer sse.opened has bumped the epoch while we were awaiting,
  // this completion is for a superseded epoch and must not touch the
  // reconciliation loop or emit Sentry diagnostics that would mislead
  // the rescue metric. Without this, calling
  // startReconciliationLoop(staleEpoch) would cancel the newer loop
  // and then exit as stale, leaving no active loop running.
  const currentEpoch = useStreamStore.getState().streamEpoch;
  if (epoch !== currentEpoch) {
    recordDiagnostic("sse_post_reconnect_stale", {
      assistantId,
      conversationId,
      epoch,
      currentEpoch,
      cause,
    });
    return;
  }
  deps.startReconciliationLoop(epoch);
  if (cause !== "watchdog") return;
  recordWatchdogRescue(
    assistantId,
    conversationId,
    epoch,
    startedAt,
    reconcileResult,
  );
}

function recordWatchdogRescue(
  assistantId: string,
  conversationId: string,
  epoch: number,
  startedAt: number,
  reconcileResult: ReconcileActiveConversationResult,
): void {
  const latencyMs = Date.now() - startedAt;
  recordDiagnostic("sse_post_watchdog_reconcile_result", {
    assistantId,
    conversationId,
    epoch,
    latencyMs,
    changed: reconcileResult.changed,
    messagesAdded: reconcileResult.messagesAdded,
    assistantProgress: reconcileResult.assistantProgress,
  });
  Sentry.addBreadcrumb({
    category: "sse.watchdog",
    level: "info",
    message: "post_watchdog_reconcile_result",
    data: {
      latencyMs,
      changed: reconcileResult.changed,
      messagesAdded: reconcileResult.messagesAdded,
      assistantProgress: reconcileResult.assistantProgress,
    },
  });
  // captureMessage removed — 94% of events had rescued=false (watchdog
  // reconnected but no messages were lost), providing no actionable
  // signal. The breadcrumb above still attaches to any nearby Sentry
  // event for debugging context. See LUM-2190.
}
