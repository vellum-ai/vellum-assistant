import {
  type DisplayMessage,
  isSurfaceInteractive,
} from "@/domains/chat/types/types";
import type { IdentityGetResponse } from "@/generated/daemon/types.gen";
import type { Conversation } from "@/types/conversation-types";
import type { AssistantEvent } from "@/types/event-types";
import { isToolCallRunning } from "@/domains/chat/utils/tool-call-status";
import { mapMessageToolCalls } from "@/domains/chat/utils/map-message-tool-calls";
import type {
  AllowlistOption,
  DirectoryScopeOption,
  PendingConfirmationState,
  PendingQuestionState,
  ScopeOption,
} from "@/types/interaction-ui-types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { PendingToolConfirmation } from "@vellumai/assistant-api";
import type { ToolCallRuleContext } from "@/domains/chat/rule-editor-actions";

export const ERROR_MESSAGES: Record<string, string> = {
  rate_limit_exceeded: "Too many requests. Please wait a moment and try again.",
  invalid_api_key:
    "The API key for this provider is invalid or expired. Check your API key in Settings → Models & Services.",
};

const GLOBAL_STREAM_EVENT_TYPE_NAMES = [
  "conversation_list_invalidated",
  "conversation_title_updated",
  "notification_intent",
  // Client directive to open a settings tab — carries no `conversationId`
  // (daemon emits `{ type, tab }`), so the conversation-id gate would
  // otherwise drop it before it reached `handleNavigateSettings`.
  "navigate_settings",
  // Client directive to open/focus a conversation. Its `conversationId` is
  // the TARGET conversation to open, not the stream the event arrived on, so
  // the conversation-id gate (which compares against the active stream's
  // conversation) would otherwise drop it as a mismatch before it reached
  // `handleOpenConversation`.
  "open_conversation",
  "identity_changed",
  "avatar_updated",
  "sync_changed",
  "disk_pressure_status_changed",
  "home_feed_updated",
  "relationship_state_updated",
  // Workspace-scoped prompt — the `contacts/prompt` IPC route fires it
  // from settings or skill flows that have no conversation binding, so
  // the wire payload has no `conversationId` and the conversation gate
  // would drop it.
  "contact_request",
  // Subagent lifecycle events route by `subagentId` into the global subagent
  // store, not by the parent stream's `conversationId`. They carry
  // `parentConversationId` (spawn) or nothing (`subagent_status_changed`) at the
  // top level, so the conversation-id gate would otherwise drop them as
  // "missing conversationId" — which silently breaks the live inline subagent
  // card (it only reappeared after a history reload). Treat them as global so
  // they always reach `handleSubagentSpawned` / `handleSubagentStatusChanged` /
  // `handleSubagentEvent`.
  "subagent_spawned",
  "subagent_status_changed",
  "subagent_event",
  // ACP session events route by `acpSessionId` into the global acp-run store
  // and carry no top-level `conversationId`, so (like subagent events) the
  // conversation-id gate would otherwise drop them.
  "acp_session_spawned",
  "acp_session_update",
  "acp_session_usage",
  "acp_session_completed",
  "acp_session_error",
  // Background-tool lifecycle events route by their `id` into the global
  // background-task store. They carry a top-level `conversationId`, but gating
  // them on the active conversation would drop a `background_tool_completed`
  // that fires while the user is viewing a different conversation — leaving the
  // task to be mis-settled as "cancelled" by rehydration's `retireMissing` on
  // return. Treat them as global (like subagent/acp) so completions always
  // reach `handleBackgroundToolCompleted`.
  "background_tool_started",
  "background_tool_completed",
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

export function hasPendingAssistantResponse(
  messages: DisplayMessage[],
): boolean {
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

/** Whether any message carries a surface that still accepts user input. */
export function hasAnyInteractiveSurface(
  messages: readonly DisplayMessage[],
): boolean {
  for (const msg of messages) {
    if (msg.surfaces) {
      for (const s of msg.surfaces) {
        if (isSurfaceInteractive(s)) return true;
      }
    }
  }
  return false;
}

export function hasAssistantMessage(
  messages: DisplayMessage[] | null | undefined,
): boolean {
  return !!messages?.some((message) => message.role === "assistant");
}

export function shouldClearFirstMessageGateOnConversationChange({
  previousConversationId,
  nextConversationId,
  onboardingDraftConversationId,
  autoGreetPending,
  assistantMessagePresent,
}: {
  previousConversationId: string | null;
  nextConversationId: string | null;
  onboardingDraftConversationId: string | null;
  autoGreetPending: boolean;
  assistantMessagePresent: boolean;
}): boolean {
  if (previousConversationId == null) return false;
  if (nextConversationId == null) return false;
  if (previousConversationId === nextConversationId) return false;

  return !(
    autoGreetPending &&
    !assistantMessagePresent &&
    previousConversationId === onboardingDraftConversationId
  );
}

const VOICE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "not-allowed": "Microphone access was blocked.",
  "service-not-allowed": "Microphone access was blocked.",
  "not-allowed-permanent":
    "Microphone access is blocked. Allow microphone access in system or browser settings, then try again.",
  "audio-capture":
    "No microphone detected. Connect a microphone and try again.",
  network:
    "Speech recognition couldn\u2019t reach its service. Check your network and try again.",
  aborted: "Recording was interrupted. Try again.",
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
  "native-stt-no-transcript":
    "macOS dictation didn’t return a transcript. Make sure Dictation is turned on in System Settings → Keyboard → Dictation, then try again.",
  "dictation-automation-denied":
    "Dictation needs Automation permission to paste into other apps.",
  "dictation-paste-blocked":
    "This app doesn't accept dictation; copy and paste manually.",
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

export function isMicPermissionPermanentError(code: string | null): boolean {
  return code === "not-allowed-permanent";
}

export function isTextInsertionPermissionError(code: string | null): boolean {
  return code === "dictation-automation-denied";
}

const BACKGROUND_CONVERSATION_SOURCES: ReadonlySet<string> = new Set([
  "heartbeat",
  "task",
  "auto-analysis",
]);

/** Whether a conversation should return to Background on unpin (macOS parity). */
export function shouldReturnToBackground(c: Conversation): boolean {
  return (
    c.source !== undefined && BACKGROUND_CONVERSATION_SOURCES.has(c.source)
  );
}

// Shallow per-field equality check — used to skip re-renders when an identity
// refetch returns an unchanged value (common on SSE bursts triggered by
// tool-driven IDENTITY.md edits).
export function identitiesEqual(
  a: IdentityGetResponse | null,
  b: IdentityGetResponse | null,
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
): {
  updatedMessages: DisplayMessage[];
  attachedToolCallId: string | undefined;
} {
  const msg = messages[messageIndex]!;
  const tc = msg.toolCalls![toolCallIndex]!;
  const updatedMessages = [...messages];
  updatedMessages[messageIndex] = mapMessageToolCalls(msg, (cur) =>
    cur.id === tc.id ? { ...cur, pendingConfirmation: pending } : cur,
  );
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
): {
  updatedMessages: DisplayMessage[];
  attachedToolCallId: string | undefined;
} {
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
      const tc = msg.toolCalls[ti];
      if (tc && isToolCallRunning(tc)) {
        return applyConfirmationToToolCall(messages, mi, ti, pending);
      }
    }
    break;
  }

  return { updatedMessages: messages, attachedToolCallId: undefined };
}

