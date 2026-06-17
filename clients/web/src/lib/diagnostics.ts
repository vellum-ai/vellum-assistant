/**
 * Session-scoped diagnostic event recorder.
 *
 * Records timestamped diagnostic events to a sessionStorage ring buffer.
 * Used by the streaming transport, chat hooks, and the support diagnostics
 * snapshot. Data survives navigation but not tab close.
 */

import { Capacitor } from "@capacitor/core";

import type { AssistantEvent } from "@/types/event-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiagnosticsEvent {
  ts: string;
  kind: string;
  details: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/**
 * High-volume ring: per-delta SSE diagnostics, history applies, and other
 * frequently-emitted events. Capped low because a single active turn can
 * emit dozens of entries per second.
 */
const MAX_EVENTS = 200;

/**
 * Low-volume ring for discrete connection and app-lifecycle transitions
 * (stream open / close / reconnect / watchdog, tab visibility, network,
 * power). Kept in a separate buffer so a burst of high-volume per-delta
 * events can never flush the lifecycle timeline — the signal a
 * "stale content after the tab regains focus" report needs survives even
 * after tens of minutes of streaming.
 */
const MAX_LIFECYCLE_EVENTS = 200;

const STORAGE_KEY = "vellum:chat-diagnostics:v1";
const LIFECYCLE_STORAGE_KEY = "vellum:chat-diagnostics-lifecycle:v1";

interface Ring {
  readonly storageKey: string;
  readonly max: number;
  loaded: boolean;
  events: DiagnosticsEvent[];
}

const mainRing: Ring = {
  storageKey: STORAGE_KEY,
  max: MAX_EVENTS,
  loaded: false,
  events: [],
};

const lifecycleRing: Ring = {
  storageKey: LIFECYCLE_STORAGE_KEY,
  max: MAX_LIFECYCLE_EVENTS,
  loaded: false,
  events: [],
};

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isDiagnosticsEvent(event: unknown): event is DiagnosticsEvent {
  return (
    event != null &&
    typeof event === "object" &&
    typeof (event as DiagnosticsEvent).ts === "string" &&
    typeof (event as DiagnosticsEvent).kind === "string" &&
    (event as DiagnosticsEvent).details != null &&
    typeof (event as DiagnosticsEvent).details === "object" &&
    !Array.isArray((event as DiagnosticsEvent).details)
  );
}

function loadRing(ring: Ring): void {
  if (ring.loaded) return;
  ring.loaded = true;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(ring.storageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    ring.events = parsed.filter(isDiagnosticsEvent).slice(-ring.max);
  } catch {
    ring.events = [];
  }
}

function saveRing(ring: Ring): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(ring.storageKey, JSON.stringify(ring.events));
  } catch {
    // Diagnostics are best-effort and must never affect app behavior.
  }
}

function pushToRing(
  ring: Ring,
  kind: string,
  details: Record<string, unknown>,
): void {
  loadRing(ring);
  ring.events.push({
    ts: new Date().toISOString(),
    kind,
    details: { platform: resolvePlatformTag(), ...details },
  });
  if (ring.events.length > ring.max) {
    ring.events = ring.events.slice(-ring.max);
  }
  saveRing(ring);
}

