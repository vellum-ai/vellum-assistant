import { Capacitor } from "@capacitor/core";

import type { AssistantEvent, RuntimeMessage } from "@/domains/chat/lib/api.js";
import type { DisplayMessage } from "@/domains/chat/lib/reconcile.js";

const MAX_EVENTS = 200;
const STORAGE_KEY = "vellum:chat-diagnostics:v1";

export interface ChatDiagnosticsEvent {
  ts: string;
  kind: string;
  details: Record<string, unknown>;
}

let loaded = false;
let events: ChatDiagnosticsEvent[] = [];

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
        (event): event is ChatDiagnosticsEvent =>
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
    // Diagnostics are best-effort and must never affect chat behavior.
  }
}

export function resolvePlatformTag(): string {
  // Defensive lookup: diagnostics must never throw — if the
  // Capacitor runtime is not initialized (SSR, tests, certain
  // bundler configs where the named import resolves to a stub),
  // fall back to "web" so support snapshots still get split by
  // surface where the runtime is present and degrade gracefully
  // where it is not.
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

export function recordChatDiagnostic(
  kind: string,
  details: Record<string, unknown> = {},
): void {
  loadEvents();
  // Tag every event with the runtime platform so support snapshots
  // can be split by surface (Capacitor iOS / Android / web) without
  // requiring per-call-site plumbing. Matches the OpenTelemetry
  // "resource attribute" / Sentry "global tag" convention of
  // injecting ambient context once at the SDK boundary rather than
  // duplicating it at every call site. Call-site keys win on
  // collision so a future event can override if needed.
  // https://opentelemetry.io/docs/specs/otel/resource/sdk/
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

// Sentry tags must stay low-cardinality so the values are aggregable
// in Discover and don't blow up the project's tag budget; bucketing
// the raw count to a fixed set of bands trades resolution for
// queryability. Bands are chosen so 0 (no rescue) and 1 (single
// missed message — the LUM-1431 shape) are distinguishable, and
// larger rescues collapse into coarser buckets where the exact
// count matters less than "this happened."
// https://docs.sentry.io/concepts/key-terms/key-terms/#tags
export function bucketMessagesAdded(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2-5";
  return "6+";
}

export function getChatDiagnosticsEvents(): ChatDiagnosticsEvent[] {
  loadEvents();
  return events.map((event) => ({
    ts: event.ts,
    kind: event.kind,
    details: { ...event.details },
  }));
}

function roleCounts(messages: Array<{ role: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    counts[message.role] = (counts[message.role] ?? 0) + 1;
  }
  return counts;
}

export function summarizeDisplayMessage(message: DisplayMessage): Record<string, unknown> {
  return {
    stableId: message.stableId,
    id: message.id ?? null,
    role: message.role,
    contentLength: message.content.length,
    timestamp: message.timestamp ?? null,
    isStreaming: message.isStreaming === true,
    queueStatus: message.queueStatus ?? null,
    queuePosition: message.queuePosition ?? null,
    toolCallCount: message.toolCalls?.length ?? 0,
    surfaceCount: message.surfaces?.length ?? 0,
    attachmentCount: message.attachments?.length ?? 0,
    textSegmentCount: message.textSegments?.length ?? 0,
    contentOrderCount: message.contentOrder?.length ?? 0,
  };
}

export function summarizeRuntimeMessage(message: RuntimeMessage): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    contentLength: message.content.length,
    timestamp: message.timestamp ?? null,
    toolCallCount: message.toolCalls?.length ?? 0,
    surfaceCount: message.surfaces?.length ?? 0,
    attachmentCount: message.attachments?.length ?? 0,
    textSegmentCount: message.textSegments?.length ?? 0,
    contentOrderCount: message.contentOrder?.length ?? 0,
  };
}

export function summarizeDisplayMessages(
  messages: DisplayMessage[],
  tailCount = 20,
): Record<string, unknown> {
  return {
    count: messages.length,
    roleCounts: roleCounts(messages),
    streamingCount: messages.filter((message) => message.isStreaming).length,
    queuedCount: messages.filter((message) => message.queueStatus === "queued").length,
    processingCount: messages.filter((message) => message.queueStatus === "processing").length,
    first: messages[0] ? summarizeDisplayMessage(messages[0]) : null,
    last: messages.length > 0 ? summarizeDisplayMessage(messages[messages.length - 1]!) : null,
    tail: messages.slice(-tailCount).map(summarizeDisplayMessage),
  };
}

export function summarizeRuntimeMessages(
  messages: RuntimeMessage[],
  tailCount = 20,
): Record<string, unknown> {
  return {
    count: messages.length,
    roleCounts: roleCounts(messages),
    first: messages[0] ? summarizeRuntimeMessage(messages[0]) : null,
    last: messages.length > 0 ? summarizeRuntimeMessage(messages[messages.length - 1]!) : null,
    tail: messages.slice(-tailCount).map(summarizeRuntimeMessage),
  };
}

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

export function summarizeAssistantEvent(
  event: AssistantEvent,
): Record<string, unknown> {
  const record = event as unknown as Record<string, unknown>;
  const summary: Record<string, unknown> = { type: event.type };

  for (const key of [
    "messageId",
    "conversationKey",
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

export function buildChatDiagnosticsSnapshot(
  currentState: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    currentState,
    events: getChatDiagnosticsEvents(),
  };
}
