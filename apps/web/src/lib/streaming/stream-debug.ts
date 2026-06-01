/**
 * Module-level SSE stream debugging tracker.
 *
 * Records every SSE event that flows through the stream transport layer
 * and maintains a lightweight registry of active/past stream clients.
 *
 * Data is stored outside React state so it survives component unmounts and
 * can be inspected from the console via `window._vellumDebug.chat.events`.
 */

import type { AssistantEvent } from "@/types/event-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SseDebugClient {
  /** Stable client identifier. */
  id: string;
  /** The AbortController signal for this client attempt. */
  abortSignal: AbortSignal;
  /** Conversation id the stream was opened against. */
  conversationId: string | undefined;
  /** When the client was first registered (before the fetch started). */
  initiatedAt: number;
  /** When the first SSE data frame arrived (null until then). */
  establishedAt: number | null;
  /** Epoch ms of the last SSE frame of any kind (data OR heartbeat). */
  lastTrafficAt: number | null;
  /** Epoch ms of the last SSE *data* frame (excludes heartbeat comments). */
  lastDataAt: number | null;
  /** Count of SSE data frames seen on this client. */
  dataFrames: number;
  /** Count of heartbeat comment frames seen on this client. */
  keepalives: number;
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
  conversationId: string | undefined,
): string {
  const id = `sse-${++nextClientId}`;
  const client: SseDebugClient = {
    id,
    abortSignal,
    conversationId,
    initiatedAt: Date.now(),
    establishedAt: null,
    lastTrafficAt: null,
    lastDataAt: null,
    dataFrames: 0,
    keepalives: 0,
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
 * Record that an SSE frame arrived on a client. Called from the
 * `onSseEvent` callback inside {@link subscribeChatEvents} for every
 * parsed chunk, including heartbeat comment frames. `isData`
 * distinguishes data frames (yielded through the iterator) from
 * heartbeat comments (`data === undefined`), so a reader can tell
 * "bytes are flowing" apart from "the daemon is still keeping the
 * socket warm" — the fingerprint of a half-open connection.
 */
export function recordSseTraffic(clientId: string, isData: boolean): void {
  const client = clients.get(clientId);
  if (!client) {
    return;
  }
  const now = Date.now();
  client.lastTrafficAt = now;
  if (isData) {
    client.lastDataAt = now;
    client.dataFrames++;
  } else {
    client.keepalives++;
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
