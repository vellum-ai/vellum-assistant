import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { isAutoAnalysisConversation } from "./auto-analysis-guard.js";
import { getConversationType } from "./conversation-crud.js";
import { upsertDebouncedJob } from "./jobs-store.js";

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
 */
export type AutoAnalysisTrigger = "batch" | "idle" | "lifecycle";

/**
 * Conditionally enqueue a `conversation_analyze` job for the given
 * conversation. Skips silently when:
 *   - the `auto-analyze` feature flag is disabled, OR
 *   - the source conversation is itself an auto-analysis conversation
 *     (recursion guard — we never analyze our own analysis output), OR
 *   - the source conversation is private (`analyzeConversation` rejects
 *     private conversations, so enqueueing would guarantee a failed job).
 *
 * All triggers route through `upsertDebouncedJob()` so a pending job for
 * the same conversation coalesces additional enqueue attempts into a
 * single row (no duplicates). `"batch"` fires immediately
 * (`runAfter = now`); `"idle"` / `"lifecycle"` debounce by
 * `analysis.idleTimeoutMs`.
 */
export function enqueueAutoAnalysisIfEnabled(args: {
  conversationId: string;
  trigger: AutoAnalysisTrigger;
}): void {
  const { conversationId, trigger } = args;

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

  if (getConversationType(conversationId) === "private") {
    log.debug(
      { conversationId, trigger },
      "Skipping auto-analysis enqueue: source is a private conversation",
    );
    return;
  }

  const idleTimeoutMs = config.analysis?.idleTimeoutMs ?? 600_000;
  const runAfter =
    trigger === "batch" ? Date.now() : Date.now() + idleTimeoutMs;

  try {
    upsertDebouncedJob(
      "conversation_analyze",
      { conversationId },
      runAfter,
    );
  } catch (err) {
    log.warn(
      { err, conversationId, trigger },
      "Failed to enqueue auto-analysis job",
    );
  }
}
