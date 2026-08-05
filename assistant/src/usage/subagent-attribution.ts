import { rawGet } from "../persistence/raw-query.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("subagent-attribution");

/**
 * The two delegated-work attribution dimensions carried on a conversation:
 * the subagent role it was spawned with, and how it was spawned. Both null
 * for a conversation that is not a subagent.
 */
export interface SubagentAttribution {
  subagentRole: string | null;
  subagentSpawnMode: string | null;
}

const NOT_A_SUBAGENT: SubagentAttribution = {
  subagentRole: null,
  subagentSpawnMode: null,
};

/**
 * Bound on the memo below. Both columns are stamped once at conversation
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
const cache = new Map<string, SubagentAttribution>();

/**
 * Resolve the delegated-work attribution for a conversation, for forwarding on
 * the runtime proxy's `X-Vellum-Subagent-*` headers.
 *
 * Reads the columns stamped at spawn time (migration 362) rather than the
 * `subagents` table: `subagents` rows are deleted on dispose, and the billing
 * path must not depend on a row that may already be gone.
 *
 * Never throws. This runs on the provider dispatch hot path and attribution
 * must never be able to take a model request down. Any failure degrades to
 * "no attribution", which is exactly how the platform treats a missing header.
 */
export function resolveSubagentAttribution(
  conversationId: string | undefined,
): SubagentAttribution {
  if (conversationId === undefined || conversationId.length === 0) {
    return NOT_A_SUBAGENT;
  }
  const cached = cache.get(conversationId);
  if (cached !== undefined) {
    return cached;
  }

  const row = readRow(conversationId);
  if (!row) {
    // Either no row yet, or the read failed. Deliberately NOT cached: caching
    // a miss would pin an empty result for a conversation whose row lands
    // moments later, or for the whole process after one transient DB error.
    return NOT_A_SUBAGENT;
  }

  const attribution: SubagentAttribution = {
    subagentRole: row.subagent_role,
    subagentSpawnMode: row.subagent_spawn_mode,
  };
  if (cache.size >= MAX_CACHED_CONVERSATIONS) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
  cache.set(conversationId, attribution);
  return attribution;
}

interface ConversationSubagentRow {
  subagent_role: string | null;
  subagent_spawn_mode: string | null;
}

/**
 * Read the two columns, or `null` when the conversation has no row or the
 * read fails. Failure covers the pre-migration case (columns absent) and any
 * DB-unavailable context, such as a unit test exercising the provider stack
 * alone. Attribution must never be able to take a model request down.
 */
function readRow(conversationId: string): ConversationSubagentRow | null {
  try {
    return rawGet<ConversationSubagentRow>(
      "usage:subagentAttribution",
      `SELECT subagent_role, subagent_spawn_mode FROM conversations WHERE id = ?`,
      conversationId,
    );
  } catch (err) {
    log.debug({ err, conversationId }, "Subagent attribution lookup failed");
    return null;
  }
}

/** Test seam: drops every memoized entry. */
export function resetSubagentAttributionCacheForTests(): void {
  cache.clear();
}
