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
// All four trigger types funnel through `upsertMemoryRetrospectiveJob` which
// coalesces rapid enqueues into a single pending row per conversation.
// `lifecycle` and `compaction` triggers get a small debounce so the job runs
// after the corresponding signal settles; `interval` and `message_count`
// fire immediately.

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
import { getLogger } from "../../../util/logger.js";
import { isMemoryRetrospectiveSource } from "./memory-retrospective-constants.js";
import { MEMORY_V2_CONSOLIDATION_SOURCE } from "./v2/constants.js";

const log = getLogger("memory-retrospective-enqueue");

export type MemoryRetrospectiveTrigger =
  | "interval"
  | "message_count"
  | "compaction"
  | "lifecycle";

const COMPACTION_DEBOUNCE_MS = 500;

export function enqueueMemoryRetrospectiveIfEnabled(args: {
  conversationId: string;
  trigger: MemoryRetrospectiveTrigger;
}): void {
  const { conversationId, trigger } = args;

  if (!isMemoryEnabled()) {
    return;
  }

  if (isMemoryRetrospectiveConversation(conversationId)) {
    log.debug(
      { conversationId, trigger },
      "Skipping memory-retrospective enqueue: source is a memory-retrospective conversation",
    );
    return;
  }

  if (isLowYieldRetrospectiveSource(conversationId)) {
    log.debug(
      { conversationId, trigger },
      "Skipping memory-retrospective enqueue: scheduled or consolidation source",
    );
    return;
  }

  const runAfter =
    trigger === "compaction" ? Date.now() + COMPACTION_DEBOUNCE_MS : Date.now();

  try {
    upsertMemoryRetrospectiveJob({ conversationId }, runAfter);
  } catch (err) {
    log.warn(
      { err, conversationId, trigger },
      "Failed to upsert memory-retrospective job",
    );
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
  if (!conversation) return false;
  return (
    conversation.conversationType === "scheduled" ||
    conversation.source === MEMORY_V2_CONSOLIDATION_SOURCE
  );
}

/**
 * Fire a memory-retrospective enqueue from the compaction site. Mirrors
 * `enqueueAutoAnalysisOnCompaction` — same trust-class gate (don't run a
 * guardian-trust background loop over untrusted-actor conversations) and
 * same best-effort error swallowing (never block compaction on enqueue
 * failures).
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
