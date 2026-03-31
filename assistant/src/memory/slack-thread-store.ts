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
