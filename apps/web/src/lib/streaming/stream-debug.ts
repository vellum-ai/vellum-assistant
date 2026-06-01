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
}

export interface SseDebugEventEntry {
  /** Which client produced this event. */
  clientId: string;
  /** Millisecond timestamp when the event was received. */
  receivedAt: number;
  /** The parsed event payload. */
  event: AssistantEvent;
}

/**
 * Point-in-time liveness summary of the SSE transport, captured for
 * support bundles. Lets a reader distinguish a healthy connection from
 * a half-open socket that is "alive" at the OS level but has had no
 * bytes flow for minutes.
 */
export interface SseLivenessSnapshot {
  /** Epoch ms of the last SSE frame of any kind (data OR heartbeat). */
  lastTrafficAt: number | null;
  /** Epoch ms of the last SSE *data* frame (excludes heartbeat comments). */
  lastDataAt: number | null;
  /** Age in ms of {@link lastTrafficAt} at capture time, or null if none. */
  msSinceLastTraffic: number | null;
  /** Age in ms of {@link lastDataAt} at capture time, or null if none. */
  msSinceLastData: number | null;
  /** Count of SSE data frames seen since the page loaded. */
  dataFramesSinceLoad: number;
  /** Count of heartbeat comment frames seen since the page loaded. */
  keepalivesSinceLoad: number;
  /** Number of stream clients currently registered (not yet aborted). */
  activeClientCount: number;
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

let lastTrafficAt: number | null = null;
let lastDataAt: number | null = null;
let dataFramesSinceLoad = 0;
let keepalivesSinceLoad = 0;

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
 * Record that an SSE frame arrived. Called from the `onSseEvent`
 * callback inside {@link subscribeChatEvents} for every parsed chunk,
 * including heartbeat comment frames. `isData` distinguishes data
 * frames (yielded through the iterator) from heartbeat comments
 * (`data === undefined`), so liveness can report "bytes are flowing"
 * separately from "the daemon is still keeping the socket warm."
 */
export function recordSseTraffic(isData: boolean): void {
  const now = Date.now();
  lastTrafficAt = now;
  if (isData) {
    lastDataAt = now;
    dataFramesSinceLoad++;
  } else {
    keepalivesSinceLoad++;
  }
}

/**
 * Capture a point-in-time liveness summary of the SSE transport for a
 * support bundle. Ages are computed at call time so the reader sees how
 * long it had been since any byte flowed when the bundle was collected.
 */
export function getSseLivenessSnapshot(): SseLivenessSnapshot {
  const now = Date.now();
  return {
    lastTrafficAt,
    lastDataAt,
    msSinceLastTraffic: lastTrafficAt === null ? null : now - lastTrafficAt,
    msSinceLastData: lastDataAt === null ? null : now - lastDataAt,
    dataFramesSinceLoad,
    keepalivesSinceLoad,
    activeClientCount: clients.size,
  };
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
  lastTrafficAt = null;
  lastDataAt = null;
  dataFramesSinceLoad = 0;
  keepalivesSinceLoad = 0;
}
