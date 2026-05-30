// User/assistant messages, tool results, confirmations, secrets, errors, and generation lifecycle.

import type { AssistantTextDeltaEvent } from "../../api/events/assistant-text-delta.js";
import type { AssistantTurnStartEvent } from "../../api/events/assistant-turn-start.js";
import type { ConfirmationRequestEvent } from "../../api/events/confirmation-request.js";
import type { ErrorEvent } from "../../api/events/error.js";
import type { InteractionResolvedEvent } from "../../api/events/interaction-resolved.js";
import type { MessageCompleteEvent } from "../../api/events/message-complete.js";
import type { MessageDequeuedEvent } from "../../api/events/message-dequeued.js";
import type { MessageQueuedEvent } from "../../api/events/message-queued.js";
import type { MessageQueuedDeletedEvent } from "../../api/events/message-queued-deleted.js";
import type { MessageRequestCompleteEvent } from "../../api/events/message-request-complete.js";
import type { QuestionRequestEvent } from "../../api/events/question-request.js";
import type { SecretRequestEvent } from "../../api/events/secret-request.js";
import type { ToolUseStartEvent } from "../../api/events/tool-use-start.js";
import type { UserMessageEchoEvent } from "../../api/events/user-message-echo.js";
import type { ChannelId, InterfaceId } from "../../channels/types.js";
import type { CommandIntent, UserMessageAttachment } from "./shared.js";
import type { ToolActivityMetadata } from "./web-activity.js";

// === Client → Server ===

export interface UserMessage {
  type: "user_message";
  conversationId: string;
  content?: string;
  attachments?: UserMessageAttachment[];
  activeSurfaceId?: string;
  /** The page currently displayed in the WebView (e.g. "settings.html"). */
  currentPage?: string;
  /** Originating channel identifier (e.g. 'vellum'). Defaults to 'vellum' when absent. */
  channel?: ChannelId;
  /** Originating interface identifier (e.g. 'macos'). */
  interface: InterfaceId;
  /** Push-to-talk activation key configured on the client (e.g. 'fn', 'ctrl', 'fn_shift', 'none'). */
  pttActivationKey?: string;
  /** Whether the client has been granted microphone permission by the OS. */
  microphonePermissionGranted?: boolean;
  /** Structured command intent — bypasses text parsing when present. */
  commandIntent?: CommandIntent;
  /** Client-generated correlation nonce for echo dedup. See
   *  `UserMessageEchoEvent.clientMessageId` — the server echoes this value
   *  back on the matching `user_message_echo` event. */
  clientMessageId?: string;
}

export interface ConfirmationResponse {
  type: "confirmation_response";
  requestId: string;
  decision: "allow" | "deny";
  selectedPattern?: string;
  selectedScope?: string;
}

export interface SecretResponse {
  type: "secret_response";
  requestId: string;
  value?: string; // undefined = user cancelled
  /** How the secret should be delivered: 'store' persists to credential store (default), 'transient_send' for one-time use without persisting. */
  delivery?: "store" | "transient_send";
}

export interface SuggestionRequest {
  type: "suggestion_request";
  conversationId: string;
  requestId: string;
}

// === Server → Client ===

export interface AssistantThinkingDelta {
  type: "assistant_thinking_delta";
  thinking: string;
  conversationId?: string;
  /** Database ID of the assistant message this thinking delta belongs to.
   *  Same semantics as `AssistantTextDeltaEvent.messageId`. */
  messageId?: string;
}

export interface ToolOutputChunk {
  type: "tool_output_chunk";
  chunk: string;
  conversationId?: string;
  toolUseId?: string;
  subType?: "tool_start" | "tool_complete" | "status";
  subToolName?: string;
  subToolInput?: string;
  subToolIsError?: boolean;
  subToolId?: string;
  /** Database ID of the assistant message that owns the parent tool_use
   *  block. Same semantics as `AssistantTextDeltaEvent.messageId`. */
  messageId?: string;
}

