/**
 * Module-level SSE stream debugging tracker.
 *
 * Records every SSE event that flows through {@link subscribeChatEvents}
 * and maintains a lightweight registry of active/past stream clients.
 *
 * Data is stored outside React state so it survives component unmounts and
 * can be inspected from the console via `window._vellumDebug.chat.events`.
 */

import type { AssistantEvent } from "@/domains/chat/api/event-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseDebugClient {
  /** Stable client identifier. */
  id: string;
  /** The AbortController signal for this client attempt. */
  abortSignal: AbortSignal;
  /** Conversation key the stream was opened against. */
  conversationKey: string | undefined;
  /** When the client was first registered (before the fetch started). */
  initiatedAt: number;
  /** When the first SSE data frame arrived (null until then). */
  establishedAt: number | null;
}

export interface SseDebugEventEntry {
  /** Which client produced this event. */
  clientId: string;
  /** Millisecond timestamp when the event was received. */
  receivedAt: number;
  /** The parsed event payload. */
  event: AssistantEvent;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EVENTS = 1000;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let nextClientId = 0;
const clients = new Map<string, SseDebugClient>();
const events: SseDebugEventEntry[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a new stream client attempt. Called immediately when
 * {@link subscribeChatEvents} starts a new connection.
 */
export function registerSseClient(
  abortSignal: AbortSignal,
  conversationKey: string | undefined,
): string {
  const id = `sse-${++nextClientId}`;
  const client: SseDebugClient = {
    id,
    abortSignal,
    conversationKey,
    initiatedAt: Date.now(),
    establishedAt: null,
  };
  clients.set(id, client);

  // Auto-clean when the signal aborts so the registry doesn't grow forever.
  const onAbort = () => {
    clients.delete(id);
  };
  if (abortSignal.aborted) {
    onAbort();
  } else {
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  return id;
}

/**
 * Mark a client as having received its first data frame. Called from the
 * `onSseEvent` callback inside {@link subscribeChatEvents}.
 */
export function markClientEstablished(clientId: string): void {
  const client = clients.get(clientId);
  if (client && client.establishedAt === null) {
    client.establishedAt = Date.now();
  }
}

/**
 * Push a parsed event into the ring buffer. Called from the `onEvent`
 * callback inside {@link subscribeChatEvents}.
 */
export function pushSseEvent(clientId: string, event: AssistantEvent): void {
  events.push({
    clientId,
    receivedAt: Date.now(),
    event,
  });
  if (events.length > MAX_EVENTS) {
    events.shift();
  }
}

/**
 * Return a snapshot of all registered or recently-registered clients.
 * Aborted clients are omitted because the `abort` listener cleans them up.
 */
export function getSseClients(): SseDebugClient[] {
  return Array.from(clients.values());
}

/**
 * Return the last N events (most recent last) with a cap of {@link MAX_EVENTS}.
 */
export function getSseEvents(limit = MAX_EVENTS): SseDebugEventEntry[] {
  const start = Math.max(0, events.length - limit);
  return events.slice(start);
}

/**
 * Remove a client from the debug registry. Idempotent — safe to call
 * even if the client was already removed (for example by an abort
 * listener or a prior reconnect cleanup).
 */
export function unregisterSseClient(clientId: string): void {
  clients.delete(clientId);
}

/**
 * Reset all module-level state. Intended for test isolation only.
 * @internal
 */
export function resetSseDebugStateForTests(): void {
  nextClientId = 0;
  clients.clear();
  events.length = 0;
}
