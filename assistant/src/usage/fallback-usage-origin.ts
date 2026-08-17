import { rawGet } from "../persistence/raw-query.js";
import { getLogger } from "../util/logger.js";
import {
  buildUsageOriginSnapshot,
  type UsageOriginSnapshot,
} from "./work-origin.js";

const log = getLogger("fallback-usage-origin");

/**
 * The conversation columns a fallback snapshot classifies from. Mirrors the
 * record-time metadata the `llm_usage` telemetry read path resolves for the
 * same conversation.
 */
interface ConversationOriginRow {
  conversation_type: string | null;
  source: string | null;
  parent_conversation_id: string | null;
  fork_parent_conversation_id: string | null;
}

/**
 * Bound on the memo below. All four columns are stamped at conversation
 * creation and never updated, so a hit is always correct and the only cost of
 * a bounded cache is an occasional re-read. Sized to comfortably cover the
 * conversations resident in one process without becoming a memory concern.
 */
const MAX_CACHED_CONVERSATIONS = 2048;

/**
 * Insertion-ordered memo. `Map` iteration order is insertion order, so
 * dropping the first key evicts the oldest entry, sufficient for a lookup
 * whose values are immutable and whose miss cost is a single primary-key read.
 */
const cache = new Map<string, ConversationOriginRow>();

/**
 * Build a best-effort {@link UsageOriginSnapshot} for a managed call whose
 * caller stamped no explicit snapshot: compaction, workflow leaves,
 * conversation titles, and every other direct `provider.sendMessage` site.
 * Without this those calls, a large share of real spend, reach the billing
 * backend with no origin headers at all.
 *
 * The conversation's own metadata drives the classification when there is a
 * conversation: its type, source, and spawn lineage resolve exactly as
 * {@link buildUsageOriginSnapshot} resolves them for the per-turn path. With no
 * conversation the call site alone classifies it, so a conversationless
 * `workflowLeaf` call still carries `user_created_background` and agrees with
 * the telemetry row for the same call.
 *
 * Turn linkage is absent by construction: `turnIndex` and `parentTurnIndex`
 * are computed only on the explicit per-turn path
 * (`buildTurnUsageOriginSnapshot`), which knows which turn it is running. A
 * count taken here would name whichever turn happened to be persisted when an
 * auxiliary call fired, so both stay null and the platform sees no turn header
 * rather than a wrong one.
 *
 * Never throws. This runs on the provider dispatch hot path and attribution
 * must never be able to take a model request down: a failed or missing row
 * degrades to a call-site-only classification.
 *
 * Returns null for a call carrying neither a conversation nor a call site,
 * which has nothing to attribute.
 */
export function resolveFallbackUsageOrigin(
  conversationId: string | null,
  callSite: string | null,
): UsageOriginSnapshot | null {
  if (conversationId === null || conversationId.length === 0) {
    if (callSite === null) {
      return null;
    }
    return buildUsageOriginSnapshot({
      conversationType: null,
      conversationSource: null,
      callSite,
      conversationId: null,
      turnIndex: null,
      parentConversationId: null,
      forkParentConversationId: null,
      parentTurnIndex: null,
    });
  }

  const row = readRow(conversationId);
  return buildUsageOriginSnapshot({
    conversationType: row?.conversation_type ?? null,
    conversationSource: row?.source ?? null,
    callSite,
    conversationId,
    turnIndex: null,
    parentConversationId: row?.parent_conversation_id ?? null,
    forkParentConversationId: row?.fork_parent_conversation_id ?? null,
    parentTurnIndex: null,
  });
}

/**
 * Read the conversation's origin columns, or `null` when the conversation has
 * no row or the read fails. Failure covers a DB-unavailable context, such as a
 * unit test exercising the provider stack alone.
 */
function readRow(conversationId: string): ConversationOriginRow | null {
  const cached = cache.get(conversationId);
  if (cached !== undefined) {
    return cached;
  }
  let row: ConversationOriginRow | null;
  try {
    row = rawGet<ConversationOriginRow>(
      "usage:fallbackOrigin",
      `SELECT conversation_type, source, parent_conversation_id, fork_parent_conversation_id
         FROM conversations WHERE id = ?`,
      conversationId,
    );
  } catch (err) {
    log.debug({ err, conversationId }, "Fallback origin lookup failed");
    return null;
  }
  if (!row) {
    // Deliberately NOT cached: caching a miss would pin an empty result for a
    // conversation whose row lands moments later.
    return null;
  }
  if (cache.size >= MAX_CACHED_CONVERSATIONS) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(conversationId, row);
  return row;
}

/** Test seam: drops every memoized entry. */
export function resetFallbackUsageOriginCacheForTests(): void {
  cache.clear();
}