export interface ToolUsePreviewStart {
  type: "tool_use_preview_start";
  toolUseId: string;
  toolName: string;
  conversationId?: string;
  /** Database ID of the assistant message that owns this tool_use block.
   *  Same semantics as `AssistantTextDeltaEvent.messageId`. */
  messageId?: string;
}

export interface ToolInputDelta {
  type: "tool_input_delta";
  toolName: string;
  content: string;
  conversationId?: string;
  /** The tool_use block ID for client-side correlation. */
  toolUseId?: string;
  /** Database ID of the assistant message that owns this tool_use block.
   *  Same semantics as `AssistantTextDeltaEvent.messageId`. */
  messageId?: string;
}

export interface ToolResult {
  type: "tool_result";
  toolName: string;
  result: string;
  isError?: boolean;
  diff?: {
    filePath: string;
    oldContent: string;
    newContent: string;
    isNewFile: boolean;
  };
  status?: string;
  conversationId?: string;
  /** Base64-encoded image data extracted from contentBlocks (e.g. browser_screenshot). @deprecated Use imageDataList. */
  imageData?: string;
  /** Base64-encoded image data extracted from contentBlocks (e.g. browser_screenshot, image generation). */
  imageDataList?: string[];
  /** The tool_use block ID for client-side correlation. */
  toolUseId?: string;
  /** Database ID of the assistant message that owns the parent tool_use
   *  block. Same semantics as `AssistantTextDeltaEvent.messageId`. */
  messageId?: string;
  /** Risk level from the classifier ("low" | "medium" | "high" | "unknown"). */
  riskLevel?: string;
  /** Human-readable reason for the risk classification. */
  riskReason?: string;
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId?: string;
  /** Whether the daemon is running in a containerized (Docker) environment. */
  isContainerized?: boolean;
  /**
   * Display-only ladder of scope option labels for the rule editor
   * (narrowest to broadest). The `pattern` here is regex-style and is
   * NOT a valid trust rule pattern. Clients must use
   * `riskAllowlistOptions` for the pattern that gets saved.
   */
  riskScopeOptions?: Array<{ pattern: string; label: string }>;
  /**
   * Allowlist options for the rule editor save path (narrowest to
   * broadest). Each `pattern` is a Minimatch-glob compatible string —
   * what the gateway actually matches against. Mirrors the
   * `allowlistOptions` field on `ConfirmationRequestEvent`. May be absent
   * for tools whose classifier does not produce an allowlist (e.g.
   * web-risk classifier, MCP tools without classifier coverage).
   */
  riskAllowlistOptions?: Array<{
    label: string;
    description: string;
    pattern: string;
  }>;
  /** Directory scope ladder for the rule editor modal (narrowest to broadest). */
  riskDirectoryScopeOptions?: Array<{ scope: string; label: string }>;
  /** How the approval decision was reached: prompted, auto, blocked, or unknown (legacy). */
  approvalMode?: string;
  /** Why the approval decision was reached (stable enum for client display). */
  approvalReason?: string;
  /** Snapshot of the auto-approve threshold at execution time. */
  riskThreshold?: string;
  /** Structured activity metadata for rich client rendering. Optional; old
   *  clients that key off `result` continue to work unchanged. */
  activityMetadata?: ToolActivityMetadata;
}

export interface MessageSteered {
  type: "message_steered";
  conversationId: string;
  requestId: string;
}

export interface SuggestionResponse {
  type: "suggestion_response";
  requestId: string;
  suggestion: string | null;
  source: "llm" | "none";
}

/**
 * Authoritative per-request confirmation state transition emitted by the daemon.
 *
 * The client must use this event (not local phrase inference) to update
 * confirmation bubble state.
 */
export interface ConfirmationStateChanged {
  type: "confirmation_state_changed";
  conversationId: string;
  requestId: string;
  state: "pending" | "approved" | "denied" | "timed_out" | "resolved_stale";
  source: "button" | "inline_nl" | "auto_deny" | "timeout" | "system";
  /** requestId of the user message that triggered this transition. */
  causedByRequestId?: string;
  /** Normalized user text for analytics/debug (e.g. "approve", "deny"). */
  decisionText?: string;
  /** The tool_use block ID this confirmation applies to, for disambiguating parallel tool calls. */
  toolUseId?: string;
}

