import type { DisplayMessage } from "@/domains/chat/types/types";
import type { AssistantIdentity } from "@/assistant/identity";
import type { Conversation } from "@/lib/conversations-api";
import type { AllowlistOption, AssistantEvent, DirectoryScopeOption, PendingToolConfirmation, ScopeOption } from "@/domains/chat/api/event-types";

export const ERROR_MESSAGES: Record<string, string> = {
  rate_limit_exceeded:
    "Too many requests. Please wait a moment and try again.",
  invalid_api_key:
    "The API key for this provider is invalid or expired. Please check your settings.",
};

const GLOBAL_STREAM_EVENT_TYPE_NAMES = [
  "conversation_list_invalidated",
  "conversation_title_updated",
  "notification_intent",
  "identity_changed",
  "avatar_updated",
  "sync_changed",
  "disk_pressure_status_changed",
  "home_feed_updated",
  "relationship_state_updated",
] as const;

const GLOBAL_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set(
  GLOBAL_STREAM_EVENT_TYPE_NAMES,
);

type GlobalAssistantEvent = Extract<
  AssistantEvent,
  { type: (typeof GLOBAL_STREAM_EVENT_TYPE_NAMES)[number] }
>;
export type ConversationScopedAssistantEvent = Exclude<
  AssistantEvent,
  GlobalAssistantEvent
>;

export function isConversationScopedStreamEvent(
  event: AssistantEvent,
): event is ConversationScopedAssistantEvent {
  return !GLOBAL_STREAM_EVENT_TYPES.has(event.type);
}

export function hasPendingAssistantResponse(messages: DisplayMessage[]): boolean {
  let lastNonQueuedUserIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "assistant") {
      return lastNonQueuedUserIndex > i;
    }
    if (msg.role === "user" && msg.queueStatus !== "queued") {
      lastNonQueuedUserIndex = i;
    }
  }

  return lastNonQueuedUserIndex !== -1;
}

const VOICE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "not-allowed": "Microphone access was blocked.",
  "service-not-allowed": "Microphone access was blocked.",
  "not-allowed-permanent":
    "Microphone is blocked in your browser settings. Click the lock icon in your address bar and allow microphone access, then reload.",
  "audio-capture":
    "No microphone detected. Connect a microphone and try again.",
  "network":
    "Speech recognition couldn\u2019t reach its service. Check your network and try again.",
  "aborted": "Recording was interrupted. Try again.",
  "stt-not-configured":
    "Speech-to-text isn\u2019t set up for this assistant. Open Settings \u2192 Voice to choose a provider.",
  "stt-audio-rejected":
    "We couldn\u2019t transcribe that recording. Try recording again or speaking more clearly.",
  "stt-rate-limited":
    "Too many transcription requests. Please wait a moment and try again.",
  "stt-auth-failed":
    "The speech-to-text provider rejected the assistant\u2019s credentials. Update the API key in Settings \u2192 Voice.",
  "stt-provider-error":
    "The speech-to-text provider is having trouble right now. Try again in a moment.",
  "stt-unavailable":
    "Speech-to-text is temporarily unavailable. Try again in a moment.",
  "stt-timeout": "Transcription took too long. Try a shorter recording.",
};

export function formatVoiceError(code: string): string {
  return (
    VOICE_ERROR_MESSAGES[code] ??
    `Voice input failed (${code}). Try again or type your message.`
  );
}

const MIC_PERMISSION_ERROR_CODES: ReadonlySet<string> = new Set([
  "not-allowed",
  "service-not-allowed",
]);

export function isMicPermissionError(code: string | null): boolean {
  return code !== null && MIC_PERMISSION_ERROR_CODES.has(code);
}

const BACKGROUND_CONVERSATION_SOURCES: ReadonlySet<string> = new Set([
  "heartbeat",
  "task",
  "auto-analysis",
]);

/** Whether a conversation should return to Background on unpin (macOS parity). */
export function shouldReturnToBackground(c: Conversation): boolean {
  return c.source !== undefined && BACKGROUND_CONVERSATION_SOURCES.has(c.source);
}

