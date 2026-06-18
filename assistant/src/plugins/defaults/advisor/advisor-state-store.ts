/**
 * Per-conversation capture store for the advisor plugin.
 *
 * A tool's `execute` does not receive the conversation transcript — only
 * lifecycle hooks do. So the hooks snapshot what the executor saw (the system
 * prompt from `pre-model-call`, the running transcript from `post-model-call`)
 * into this module-level store, keyed by conversation id, and the `advisor`
 * tool reads the latest snapshot when the model calls it. This reproduces the
 * advisor-tool property that the model calls the tool with no arguments and the
 * full context is supplied for it.
 *
 * Bounded by a small LRU so a long-lived daemon does not accumulate state for
 * every conversation it has ever served.
 */

import type { Message } from "../../../providers/types.js";

export interface AdvisorCapture {
  /** The executor's system prompt (steering stripped), or null if unseen. */
  systemPrompt: string | null;
  /** The transcript the executor most recently saw on a `mainAgent` call. */
  messages: Message[];
  /** Last-write timestamp, used for LRU eviction. */
  updatedAt: number;
}

const MAX_CONVERSATIONS = 200;
const store = new Map<string, AdvisorCapture>();

/** Move an entry to most-recently-used and evict the oldest past the cap. */
function bump(conversationId: string, entry: AdvisorCapture): void {
  entry.updatedAt = Date.now();
  store.delete(conversationId);
  store.set(conversationId, entry);
  while (store.size > MAX_CONVERSATIONS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

function ensure(conversationId: string): AdvisorCapture {
  return (
    store.get(conversationId) ?? {
      systemPrompt: null,
      messages: [],
      updatedAt: Date.now(),
    }
  );
}

/**
 * Seed the capture at the start of a user turn with the inbound history, so an
 * advisor call on the very first model turn still has context even before
 * `post-model-call` snapshots the running transcript.
 */
export function seedCapture(
  conversationId: string,
  messages: ReadonlyArray<Message>,
): void {
  const entry = ensure(conversationId);
  entry.messages = [...messages];
  bump(conversationId, entry);
}

/** Record the executor's system prompt (steering already stripped). */
export function recordSystemPrompt(
  conversationId: string,
  systemPrompt: string | null,
): void {
  const entry = ensure(conversationId);
  entry.systemPrompt = systemPrompt;
  bump(conversationId, entry);
}

/** Snapshot the transcript the executor just saw (before tools run). */
export function recordMessages(
  conversationId: string,
  messages: ReadonlyArray<Message>,
): void {
  const entry = ensure(conversationId);
  entry.messages = [...messages];
  bump(conversationId, entry);
}

/** The latest capture for a conversation, or `undefined` if none recorded. */
export function getCapture(conversationId: string): AdvisorCapture | undefined {
  return store.get(conversationId);
}

/** Test-only: clear all captured state. */
export function resetAdvisorStateForTests(): void {
  store.clear();
}
