/**
 * Post-reconnect reconciliation handoff for the bus-owned SSE stream.
 *
 * Listens to `sse.opened` and runs the reconcile pass for the active
 * conversation. `cause` discriminates the path:
 *
 *   - `"fresh"`  — first open per assistant; the regular history-load
 *                  path owns the initial fetch, no reconcile here.
 *   - `"resume"` — visibility-driven reopen; standalone reconcile +
 *                  start the reconciliation loop on the new epoch.
 *   - `"watchdog"` / `"error"` — transport-level recovery; prefer the
 *                  sync router's `dispatchReconnect()` (it returns the
 *                  active conversation's refreshed messages in the
 *                  same roundtrip), fall back to standalone reconcile.
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
  bucketMessagesAdded,
  recordDiagnostic,
  recordLifecycleDiagnostic,
  resolvePlatformTag,
} from "@/lib/diagnostics";
import type {
  ActiveConversationMessagesRefreshResult,
  WebSyncReconnectResult,
} from "@/lib/sync/web-sync-router";

type SseOpenedCause = "fresh" | "error" | "watchdog" | "resume";

export interface ReconcileOnReopenDeps {
  /** Assistant ID the bus is dispatching for; events for other assistants are ignored. */
  assistantId: string;
  /** Active conversation key; included in every diagnostic. */
  conversationId: string;
  /** Reconcile the active conversation; standalone-fallback path. */
  reconcileActive: () => Promise<ActiveConversationMessagesRefreshResult>;
  /** Start the reconciliation loop on a given epoch. */
  startReconciliationLoop: (epoch: number) => void;
  /** Dispatch a sync-router reconnect; returns undefined when no router is mounted. */
  dispatchReconnect: () => Promise<WebSyncReconnectResult | undefined>;
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
      if (cause === "fresh") return;
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
  const { assistantId, conversationId, dispatchReconnect } = deps;
  recordLifecycleDiagnostic("sse_stream_reconnect", {
    assistantId,
    conversationId,
    epoch,
    cause,
  });
  const startedAt = Date.now();
  let reconcileResult: ActiveConversationMessagesRefreshResult;
  // Both paths to the reconcile result can reject: the sync router's
  // `dispatchReconnect()` and the standalone `reconcileActive()`
  // fallback. Failure here is a transport-recovery failure — log it and
  // bail. Without the catch, the rejection would surface as an
  // unhandled promise rejection because the bus subscriber that calls
  // us is `void`-firing this fn. The stale-epoch guard below would
  // never run, and the bus's next reopen would have no idea anything
  // went wrong.
  try {
    const syncReconnectResult = await dispatchReconnect();
    reconcileResult =
      syncReconnectResult?.activeConversationMessages ??
      (await deps.reconcileActive());
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
  reconcileResult: ActiveConversationMessagesRefreshResult,
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
  Sentry.captureMessage("sse_post_watchdog_reconcile_result", {
    level: "info",
    tags: {
      context: "sse_watchdog",
      platform: resolvePlatformTag(),
      assistantProgress: String(reconcileResult.assistantProgress),
      rescued: String(reconcileResult.messagesAdded > 0),
      messagesAddedBucket: bucketMessagesAdded(reconcileResult.messagesAdded),
    },
    extra: {
      latencyMs,
      messagesAdded: reconcileResult.messagesAdded,
      changed: reconcileResult.changed,
      assistantProgress: reconcileResult.assistantProgress,
      conversationId,
      epoch,
    },
  });
}
