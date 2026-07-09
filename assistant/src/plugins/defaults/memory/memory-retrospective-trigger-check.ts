// ---------------------------------------------------------------------------
// Memory retrospective — periodic trigger check.
// ---------------------------------------------------------------------------
//
// Called from post-turn hooks (after each agent turn completes). Decides
// whether to enqueue a retrospective for this conversation based on:
//
//   1. Cooldown gate: never within `minCooldownMs` of the last attempt
//      (success or failure). Prevents tight retry loops across trigger
//      types.
//   2. Interval threshold: time since last attempt >= `timeThresholdMs`.
//   3. Message count threshold: new messages since `lastProcessedMessageId`
//      >= `messageThreshold`.
//
// First-run case (no state row) skips the cooldown — `lastRunAt = 0` so the
// gap is effectively `Infinity`. The interval threshold trips immediately;
// the message-count threshold trips once enough messages accumulate.
//
// The count is kind-aware: the retrospective's own `skill-authored-card`
// message is inserted AFTER the cursor it just persisted, so the generic
// count would treat it as unprocessed content and re-wake a retrospective
// over the assistant's own card. See `memory-retrospective-accounting.ts`.

import type { AssistantConfig } from "../../../config/types.js";
import { getLogger } from "../../../util/logger.js";
import { countRetrospectiveMessagesAfter } from "./memory-retrospective-accounting.js";
import { enqueueMemoryRetrospectiveIfEnabled } from "./memory-retrospective-enqueue.js";
import { getRetrospectiveState } from "./memory-retrospective-state.js";

const log = getLogger("memory-retrospective-trigger-check");

export type RetrospectiveTrigger = "interval" | "message_count";

/**
 * Returns the trigger kind that fired, or `null` if no threshold tripped.
 * Exported separately from `maybeEnqueueRetrospective` so tests can assert on
 * the decision without observing side effects.
 */
export function shouldEnqueueRetrospective(args: {
  state: { lastProcessedMessageId: string; lastRunAt: number } | null;
  newMessageCount: number;
  now: number;
  timeThresholdMs: number;
  messageThreshold: number;
  minCooldownMs: number;
}): RetrospectiveTrigger | null {
  const {
    state,
    newMessageCount,
    now,
    timeThresholdMs,
    messageThreshold,
    minCooldownMs,
  } = args;

  if (state && now - state.lastRunAt < minCooldownMs) return null;

  if (state && now - state.lastRunAt >= timeThresholdMs) return "interval";
  if (!state) return "interval";

  if (newMessageCount >= messageThreshold) return "message_count";
  return null;
}

/**
 * Post-turn hook entry point. Looks up state, counts new messages, evaluates
 * thresholds, and enqueues if appropriate. Best-effort — any thrown error is
 * caught and logged so the agent turn cleanup path doesn't fail.
 */
export function maybeEnqueueRetrospective(
  conversationId: string,
  config: AssistantConfig,
): void {
  try {
    const state = getRetrospectiveState(conversationId);
    const newMessageCount = countRetrospectiveMessagesAfter(
      conversationId,
      state?.lastProcessedMessageId ?? null,
    );
    if (newMessageCount === 0) return;

    const trigger = shouldEnqueueRetrospective({
      state,
      newMessageCount,
      now: Date.now(),
      timeThresholdMs: config.memory.retrospective.timeThresholdMs,
      messageThreshold: config.memory.retrospective.messageThreshold,
      minCooldownMs: config.memory.retrospective.minCooldownMs,
    });
    if (!trigger) return;

    enqueueMemoryRetrospectiveIfEnabled({ conversationId, trigger });
  } catch (err) {
    log.warn({ err, conversationId }, "trigger-check failed; skipping enqueue");
  }
}