// Shallow per-field equality check — used to skip re-renders when an identity
// refetch returns an unchanged value (common on SSE bursts triggered by
// tool-driven IDENTITY.md edits).
export function identitiesEqual(
  a: AssistantIdentity | null,
  b: AssistantIdentity | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.name === b.name &&
    a.role === b.role &&
    a.personality === b.personality &&
    a.emoji === b.emoji &&
    a.home === b.home &&
    a.version === b.version &&
    a.createdAt === b.createdAt
  );
}

function applyConfirmationToToolCall(
  messages: DisplayMessage[],
  messageIndex: number,
  toolCallIndex: number,
  pending: PendingToolConfirmation,
): { updatedMessages: DisplayMessage[]; attachedToolCallId: string | undefined } {
  const msg = messages[messageIndex]!;
  const tc = msg.toolCalls![toolCallIndex]!;
  const updatedToolCalls = [...msg.toolCalls!];
  updatedToolCalls[toolCallIndex] = { ...tc, pendingConfirmation: pending };
  const updatedMessages = [...messages];
  updatedMessages[messageIndex] = { ...msg, toolCalls: updatedToolCalls };
  return { updatedMessages, attachedToolCallId: tc.id };
}

/**
 * Attach a pending confirmation to the best-matching tool call in `messages`.
 *
 * Search order:
 * 1. Exact `toolUseId` match (conf.toolUseId === toolCall.id)
 * 2. Fallback: last running tool call in the latest assistant message with tool calls
 *
 * Returns updated messages and the id of the attached tool call (or undefined).
 */
export function attachConfirmationToToolCall(
  messages: DisplayMessage[],
  conf: {
    requestId: string;
    title?: string;
    description?: string;
    toolName?: string;
    riskLevel?: string;
    riskReason?: string;
    input?: Record<string, unknown>;
    allowlistOptions?: AllowlistOption[];
    scopeOptions?: ScopeOption[];
    directoryScopeOptions?: DirectoryScopeOption[];
    persistentDecisionsAllowed?: boolean;
    toolUseId?: string;
  },
): { updatedMessages: DisplayMessage[]; attachedToolCallId: string | undefined } {
  const { toolUseId, ...pendingFields } = conf;
  const pending: PendingToolConfirmation = pendingFields;

  // 1. Exact toolUseId match — search all messages with tool calls
  if (toolUseId) {
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const msg = messages[mi];
      if (!msg?.toolCalls?.length) continue;
      const tcIdx = msg.toolCalls.findIndex((tc) => tc.id === toolUseId);
      if (tcIdx !== -1) {
        return applyConfirmationToToolCall(messages, mi, tcIdx, pending);
      }
    }
  }

  // 2. Fallback: last running tool call in the latest assistant message with tool calls
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (msg?.role !== "assistant" || !msg.toolCalls?.length) continue;

    for (let ti = msg.toolCalls.length - 1; ti >= 0; ti--) {
      if (msg.toolCalls[ti]?.status === "running") {
        return applyConfirmationToToolCall(messages, mi, ti, pending);
      }
    }
    break;
  }

  return { updatedMessages: messages, attachedToolCallId: undefined };
}

/**
 * Derive a short command text string from confirmation input.
 * Matches the macOS modal's first-meaningful-field heuristic: prefer
 * "command", "cmd", "path", "file", "url", or the first string value;
 * fall back to a compact JSON summary.
 */
export function deriveCommandText(
  input: Record<string, unknown> | undefined,
  toolName: string,
): string {
  if (!input) return toolName;
  const preferredKeys = ["command", "cmd", "path", "file", "url"];
  for (const key of preferredKeys) {
    const val = input[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  for (const val of Object.values(input)) {
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  try {
    const json = JSON.stringify(input);
    return json.length > 120 ? json.slice(0, 117) + "..." : json;
  } catch {
    return toolName;
  }
}

const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_MINUTE = 60_000;

export function formatRelativeTime(timestamp: number): string {
  const diffMin = Math.floor((Date.now() - timestamp) / MS_PER_MINUTE);
  if (diffMin < 1) return "just now";
  if (diffMin < MINUTES_PER_HOUR) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / MINUTES_PER_HOUR);
  if (diffHr < HOURS_PER_DAY) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / HOURS_PER_DAY)}d ago`;
}
