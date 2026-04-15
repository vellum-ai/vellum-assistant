import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getConfig } from "../config/loader.js";
import { getLogger } from "../util/logger.js";
import { isAutoAnalysisConversation } from "./auto-analysis-guard.js";
import { enqueueMemoryJob, upsertDebouncedJob } from "./jobs-store.js";

const log = getLogger("auto-analysis-enqueue");

/**
 * Trigger reason for an auto-analysis enqueue.
 *   - `"batch"`: source conversation crossed the batch threshold — enqueue
 *     immediately (no debounce).
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
 *     (recursion guard — we never analyze our own analysis output).
 *
 * Uses `upsertDebouncedJob()` for `"idle"` / `"lifecycle"` triggers and
 * `enqueueMemoryJob()` for `"batch"` triggers, mirroring how
 * `graph_extract` is enqueued in `indexer.ts`.
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

  const idleTimeoutMs = config.analysis?.idleTimeoutMs ?? 600_000;

  try {
    if (trigger === "batch") {
      enqueueMemoryJob("conversation_analyze", { conversationId });
    } else {
      // "idle" or "lifecycle" — debounce against duplicate pending jobs.
      upsertDebouncedJob(
        "conversation_analyze",
        { conversationId },
        Date.now() + idleTimeoutMs,
      );
    }
  } catch (err) {
    log.warn(
      { err, conversationId, trigger },
      "Failed to enqueue auto-analysis job",
    );
  }
}
