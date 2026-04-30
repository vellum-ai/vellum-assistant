/**
 * Ring buffer for chrome extension relay events.
 *
 * Events are stored as correlated **operations** — each inbound request
 * is paired with its outbound result by `requestId`. The popup reads
 * the operation list to show a single row per browser action.
 *
 * Only the last {@link MAX_OPERATIONS} operations are retained.
 *
 * Operations are persisted to `chrome.storage.session` so they survive
 * service worker restarts (MV3 lifecycle) and popup close/reopen. The
 * session store clears automatically when the browser is closed, which
 * is the right lifetime for ephemeral debugging data.
 *
 * The raw event log buffer remains in-memory only — it's lower-value
 * diagnostic data that doesn't need persistence.
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

/**
 * A correlated request → response pair. One row in the activity list.
 */
export interface OperationEntry {
  /** Unique operation ID (monotonically increasing). */
  id: number;
  /** The correlation key (requestId from the host_browser envelope). */
  requestId: string;
  /** The CDP method or synthetic Vellum.* method. */
  operationName: string;
  /** ISO 8601 timestamp of the request. */
  requestedAt: string;
  /** ISO 8601 timestamp of the response, if received. */
  respondedAt?: string;
  /** Duration in milliseconds, if response received. */
  durationMs?: number;
  /** Whether the result was an error. */
  isError?: boolean;
  /** Raw request envelope (for detail view). */
  request?: Record<string, unknown>;
  /** Raw response content string (for detail view). */
  responseContent?: string;
}

// ── Storage keys ────────────────────────────────────────────────────

const STORAGE_KEY_OPS = "eventLog:operations";
const STORAGE_KEY_NEXT_OP_ID = "eventLog:nextOpId";

// ── Ring buffer ─────────────────────────────────────────────────────

const MAX_ENTRIES = 100;
const MAX_OPERATIONS = 50;

let nextId = 1;
const buffer: EventLogEntry[] = [];

let nextOpId = 1;
const operations: OperationEntry[] = [];
const operationsByRequestId = new Map<string, OperationEntry>();

// ── Persistence helpers ─────────────────────────────────────────────

/**
 * Check whether `chrome.storage.session` is available at call time.
 * Evaluated dynamically so test mocks installed after module load
 * are picked up.
 */
function canPersist(): boolean {
  return (
    typeof chrome !== "undefined" &&
    chrome?.storage?.session != null
  );
}

/**
 * Write-through: persist the current operations array and counter to
 * session storage. Fire-and-forget — failures are silently ignored
 * since the in-memory state is always authoritative.
 */
function persistOperations(): void {
  if (!canPersist()) return;
  chrome.storage.session
    .set({
      [STORAGE_KEY_OPS]: operations,
      [STORAGE_KEY_NEXT_OP_ID]: nextOpId,
    })
    .catch(() => {});
}

/**
 * Hydrate in-memory state from session storage. Called once at module
 * load time.
 *
 * Uses a **merge** strategy rather than destructive replacement so that
 * any operations recorded between module load and hydration completion
 * are preserved. Persisted entries whose `requestId` already exists in
 * the live map are skipped — in-memory state is always more recent.
 */
export async function hydrateFromStorage(): Promise<void> {
  if (!canPersist()) return;
  try {
    const stored = await chrome.storage.session.get([
      STORAGE_KEY_OPS,
      STORAGE_KEY_NEXT_OP_ID,
    ]);
    const storedOps = stored[STORAGE_KEY_OPS];
    const storedNextId = stored[STORAGE_KEY_NEXT_OP_ID];
    if (Array.isArray(storedOps) && storedOps.length > 0) {
      // Merge: prepend persisted entries that aren't already in-memory.
      const toRestore: OperationEntry[] = [];
      for (const op of storedOps as OperationEntry[]) {
        if (!operationsByRequestId.has(op.requestId)) {
          toRestore.push(op);
          operationsByRequestId.set(op.requestId, op);
        }
      }
      if (toRestore.length > 0) {
        // Prepend older persisted entries before any fresh in-flight ones.
        operations.unshift(...toRestore);
        // Trim to cap if the combined list exceeds MAX_OPERATIONS.
        while (operations.length > MAX_OPERATIONS) {
          const evicted = operations.shift()!;
          operationsByRequestId.delete(evicted.requestId);
        }
      }
    }
    if (typeof storedNextId === "number" && storedNextId > nextOpId) {
      nextOpId = storedNextId;
    }
  } catch {
    // Storage read failed — start fresh.
  }
}

// Hydrate eagerly on module load (fire-and-forget).
hydrateFromStorage();

// ── Public API ──────────────────────────────────────────────────────

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

/**
 * Record an inbound request as a new operation.
 */
export function recordRequest(
  requestId: string,
  operationName: string,
  request?: Record<string, unknown>,
): OperationEntry {
  const op: OperationEntry = {
    id: nextOpId++,
    requestId,
    operationName,
    requestedAt: new Date().toISOString(),
    request,
  };
  operations.push(op);
  operationsByRequestId.set(requestId, op);
  if (operations.length > MAX_OPERATIONS) {
    const evicted = operations.shift()!;
    operationsByRequestId.delete(evicted.requestId);
  }
  persistOperations();
  return op;
}

/**
 * Record the response for an existing operation (correlate by requestId).
 */
export function recordResponse(
  requestId: string,
  opts?: { isError?: boolean; responseContent?: string },
): void {
  const op = operationsByRequestId.get(requestId);
  if (!op) return;
  op.respondedAt = new Date().toISOString();
  op.isError = opts?.isError;
  op.responseContent = opts?.responseContent;
  op.durationMs = new Date(op.respondedAt).getTime() - new Date(op.requestedAt).getTime();
  persistOperations();
}

/** Return a snapshot of operations (oldest first). */
export function getOperations(): OperationEntry[] {
  return [...operations];
}

/** Return a snapshot of the raw log (oldest first). */
export function getEventLog(): EventLogEntry[] {
  return [...buffer];
}

/** Return a single operation by its numeric ID. */
export function getOperationById(id: number): OperationEntry | undefined {
  return operations.find((op) => op.id === id);
}

/** Clear the log (mainly for testing). */
export function clearEventLog(): void {
  buffer.length = 0;
  nextId = 1;
  operations.length = 0;
  operationsByRequestId.clear();
  nextOpId = 1;
  persistOperations();
}
