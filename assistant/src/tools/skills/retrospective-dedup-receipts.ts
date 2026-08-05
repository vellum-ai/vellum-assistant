/**
 * Dedup receipts for retrospective skill authoring.
 *
 * The retrospective fork instruction requires a `find_similar_skills` check
 * before every `scaffold_managed_skill` call; this module is the enforcement
 * half of that contract. A successful retrospective-origin
 * `find_similar_skills` execution records a receipt for its run conversation,
 * and the scaffold executor refuses a retrospective-origin call when the run
 * holds none (fail-closed) and consumes one on each successful scaffold, so N
 * authored skills require N distinct dedup checks in the same run.
 *
 * The registry is deliberately in-memory and process-local: both executors run
 * inside the same agent-loop process for a given run conversation, run
 * conversations are single-use forks, and losing receipts to a restart only
 * fails closed (the pass re-runs `find_similar_skills`, which is cheap and
 * read-only). Nothing here is durable state, so it never touches the DB or
 * the plugin storage dir.
 */

/**
 * A recorded dedup check: the `find_similar_skills` goal and when it ran.
 * The goal is kept for log lines and future procedure-binding tightening; the
 * receipt's existence is what the scaffold gate consumes today.
 */
export interface DedupReceipt {
  goal: string;
  at: number;
}

/**
 * Most conversations tracked at once. Retrospective runs are short-lived and
 * sequential per assistant, so this is a leak bound, not a working-set size:
 * when the cap is hit the oldest-inserted conversation's receipts are evicted,
 * which at worst re-asks that run for a fresh `find_similar_skills` call.
 */
const MAX_TRACKED_CONVERSATIONS = 128;

/**
 * Most unconsumed receipts held per conversation. A run that calls
 * `find_similar_skills` more often than this without scaffolding is browsing,
 * not authoring; older receipts are dropped first.
 */
const MAX_RECEIPTS_PER_CONVERSATION = 16;

/** Insertion-ordered so cap eviction removes the oldest conversation first. */
const receiptsByConversation = new Map<string, DedupReceipt[]>();

/**
 * Record a successful `find_similar_skills` execution for a run conversation.
 * Called only for retrospective-origin executions; interactive sessions never
 * consult this registry.
 */
export function recordDedupReceipt(
  conversationId: string,
  goal: string,
  at: number = Date.now(),
): void {
  let receipts = receiptsByConversation.get(conversationId);
  if (!receipts) {
    if (receiptsByConversation.size >= MAX_TRACKED_CONVERSATIONS) {
      const oldest = receiptsByConversation.keys().next().value;
      if (oldest !== undefined) {
        receiptsByConversation.delete(oldest);
      }
    }
    receipts = [];
    receiptsByConversation.set(conversationId, receipts);
  }
  receipts.push({ goal, at });
  if (receipts.length > MAX_RECEIPTS_PER_CONVERSATION) {
    receipts.shift();
  }
}

/** Whether the run conversation holds at least one unconsumed receipt. */
export function hasDedupReceipt(conversationId: string): boolean {
  return (receiptsByConversation.get(conversationId)?.length ?? 0) > 0;
}

/**
 * Consume the most recent receipt for a run conversation. Called by the
 * scaffold executor AFTER a successful skill write, so a scaffold rejected on
 * validation or the ownership backstop keeps its receipt and can retry
 * without re-running the check. Returns the consumed receipt, or `null` when
 * none was held (the scaffold gate should have rejected before this point).
 */
export function consumeDedupReceipt(
  conversationId: string,
): DedupReceipt | null {
  const receipts = receiptsByConversation.get(conversationId);
  if (!receipts || receipts.length === 0) {
    return null;
  }
  const receipt = receipts.pop() ?? null;
  if (receipts.length === 0) {
    receiptsByConversation.delete(conversationId);
  }
  return receipt;
}

/** Test-only: drop every recorded receipt so suites stay independent. */
export function resetDedupReceiptsForTests(): void {
  receiptsByConversation.clear();
}
