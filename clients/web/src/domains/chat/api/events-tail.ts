/**
 * Server-side event-tail catch-up for recovery reconciles.
 *
 * A `/messages` snapshot is anchored at the `seq` of the last event whose
 * content the daemon has durably persisted — which, mid-turn, can honestly
 * lag the live stream by up to the daemon's partial-persist debounce. On a
 * healthy connection that window arrives as ordinary SSE deltas; after a
 * delivery gap (out-of-ring reconnect, backgrounded tab) those events were
 * never delivered and the snapshot alone leaves a hole until the next
 * flush-driven refetch.
 *
 * `GET /events/tail` closes the hole the canonical way — snapshot at
 * anchor, then the event log from that anchor: it returns the daemon's
 * ring-buffered envelopes for the conversation with `seq > fromSeq`, which
 * are ingested into the client event ring so the reseed replay
 * (`getSseEnvelopesSince` → `resolveSnapshot`) folds them exactly like
 * live events. Everything is best-effort: failures and incomplete
 * (ring-evicted) tails degrade to today's snapshot-only recovery.
 */

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

import { eventsTailGet } from "@/generated/daemon/sdk.gen";
import { supportsEventsTail } from "@/lib/backwards-compat/events-tail";
import { recordDiagnostic } from "@/lib/diagnostics";
import { ingestReplayedEnvelopes } from "@/lib/streaming/stream-debug";

/**
 * Fetch the buffered event tail above `fromSeq` and ingest it into the
 * client event ring, so an immediately following history reseed folds the
 * events the live connection never delivered.
 *
 * No-ops when the snapshot carried no anchor or the assistant predates
 * the endpoint. Never throws — the tail is an upgrade to the reconcile,
 * not a prerequisite.
 */
export async function ingestServerEventsTail(
  assistantId: string,
  conversationId: string,
  fromSeq: number | null,
): Promise<void> {
  if (fromSeq == null) return;
  if (!supportsEventsTail()) return;
  try {
    const { data, response } = await eventsTailGet({
      path: { assistant_id: assistantId },
      query: { conversationId, fromSeq: String(fromSeq) },
      throwOnError: false,
    });
    if (!response?.ok || !data) {
      recordDiagnostic("events_tail_fetch_failed", {
        conversationId,
        fromSeq,
        status: response?.status,
      });
      return;
    }
    if (!data.complete) {
      // The daemon's ring no longer reaches back to the anchor — the
      // snapshot alone is the recovery, as with an out-of-ring reconnect.
      recordDiagnostic("events_tail_incomplete", { conversationId, fromSeq });
      return;
    }
    if (data.events.length > 0) {
      ingestReplayedEnvelopes(data.events as AssistantEventEnvelope[]);
    }
    recordDiagnostic("events_tail_ingested", {
      conversationId,
      fromSeq,
      count: data.events.length,
      frontier: data.frontier,
    });
  } catch (err) {
    recordDiagnostic("events_tail_fetch_failed", {
      conversationId,
      fromSeq,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
