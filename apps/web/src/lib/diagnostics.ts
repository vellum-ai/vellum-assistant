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

const MAX_EVENTS = 200;
const STORAGE_KEY = "vellum:chat-diagnostics:v1";

let loaded = false;
let events: DiagnosticsEvent[] = [];

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

function loadEvents(): void {
  if (loaded) return;
  loaded = true;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    events = parsed
      .filter(
        (event): event is DiagnosticsEvent =>
          event != null &&
          typeof event === "object" &&
          typeof event.ts === "string" &&
          typeof event.kind === "string" &&
          event.details != null &&
          typeof event.details === "object" &&
          !Array.isArray(event.details),
      )
      .slice(-MAX_EVENTS);
  } catch {
    events = [];
  }
}

function saveEvents(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Diagnostics are best-effort and must never affect app behavior.
  }
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

/** Append a diagnostic event to the sessionStorage ring buffer. */
export function recordDiagnostic(
  kind: string,
  details: Record<string, unknown> = {},
): void {
  loadEvents();
  events.push({
    ts: new Date().toISOString(),
    kind,
    details: { platform: resolvePlatformTag(), ...details },
  });
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS);
  }
  saveEvents();
}

/** Return a defensive copy of all recorded diagnostic events. */
export function getDiagnosticsEvents(): DiagnosticsEvent[] {
  loadEvents();
  return events.map((event) => ({
    ts: event.ts,
    kind: event.kind,
    details: { ...event.details },
  }));
}

/** Build a timestamped diagnostics snapshot for support submissions. */
export function buildDiagnosticsSnapshot(
  currentState: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    currentState,
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
