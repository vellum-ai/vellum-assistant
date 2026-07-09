/**
 * Caching layer for the empty-state (new-chat) greeting generated via the
 * `POST /v1/btw` side-chain with `conversationKey: "greeting"`.
 *
 * Stores a single greeting string with a configurable TTL
 * (`ui.emptyStateGreetingCacheTtlMs`, default 4h). A TTL of `0` (or less)
 * disables caching entirely — reads always miss and writes are skipped — so
 * the greeting regenerates on every request. This is the knob a workspace
 * sets to always receive a fresh greeting.
 *
 * Storage uses the existing `memory_checkpoints` table.
 */

import { getConfig } from "../../config/loader.js";
import {
  getMemoryCheckpoint,
  setMemoryCheckpoint,
} from "../../persistence/checkpoints.js";

const CHECKPOINT_KEY_TEXT = "empty_state:greeting:text";
const CHECKPOINT_KEY_TIMESTAMP = "empty_state:greeting:cached_at";

function scopedCheckpointKey(baseKey: string, scope?: string | null): string {
  const normalizedScope = scope?.trim();
  return normalizedScope ? `${baseKey}:${normalizedScope}` : baseKey;
}

function cacheTtlMs(): number {
  return getConfig().ui.emptyStateGreetingCacheTtlMs;
}

/**
 * Return the cached greeting if present and within the configured TTL.
 * Returns `null` when caching is disabled (TTL <= 0), the cache is empty,
 * or the entry has expired.
 */
export function getCachedEmptyStateGreeting(
  scope?: string | null,
): string | null {
  const ttl = cacheTtlMs();
  if (ttl <= 0) {
    // Caching disabled — always regenerate.
    return null;
  }

  try {
    const text = getMemoryCheckpoint(
      scopedCheckpointKey(CHECKPOINT_KEY_TEXT, scope),
    );
    const timestampStr = getMemoryCheckpoint(
      scopedCheckpointKey(CHECKPOINT_KEY_TIMESTAMP, scope),
    );
    if (!text || !timestampStr) {
      return null;
    }

    const cachedAt = Number(timestampStr);
    if (Number.isNaN(cachedAt) || Date.now() - cachedAt > ttl) {
      return null;
    }

    return text;
  } catch {
    return null;
  }
}

/**
 * Store a freshly generated greeting along with the current timestamp.
 * No-ops when caching is disabled (TTL <= 0) so a zero-TTL workspace never
 * writes a stale entry.
 */
export function setCachedEmptyStateGreeting(
  text: string,
  scope?: string | null,
): void {
  if (cacheTtlMs() <= 0) {
    // Caching disabled — skip write.
    return;
  }

  try {
    setMemoryCheckpoint(scopedCheckpointKey(CHECKPOINT_KEY_TEXT, scope), text);
    setMemoryCheckpoint(
      scopedCheckpointKey(CHECKPOINT_KEY_TIMESTAMP, scope),
      String(Date.now()),
    );
  } catch {
    // Cache write failure is non-fatal — next request will regenerate.
  }
}
