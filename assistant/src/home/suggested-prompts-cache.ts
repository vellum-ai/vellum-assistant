/**
 * Checkpoint-backed cache for the Home feed's assistant-generated suggested
 * prompts.
 *
 * Split out from `suggested-prompts.ts` (the LLM generation path) so the cache
 * read/write/invalidate surface stays dependency-light: OAuth connect/disconnect
 * paths invalidate the cache without pulling in the heavy prompt-generation
 * subtree (system-prompt builder, provider send, sidechain).
 *
 * The cache persists in the `memory_checkpoints` table so a daemon restart does
 * not force a regeneration.
 */

import {
  deleteMemoryCheckpoint,
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../persistence/checkpoints.js";
import { buildAssistantEvent } from "../runtime/assistant-event.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import { getLogger } from "../util/logger.js";
import type { SuggestedPrompt } from "./feed-types.js";

const log = getLogger("suggested-prompts-cache");

const LLM_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const CHECKPOINT_KEY_JSON = "home:suggested_prompts:json";
const CHECKPOINT_KEY_TIMESTAMP = "home:suggested_prompts:cached_at";

export function readCachedPrompts(): SuggestedPrompt[] | null {
  try {
    const json = getMemoryCheckpoint(CHECKPOINT_KEY_JSON);
    const timestampStr = getMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP);
    if (!json || !timestampStr) {
      return null;
    }
    const cachedAt = Number(timestampStr);
    if (isNaN(cachedAt) || Date.now() - cachedAt > LLM_CACHE_TTL_MS) {
      return null;
    }
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed as SuggestedPrompt[];
  } catch {
    return null;
  }
}

export function writeCachedPrompts(prompts: SuggestedPrompt[]): boolean {
  try {
    setMemoryCheckpoint(CHECKPOINT_KEY_JSON, JSON.stringify(prompts));
    setMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP, String(Date.now()));
    return true;
  } catch {
    // Cache write failure is non-fatal — the next refresh regenerates.
    return false;
  }
}

/**
 * Drops the suggestion cache so the next on-demand refresh regenerates
 * prompts with current integration state.
 *
 * Called from OAuth connect/disconnect paths so suggestions reflect the
 * new state within one reload instead of waiting for the TTL.
 */
export function invalidateAssistantSuggestedPromptsCache(): void {
  try {
    deleteMemoryCheckpoint(CHECKPOINT_KEY_JSON);
    deleteMemoryCheckpoint(CHECKPOINT_KEY_TIMESTAMP);
  } catch {
    // Invalidation failure is non-fatal — the TTL still bounds staleness.
  }
  assistantEventHub
    .publish(
      buildAssistantEvent({
        type: "home_feed_updated",
        updatedAt: new Date().toISOString(),
        newItemCount: 0,
      }),
    )
    .catch((err) => {
      log.warn(
        { err },
        "Failed to publish home_feed_updated after prompt cache invalidation",
      );
    });
}
