/**
 * Slack conversation-to-thread mapping store.
 *
 * Tracks which Slack thread (identified by `threadTs`) is associated with
 * each conversation. When the assistant starts a new topic in a channel,
 * a new thread is created; when continuing a related conversation, replies
 * are sent to the existing thread.
 *
 * Uses an in-memory map with TTL eviction. Thread mappings are also
 * persisted as conversation metadata so they survive daemon restarts.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("slack-thread-store");

// ── In-memory thread mapping ────────────────────────────────────────

interface ThreadMapping {
  threadTs: string;
  channelId: string;
  createdAt: number;
  lastUsedAt: number;
}

/** Map from conversationId to thread mapping. */
const threadMappings = new Map<string, ThreadMapping>();

/** TTL for thread mappings — 24 hours. After this, a new thread is started. */
const THREAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard cap on stored mappings to bound memory. */
const MAX_MAPPINGS = 5_000;

/**
 * Look up the Slack thread timestamp for a conversation.
 * Returns null if no active thread mapping exists or the mapping has expired.
 */
export function getThreadTs(
  conversationId: string,
  channelId: string,
): string | null {
  const mapping = threadMappings.get(conversationId);
  if (!mapping) return null;

  // Must be for the same channel
  if (mapping.channelId !== channelId) return null;

  // Check TTL
  if (Date.now() - mapping.lastUsedAt > THREAD_TTL_MS) {
    threadMappings.delete(conversationId);
    return null;
  }

  // Update last-used timestamp
  mapping.lastUsedAt = Date.now();
  return mapping.threadTs;
}

/**
 * Associate a conversation with a Slack thread. Called when:
 * - An inbound message arrives with a threadTs (from the gateway callback URL)
 * - The assistant creates a new thread for a channel conversation
 */
export function setThreadTs(
  conversationId: string,
  channelId: string,
  threadTs: string,
): void {
  evictExpiredIfNeeded();

  const existing = threadMappings.get(conversationId);
  if (existing) {
    existing.threadTs = threadTs;
    existing.channelId = channelId;
    existing.lastUsedAt = Date.now();
    return;
  }

  threadMappings.set(conversationId, {
    threadTs,
    channelId,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });

  log.debug({ conversationId, channelId, threadTs }, "Thread mapping created");
}

/**
 * Remove the thread mapping for a conversation.
 * Called when a conversation should start a fresh thread.
 */
export function clearThreadTs(conversationId: string): void {
  threadMappings.delete(conversationId);
}

/**
 * Get all active thread mappings for a channel.
 * Useful for diagnostics and the configure tool.
 */
export function getChannelThreadMappings(
  channelId: string,
): Array<{ conversationId: string; threadTs: string; lastUsedAt: number }> {
  const results: Array<{
    conversationId: string;
    threadTs: string;
    lastUsedAt: number;
  }> = [];

  const now = Date.now();
  for (const [convId, mapping] of threadMappings) {
    if (mapping.channelId !== channelId) continue;
    if (now - mapping.lastUsedAt > THREAD_TTL_MS) continue;
    results.push({
      conversationId: convId,
      threadTs: mapping.threadTs,
      lastUsedAt: mapping.lastUsedAt,
    });
  }

  return results;
}

/**
 * Extract the threadTs from a Slack reply callback URL, if present.
 * The gateway encodes threadTs as a query parameter on the callback URL.
 */
export function extractThreadTsFromCallbackUrl(
  callbackUrl: string | undefined,
): string | null {
  if (!callbackUrl) return null;
  try {
    const url = new URL(callbackUrl);
    return url.searchParams.get("threadTs");
  } catch {
    return null;
  }
}

/**
 * Extract the channel from a Slack reply callback URL, if present.
 */
export function extractChannelFromCallbackUrl(
  callbackUrl: string | undefined,
): string | null {
  if (!callbackUrl) return null;
  try {
    const url = new URL(callbackUrl);
    return url.searchParams.get("channel");
  } catch {
    return null;
  }
}

// ── Internal helpers ────────────────────────────────────────────────

function evictExpiredIfNeeded(): void {
  if (threadMappings.size < MAX_MAPPINGS) return;

  const now = Date.now();
  for (const [convId, mapping] of threadMappings) {
    if (now - mapping.lastUsedAt >= THREAD_TTL_MS) {
      threadMappings.delete(convId);
    }
  }
}

// ── Test helpers ────────────────────────────────────────────────────

/**
 * Clear all thread mappings. Used in tests for isolation.
 */
export function resetAllThreadMappings(): void {
  threadMappings.clear();
}
