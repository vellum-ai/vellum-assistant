import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import {
  isMemoryEnabled,
  upsertAutoAnalysisJob,
} from "../../persistence/jobs-store.js";
import { isMemoryRetrospectiveConversation } from "../../plugins/defaults/memory/memory-retrospective-enqueue.js";
import { getLogger } from "../../util/logger.js";
import { type TrustClass } from "../actor-trust-resolver.js";
import { resolveCapabilities } from "../capabilities.js";
import { isAutoAnalysisConversation } from "./auto-analysis-guard.js";

const log = getLogger("auto-analysis-enqueue");

/**
 * Trigger reason for an auto-analysis enqueue.
 *   - `"batch"`: source conversation crossed the batch threshold — enqueue
 *     immediately (`runAfter = now`) but still upsert so a pending job
 *     coalesces rapid threshold crossings into one.
 *   - `"idle"`: source conversation has been idle long enough to warrant a
 *     debounced analysis pass.
 *   - `"lifecycle"`: a conversation lifecycle transition (e.g. resume,
 *     close) should trigger a debounced analysis pass.
 *   - `"compaction"`: context was just compacted — some recent turns are
 *     now hidden behind a summary, so crystallize anything worth
 *     remembering before the window narrows further. Fires immediately
 *     (`runAfter = now`) like `"batch"`.
 */
export type AutoAnalysisTrigger = "batch" | "idle" | "lifecycle" | "compaction";

/**
 * Conditionally enqueue a `conversation_analyze` job for the given
 * conversation. Skips silently when:
 *   - the `auto-analyze` feature flag is disabled, OR
 *   - the source conversation is itself an auto-analysis conversation
 *     (recursion guard — we never analyze our own analysis output), OR
 *   - the source conversation is a memory-retrospective conversation.
 *     Fork-kind retrospectives carry a full copy of the source
 *     conversation's history, so auto-analyzing one would re-process the
 *     entire source conversation and double-write memory.
 *
 * Immediate triggers (`"batch"`, `"compaction"`) and debounced triggers
 * (`"idle"`, `"lifecycle"`) are written to separate rows keyed by a
 * `triggerGroup` discriminator. This prevents an idle enqueue from
 * pushing an already-scheduled batch row's `runAfter` into the future
 * (and vice versa). Within each group, rapid enqueues still coalesce to
 * a single pending row via `upsertAutoAnalysisJob`.
 */
export function enqueueAutoAnalysisIfEnabled(args: {
  conversationId: string;
  trigger: AutoAnalysisTrigger;
}): void {
  const { conversationId, trigger } = args;

  if (!isMemoryEnabled()) {
    return;
  }

  let config;
  try {
    config = getConfig();
  } catch (err) {
    log.warn(
      { err, conversationId },
      "Skipping auto-analysis enqueue: failed to load config",
    );
    return;
  }

  if (!isAssistantFeatureFlagEnabled("auto-analyze", config)) {
    return;
  }

  if (isAutoAnalysisConversation(conversationId)) {
    log.debug(
      { conversationId, trigger },
      "Skipping auto-analysis enqueue: source is an auto-analysis conversation",
    );
    return;
  }

  if (isMemoryRetrospectiveConversation(conversationId)) {
    log.debug(
      { conversationId, trigger },
      "Skipping auto-analysis enqueue: source is a memory-retrospective conversation",
    );
    return;
  }

  const idleTimeoutMs = config.analysis?.idleTimeoutMs ?? 600_000;
  const runImmediately = trigger === "batch" || trigger === "compaction";
  const triggerGroup: "immediate" | "debounced" = runImmediately
    ? "immediate"
    : "debounced";
  const runAfter = runImmediately ? Date.now() : Date.now() + idleTimeoutMs;

  try {
    upsertAutoAnalysisJob({ conversationId, triggerGroup }, runAfter);
  } catch (err) {
    log.warn(
      { err, conversationId, trigger },
      "Failed to enqueue auto-analysis job",
    );
  }
}

/**
 * Fire an auto-analysis enqueue from a compaction site. Wraps
 * `enqueueAutoAnalysisIfEnabled` with the trust-class gate and
 * best-effort error handling used at every compaction call site, so
 * the six compaction paths (forceCompact, preflight, overflow reducer,
 * mid-loop, and two emergency paths) stay in sync.
 *
 * Trust gate mirrors the memory-extraction trust boundary applied in
 * `disposeConversation` — we don't trigger analysis (which runs with
 * guardian trust + full tools) for conversations with an untrusted actor.
 */
export function enqueueAutoAnalysisOnCompaction(
  conversationId: string,
  trustClass: TrustClass | undefined,
): void {
  if (!resolveCapabilities(trustClass).canAccessMemory) {
    return;
  }
  try {
    enqueueAutoAnalysisIfEnabled({ conversationId, trigger: "compaction" });
  } catch {
    // Best-effort — never block compaction on enqueue failures.
  }
}