/**
 * Find the in-flight confirmation a history snapshot carries on one of its
 * tool calls. The daemon stamps `pendingConfirmation` from the
 * pending-interactions registry at render time, so on a cold reconnect (or a
 * reopen after the live event buffer aged out) the prompt rides the snapshot
 * rather than a replayed `confirmation_request` event. Returns the prompt
 * projected into the interaction-store shape — with `toolUseId` set to the
 * carrying tool call so the inline card restores on the right chip — or null
 * when no tool call is awaiting a decision. Scans latest-first since the
 * outstanding prompt is on the most recent tool call.
 */
export function extractWirePendingConfirmation(
  messages: DisplayMessage[],
): PendingConfirmationState | null {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (!msg?.toolCalls?.length) continue;
    for (let ti = msg.toolCalls.length - 1; ti >= 0; ti--) {
      const tc = msg.toolCalls[ti];
      if (tc?.pendingConfirmation) {
        return { ...tc.pendingConfirmation, toolUseId: tc.id };
      }
    }
  }
  return null;
}

/**
 * Find the in-flight `ask_question` prompt a history snapshot carries on one
 * of its tool calls. The daemon stamps `pendingQuestion` from the
 * pending-interactions registry at render time, so on a cold reconnect (or a
 * reopen after the live event buffer aged out) the prompt rides the snapshot
 * rather than a replayed `question_request` event. Returns the prompt
 * projected into the interaction-store shape — with `toolUseId` set to the
 * carrying tool call — or null when no tool call is awaiting an answer. Scans
 * latest-first since the outstanding prompt is on the most recent tool call.
 * Mirrors {@link extractWirePendingConfirmation}.
 */
export function extractWirePendingQuestion(
  messages: DisplayMessage[],
): PendingQuestionState | null {
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const msg = messages[mi];
    if (!msg?.toolCalls?.length) continue;
    for (let ti = msg.toolCalls.length - 1; ti >= 0; ti--) {
      const tc = msg.toolCalls[ti];
      if (tc?.pendingQuestion) {
        return {
          requestId: tc.pendingQuestion.requestId,
          entries: tc.pendingQuestion.entries,
          toolUseId: tc.id,
        };
      }
    }
  }
  return null;
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

/** Builds the rule-editor context passed to `handleOpenRuleEditorForToolCall`. */
export function toolCallToRuleContext(
  tc: ChatMessageToolCall,
): ToolCallRuleContext {
  return {
    toolName: tc.name,
    riskLevel: tc.riskLevel,
    riskReason: tc.riskReason,
    input: tc.input ?? {},
    allowlistOptions: tc.riskAllowlistOptions ?? [],
    scopeOptions: tc.scopeOptions ?? [],
    directoryScopeOptions: tc.riskDirectoryScopeOptions ?? [],
    matchedTrustRuleId: tc.matchedTrustRuleId,
  };
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
