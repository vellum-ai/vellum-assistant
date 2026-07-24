// ---------------------------------------------------------------------------
// Memory retrospective — enqueue helper.
// ---------------------------------------------------------------------------
//
// Enqueue a `memory_retrospective` job for the given conversation. Gates on:
//   - Source conversation isn't a memory-retrospective conversation itself
//     (recursion guard — we never run a retrospective over reflective
//     musings from the retrospective agent's own writes).
//   - Source isn't a `scheduled` thread or a memory-consolidation background
//     (low yield — see `isLowYieldRetrospectiveSource`).
//
// All trigger types funnel through `upsertMemoryRetrospectiveJob` which
// coalesces rapid enqueues into a single pending row per conversation.
// `compaction` gets a small debounce so the job runs after the signal
// settles; `interval`, `message_count`, and `sweep` fire immediately.
//
// The four triggers split by cadence: `interval` / `message_count` /
// `compaction` are event-driven — evaluated from the post-turn indexing hook
// and the compaction site, so they only fire while a conversation is actively
// taking turns. `sweep` is the timer-driven backstop: a scheduled job
// (`memory_retrospective_sweep`) re-scans conversations for unprocessed
// messages the event triggers missed when a turn ended before its post-turn
// hooks ran (crash / IPC drop) and the conversation then went idle. See
// `memory-retrospective-sweep.ts`.

import {
  getConversation,
  getConversationSource,
} from "../../../persistence/conversation-crud.js";
import {
  isMemoryEnabled,
  upsertMemoryRetrospectiveJob,
} from "../../../persistence/jobs-store.js";
import { type TrustClass } from "../../../runtime/actor-trust-resolver.js";
import { resolveCapabilities } from "../../../runtime/capabilities.js";
import { getLogger } from "./logging.js";
import { isMemoryRetrospectiveSource } from "./memory-retrospective-constants.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "./v3/substrate/constants.js";

const log = getLogger("memory-retrospective-enqueue");

export type MemoryRetrospectiveTrigger =
  | "interval"
  | "message_count"
  | "compaction"
  | "sweep";

const COMPACTION_DEBOUNCE_MS = 500;

/**
 * Enqueue a retrospective job for `conversationId`, applying the recursion and
 * low-yield source guards. Returns `true` only when a NEW pending job is
 * created — `false` on any skip (memory disabled, recursion guard, low-yield
 * source), an upsert failure, OR a coalesce into an already-pending row for the
 * conversation. Budget-metered callers reserve one unit of the daily cap only
 * on a `true` return, so neither a skipped source nor a coalesced trigger (which
 * cannot spawn a second retrospective) consumes budget.
 */
export function enqueueMemoryRetrospectiveIfEnabled(args: {
  conversationId: string;
  trigger: MemoryRetrospectiveTrigger;
}): boolean {
  const { conversationId, trigger } = args;

  if (!isMemoryEnabled()) {
    return false;
  }

  if (isMemoryRetrospectiveConversation(conversationId)) {
    log.debug(
      { conversationId, trigger },
      "Skipping memory-retrospective enqueue: source is a memory-retrospective conversation",
    );
    return false;
  }

  if (isLowYieldRetrospectiveSource(conversationId)) {
    log.debug(
      { conversationId, trigger },
      "Skipping memory-retrospective enqueue: scheduled or consolidation source",
    );
    return false;
  }

  const runAfter =
    trigger === "compaction" ? Date.now() + COMPACTION_DEBOUNCE_MS : Date.now();

  try {
    return upsertMemoryRetrospectiveJob({ conversationId }, runAfter);
  } catch (err) {
    log.warn(
      { err, conversationId, trigger },
      "Failed to upsert memory-retrospective job",
    );
    return false;
  }
}

/**
 * Recursion guard. The retrospective bootstraps its own background
 * conversation; without this check, that conversation's lifecycle would
 * enqueue another retrospective on top of it, recursing.
 */
export function isMemoryRetrospectiveConversation(
  conversationId: string,
): boolean {
  const source = getConversationSource(conversationId);
  return source !== null && isMemoryRetrospectiveSource(source);
}

/**
 * Scheduled task threads (location/health pulses) rarely carry anything worth
 * remembering, and memory-consolidation conversations already persist their
 * output to the corpus — a retrospective over either burns an inference pass
 * for no unique gain (and, for consolidation, re-stores already-captured
 * content). Heartbeat (`background`) and standard conversations are unaffected.
 */
function isLowYieldRetrospectiveSource(conversationId: string): boolean {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return false;
  }
  return (
    conversation.conversationType === "scheduled" ||
    conversation.source === MEMORY_V2_CONSOLIDATION_SOURCE
  );
}

/**
 * Fire a memory-retrospective enqueue from the compaction site. Trust-class
 * gated (don't run a guardian-trust background loop over untrusted-actor
 * conversations) with best-effort error swallowing (never block compaction
 * on enqueue failures).
 */
export function enqueueMemoryRetrospectiveOnCompaction(
  conversationId: string,
  trustClass: TrustClass | undefined,
): void {
  if (!resolveCapabilities(trustClass).canAccessMemory) {
    return;
  }
  try {
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId,
      trigger: "compaction",
    });
  } catch {
    // Best-effort — never block compaction on enqueue failures.
  }
}