function snapshotRing(ring: Ring): DiagnosticsEvent[] {
  loadRing(ring);
  return ring.events.map((event) => ({
    ts: event.ts,
    kind: event.kind,
    details: { ...event.details },
  }));
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/** Resolve the runtime platform tag (ios, android, or web). */
export function resolvePlatformTag(): string {
  try {
    const platform = (
      Capacitor as unknown as { getPlatform?: () => string }
    ).getPlatform?.();
    if (typeof platform === "string" && platform.length > 0) {
      return platform;
    }
  } catch {
    // fall through
  }
  return "web";
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Append a high-volume diagnostic event to the main ring buffer. */
export function recordDiagnostic(
  kind: string,
  details: Record<string, unknown> = {},
): void {
  pushToRing(mainRing, kind, details);
}

/**
 * Append a discrete connection / app-lifecycle transition to the durable
 * lifecycle ring. Use this for low-frequency state changes (stream
 * open / close / reconnect / watchdog, tab visibility, network, power) so
 * the connection timeline is not flushed by high-volume per-delta events.
 */
export function recordLifecycleDiagnostic(
  kind: string,
  details: Record<string, unknown> = {},
): void {
  pushToRing(lifecycleRing, kind, details);
}

/** Return a defensive copy of the main (high-volume) ring buffer. */
export function getDiagnosticsEvents(): DiagnosticsEvent[] {
  return snapshotRing(mainRing);
}

/** Return a defensive copy of the durable lifecycle ring buffer. */
export function getLifecycleDiagnosticsEvents(): DiagnosticsEvent[] {
  return snapshotRing(lifecycleRing);
}

/** Build a timestamped diagnostics snapshot for support submissions. */
export function buildDiagnosticsSnapshot(
  currentState: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    collectedAt: new Date().toISOString(),
    currentState,
    lifecycleEvents: getLifecycleDiagnosticsEvents(),
    events: getDiagnosticsEvents(),
  };
}

// ---------------------------------------------------------------------------
// Event summarization
// ---------------------------------------------------------------------------

/** Bucket a message count into a low-cardinality Sentry tag band. */
export function bucketMessagesAdded(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  return "6+";
}

/** Count messages per role. */
export function roleCounts(messages: Array<{ role: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    counts[message.role] = (counts[message.role] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Assistant event summarization (safe field extraction)
// ---------------------------------------------------------------------------

function copyStringField(
  summary: Record<string, unknown>,
  record: Record<string, unknown>,
  key: string,
): void {
  if (typeof record[key] === "string") {
    summary[key] = record[key];
  }
}

function copyNumberField(
  summary: Record<string, unknown>,
  record: Record<string, unknown>,
  key: string,
): void {
  if (typeof record[key] === "number" && Number.isFinite(record[key])) {
    summary[key] = record[key];
  }
}

function copyBooleanField(
  summary: Record<string, unknown>,
  record: Record<string, unknown>,
  key: string,
): void {
  if (typeof record[key] === "boolean") {
    summary[key] = record[key];
  }
}

function copyStringLengthField(
  summary: Record<string, unknown>,
  record: Record<string, unknown>,
  key: string,
): void {
  if (typeof record[key] === "string") {
    summary[`${key}Length`] = record[key].length;
  }
}

/** Extract a compact summary of an SSE event for diagnostic logging. */
export function summarizeAssistantEvent(
  event: AssistantEvent,
): Record<string, unknown> {
  const record = event as unknown as Record<string, unknown>;
  const summary: Record<string, unknown> = { type: event.type };

  for (const key of [
    "messageId",
    "requestId",
    "surfaceId",
    "surfaceType",
    "toolUseId",
    "conversationId",
    "deliveryId",
    "code",
    "toolName",
    "errorCategory",
    "rawType",
    "tab",
    "sourceEventName",
  ]) {
    copyStringField(summary, record, key);
  }
  for (const key of [
    "position",
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationInputTokens",
    "contextWindowTokens",
    "contextWindowMaxTokens",
    "openUntil",
  ]) {
    copyNumberField(summary, record, key);
  }
  for (const key of ["isError", "retryable", "runStillActive"]) {
    copyBooleanField(summary, record, key);
  }
  for (const key of [
    "text",
    "content",
    "message",
    "userMessage",
    "debugDetails",
    "title",
    "body",
    "summary",
    "result",
    "url",
  ]) {
    copyStringLengthField(summary, record, key);
  }

  if (typeof record.url === "string") {
    try {
      summary.urlHost = new URL(record.url).host;
    } catch {
      summary.urlHost = null;
    }
  }
  if (Array.isArray(record.attachments)) {
    summary.attachmentCount = record.attachments.length;
  }
  if (Array.isArray(record.actions)) {
    summary.actionCount = record.actions.length;
  }
  if (
    record.data != null &&
    typeof record.data === "object" &&
    !Array.isArray(record.data)
  ) {
    summary.dataKeys = Object.keys(record.data).length;
  }
  if (
    record.input != null &&
    typeof record.input === "object" &&
    !Array.isArray(record.input)
  ) {
    summary.inputKeys = Object.keys(record.input).length;
  }

  return summary;
}
