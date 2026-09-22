// ---------------------------------------------------------------------------
// Memory retrospective — enqueue helper.
// ---------------------------------------------------------------------------
//
// Enqueue a `memory_retrospective` job for the given conversation. Gates on:
//   - `memory.enabled` (the whole memory system) and
//     `memory.retrospective.enabled` (this pass alone).
//   - The conversation is eligible under `classifyRetrospectiveEligibility`
//     (`memory-retrospective-eligibility.ts`): not a memory-retrospective
//     conversation (recursion guard: we never run a retrospective over
//     reflective musings from the retrospective agent's own writes), not a
//     `scheduled` thread, not a memory-consolidation background, and not a
//     retired auto-analysis row (all low yield). The same classification is
//     what the per-turn capture guidance tells the model, so the funnel and
//     the prompt cannot disagree.
//   - The unprocessed tail contains user activity, when
//     `memory.retrospective.requireUserActivity` is on. Assistant-only
//     stretches (proactive sends composed by turns running elsewhere) carry
//     no user turn, so their window anchor is undecidable and their content
//     is a recap of work captured at its source; the gate defers them until
//     real user activity arrives. Living here, every trigger kind funnels
//     through one check.
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

import { getConfig } from "../../../config/loader.js";
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
import { hasQualifyingUserMessageAfter } from "./memory-retrospective-accounting.js";
import { isMemoryRetrospectiveSource } from "./memory-retrospective-constants.js";
import { retrospectiveCursor } from "./memory-retrospective-cursor.js";
import { classifyRetrospectiveEligibility } from "./memory-retrospective-eligibility.js";
import { getRetrospectiveState } from "./memory-retrospective-state.js";

const log = getLogger("memory-retrospective-enqueue");

export type MemoryRetrospectiveTrigger =
  | "interval"
  | "message_count"
  | "compaction"
  | "sweep";

const COMPACTION_DEBOUNCE_MS = 500;

/**
 * Returns true when a job row was upserted, false when a gate skipped the
 * enqueue (or the upsert failed). The sweep counts only true returns toward
 * its per-pass cap.
 */
export function enqueueMemoryRetrospectiveIfEnabled(args: {
  conversationId: string;
  trigger: MemoryRetrospectiveTrigger;
}): boolean {
  const { conversationId, trigger } = args;

  const memoryEnabled = isMemoryEnabled();
  // A missing row classifies as an ordinary conversation, matching the
  // per-row gates this replaces (each read "no row" as "no reason to skip").
  const conversation = getConversation(conversationId);
  const eligibility = classifyRetrospectiveEligibility({
    conversationType: conversation?.conversationType ?? "standard",
    source: conversation?.source ?? "user",
    memoryEnabled,
    retrospectiveEnabled: memoryEnabled && isRetrospectiveEnabled(),
  });
  if (eligibility.status === "ineligible") {
    switch (eligibility.reason) {
      case "memory_disabled":
        break;
      case "retrospective_disabled":
        log.debug(
          { conversationId, trigger },
          "Skipping memory-retrospective enqueue: memory.retrospective.enabled is false",
        );
        break;
      case "retrospective_conversation":
        log.debug(
          { conversationId, trigger },
          "Skipping memory-retrospective enqueue: source is a memory-retrospective conversation",
        );
        break;
      case "consolidation":
      case "scheduled":
        log.debug(
          { conversationId, trigger },
          "Skipping memory-retrospective enqueue: scheduled or consolidation source",
        );
        break;
      case "auto_analysis":
        log.debug(
          { conversationId, trigger },
          "Skipping memory-retrospective enqueue: auto-analysis source",
        );
        break;
    }
    return false;
  }

  if (!passesUserActivityGate(conversationId, trigger)) {
    return false;
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
    return false;
  }
  return true;
}

/**
 * The `memory.retrospective.enabled` kill switch. Deliberately fails CLOSED,
 * unlike the heuristic gates around it: this flag exists to stop a
 * fork-driven write burst from locking the DB, so an unreadable config must
 * not resurrect the very work an operator turned off. A read that throws is
 * logged rather than swallowed silently.
 */
function isRetrospectiveEnabled(): boolean {
  try {
    return getConfig().memory.retrospective.enabled;
  } catch (err) {
    log.warn(
      { err },
      "Could not read memory.retrospective.enabled; treating retrospectives as disabled",
    );
    return false;
  }
}

/**
 * The `memory.retrospective.requireUserActivity` gate: pass when the config
 * is off or the unprocessed tail (everything after the conversation's
 * retrospective cursor) contains at least one user message carrying
 * non-tool_result content. A gate that cannot be evaluated (config or DB
 * unavailable) passes — an unevaluable gate must not silence retrospectives.
 */
function passesUserActivityGate(
  conversationId: string,
  trigger: MemoryRetrospectiveTrigger,
): boolean {
  try {
    if (!getConfig().memory.retrospective.requireUserActivity) {
      return true;
    }
    const state = getRetrospectiveState(conversationId);
    if (
      hasQualifyingUserMessageAfter(conversationId, retrospectiveCursor(state))
    ) {
      return true;
    }
    log.debug(
      { conversationId, trigger },
      "Skipping memory-retrospective enqueue: no user activity in the unprocessed tail",
    );
    return false;
  } catch (err) {
    log.warn(
      { err, conversationId, trigger },
      "User-activity gate check failed; enqueueing anyway",
    );
    return true;
  }
}

/**
 * Recursion guard for callers that only have a conversation id (the post-turn
 * indexer): the retrospective bootstraps its own background conversation, and
 * without this check that conversation's lifecycle would enqueue another
 * retrospective on top of it. The funnel above reaches the same verdict
 * through `classifyRetrospectiveEligibility`'s `retrospective_conversation`.
 */
export function isMemoryRetrospectiveConversation(
  conversationId: string,
): boolean {
  const source = getConversationSource(conversationId);
  return source !== null && isMemoryRetrospectiveSource(source);
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
