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
 * Read-side accessor for the in-memory thread mapping. Returns the
 * `threadTs` previously associated with this conversation via
 * {@link setThreadTs}, or `null` if no mapping exists. Does not bump
 * `lastUsedAt` or otherwise mutate the entry — pure lookup.
 */
export function getThreadTs(conversationId: string): string | null {
  const mapping = threadMappings.get(conversationId);
  return mapping ? mapping.threadTs : null;
}

/**
 * Read both `threadTs` and `channelId` without mutating the entry. Used by
 * dispatch to snapshot pre-update state so a turn that ends up rejected
 * as already-processing can restore the in-flight turn's mapping.
 */
export function peekThreadMapping(
  conversationId: string,
): { threadTs: string; channelId: string } | null {
  const mapping = threadMappings.get(conversationId);
  return mapping
    ? { threadTs: mapping.threadTs, channelId: mapping.channelId }
    : null;
}

/**
 * Drop any thread mapping associated with this conversation. Called on
 * inbound Slack turns that arrive at the channel root (no `threadTs` on
 * the callback URL) so that a stale mapping from a prior in-thread turn
 * cannot be copied onto the outbound reply's `slackMeta`. Without this,
 * a channel-root reply following an earlier thread turn would be
 * persisted as if it belonged to the old thread.
 */
export function clearThreadTs(conversationId: string): void {
  threadMappings.delete(conversationId);
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
 * Extract the messageTs from a Slack reply callback URL, if present.
 * The gateway encodes messageTs for non-threaded DMs so the runtime
 * can target the original message for emoji-based indicators.
 */
export function extractMessageTsFromCallbackUrl(
  callbackUrl: string | undefined,
): string | null {
  if (!callbackUrl) return null;
  try {
    const url = new URL(callbackUrl);
    return url.searchParams.get("messageTs");
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

  // If still at capacity after TTL sweep, evict oldest entries (LRU)
  if (threadMappings.size >= MAX_MAPPINGS) {
    const entries = [...threadMappings.entries()].sort(
      (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    );
    const toRemove = entries.slice(0, entries.length - MAX_MAPPINGS + 1);
    for (const [convId] of toRemove) {
      threadMappings.delete(convId);
    }
  }
}