/**
 * Server-side assistant activity lifecycle for thinking indicator placement.
 *
 * `activityVersion` is monotonically increasing per conversation. Clients must
 * ignore events with a version older than their current known version.
 */
export interface AssistantActivityState {
  type: "assistant_activity_state";
  conversationId: string;
  activityVersion: number;
  phase:
    | "idle"
    | "thinking"
    | "streaming"
    | "tool_running"
    | "awaiting_confirmation";
  anchor: "assistant_turn" | "user_turn" | "global";
  /** Active user request when available. */
  requestId?: string;
  reason:
    | "message_dequeued"
    | "thinking_delta"
    | "first_text_delta"
    | "tool_use_start"
    | "preview_start"
    | "tool_result_received"
    | "confirmation_requested"
    | "confirmation_resolved"
    | "context_compacting"
    | "message_complete"
    | "generation_cancelled"
    | "error_terminal";
  /** Human-readable description of what the assistant is currently doing. */
  statusText?: string;
}

/**
 * Emitted when the query complexity auto-router selects a non-default
 * profile for the current turn. Clients use this to show an inline
 * notification (e.g. "Using Quality for this response"). Only fires when
 * the router picks a profile — not when the user explicitly pinned one.
 */
export interface TurnProfileAutoRouted {
  type: "turn_profile_auto_routed";
  conversationId: string;
  /** Profile key (e.g. "quality-optimized"). */
  profile: string;
  /** Human-readable label (e.g. "Quality"). */
  profileLabel: string;
}

/**
 * Broadcast to clients when a conversation's inference-profile override
 * changes. `profile` is the profile name (a key in `llm.profiles`) or
 * `null` when the override is cleared and the conversation falls back to
 * the workspace `llm.activeProfile` resolution.
 */
export interface ConversationInferenceProfileUpdated {
  type: "conversation_inference_profile_updated";
  conversationId: string;
  profile: string | null;
  sessionId?: string | null;
  expiresAt?: number | null;
}

export type TraceEventKind =
  | "request_received"
  | "request_queued"
  | "request_dequeued"
  | "llm_call_started"
  | "llm_call_finished"
  | "assistant_message"
  | "tool_started"
  | "tool_permission_requested"
  | "tool_permission_decided"
  | "tool_finished"
  | "tool_failed"
  | "generation_handoff"
  | "message_complete"
  | "generation_cancelled"
  | "request_error"
  | "tool_profiling_summary";

export interface TraceEvent {
  type: "trace_event";
  eventId: string;
  conversationId: string;
  requestId?: string;
  timestampMs: number;
  sequence: number;
  kind: TraceEventKind;
  status?: "info" | "success" | "warning" | "error";
  summary: string;
  attributes?: Record<string, string | number | boolean | null>;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _MessagesClientMessages =
  | UserMessage
  | ConfirmationResponse
  | SecretResponse
  | SuggestionRequest;

export type _MessagesServerMessages =
  | UserMessageEchoEvent
  | AssistantTurnStartEvent
  | AssistantTextDeltaEvent
  | AssistantThinkingDelta
  | ToolUseStartEvent
  | ToolUsePreviewStart
  | ToolOutputChunk
  | ToolInputDelta
  | ToolResult
  | ConfirmationRequestEvent
  | SecretRequestEvent
  | QuestionRequestEvent
  | MessageCompleteEvent
  | ErrorEvent
  | MessageQueuedEvent
  | MessageDequeuedEvent
  | MessageRequestCompleteEvent
  | MessageQueuedDeletedEvent
  | MessageSteered
  | SuggestionResponse
  | TraceEvent
  | ConfirmationStateChanged
  | AssistantActivityState
  | TurnProfileAutoRouted
  | ConversationInferenceProfileUpdated
  | InteractionResolvedEvent;
