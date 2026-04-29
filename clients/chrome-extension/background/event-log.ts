/**
 * In-memory ring buffer for chrome extension relay events.
 *
 * Captures incoming requests, outgoing results, cancellations, and
 * session events — everything except keepalive heartbeats. The popup
 * reads the log via a `get-event-log` message to show recent activity
 * in the Connected tab.
 *
 * Only the last {@link MAX_ENTRIES} entries are retained. The buffer is
 * ephemeral — it resets when the service worker restarts.
 */

// ── Types ───────────────────────────────────────────────────────────

export type EventLogDirection = "inbound" | "outbound";

export interface EventLogEntry {
  /** Monotonically increasing ID for stable ordering. */
  id: number;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Whether the event was received from the server or sent by the extension. */
  direction: EventLogDirection;
  /** Event type label (e.g. 'host_browser_request', 'host_browser_result'). */
  eventType: string;
  /** Optional short summary for display. */
  summary?: string;
  /** Whether the event represents an error condition. */
  isError?: boolean;
}

// ── Ring buffer ─────────────────────────────────────────────────────

const MAX_ENTRIES = 100;

let nextId = 1;
const buffer: EventLogEntry[] = [];

export function appendEvent(
  direction: EventLogDirection,
  eventType: string,
  opts?: { summary?: string; isError?: boolean },
): EventLogEntry {
  const entry: EventLogEntry = {
    id: nextId++,
    timestamp: new Date().toISOString(),
    direction,
    eventType,
    summary: opts?.summary,
    isError: opts?.isError,
  };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.shift();
  }
  return entry;
}

/** Return a snapshot of the log (oldest first). */
export function getEventLog(): EventLogEntry[] {
  return [...buffer];
}

/** Clear the log (mainly for testing). */
export function clearEventLog(): void {
  buffer.length = 0;
  nextId = 1;
}
