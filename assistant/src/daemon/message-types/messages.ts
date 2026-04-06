// User/assistant messages, tool results, confirmations, secrets, errors, and generation lifecycle.

import type { ChannelId, InterfaceId } from "../../channels/types.js";
import type { CommandIntent, UserMessageAttachment } from "./shared.js";

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
}

export interface ConfirmationResponse {
  type: "confirmation_response";
  requestId: string;
  decision:
    | "allow"
    | "allow_10m"
    | "allow_conversation"
    | "always_allow"
    | "always_allow_high_risk"
    | "deny"
    | "always_deny";
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

export interface UserMessageEcho {
  type: "user_message_echo";
  text: string;
  conversationId?: string;
}

export interface AssistantTextDelta {
  type: "assistant_text_delta";
  text: string;
  conversationId?: string;
}

export interface AssistantThinkingDelta {
  type: "assistant_thinking_delta";
  thinking: string;
  conversationId?: string;
}

export interface ToolUseStart {
  type: "tool_use_start";
  toolName: string;
  input: Record<string, unknown>;
  conversationId?: string;
  /** The tool_use block ID for client-side correlation. */
  toolUseId?: string;
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
}

export interface ToolUsePreviewStart {
  type: "tool_use_preview_start";
  toolUseId: string;
  toolName: string;
  conversationId?: string;
}

export interface ToolInputDelta {
  type: "tool_input_delta";
  toolName: string;
  content: string;
  conversationId?: string;
  /** The tool_use block ID for client-side correlation. */
  toolUseId?: string;
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
}

export interface ConfirmationRequest {
  type: "confirmation_request";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
  executionTarget?: "sandbox" | "host";
  allowlistOptions: Array<{
    label: string;
    description: string;
    pattern: string;
  }>;
  scopeOptions: Array<{ label: string; scope: string }>;
  diff?: {
    filePath: string;
    oldContent: string;
    newContent: string;
    isNewFile: boolean;
  };
  sandboxed?: boolean;
  conversationId?: string;
  /** When false, the client should hide "always allow" / trust-rule persistence affordances. */
  persistentDecisionsAllowed?: boolean;
  /** Which temporary approval options the client should render (e.g. "Allow for 10 minutes", "Allow for this conversation"). */
  temporaryOptionsAvailable?: Array<"allow_10m" | "allow_conversation">;
  /** The tool_use block ID for client-side correlation with specific tool calls. */
  toolUseId?: string;
  /** ACP tool kind from the agent (e.g. "read", "edit", "execute"). Present only for ACP permission requests. */
  acpToolKind?: string;
  /** ACP permission options from the agent. Present only for ACP permission requests. Clients should use these to render the correct buttons. */
  acpOptions?: Array<{
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>;
}

export interface SecretRequest {
  type: "secret_request";
  requestId: string;
  service: string;
  field: string;
  label: string;
  description?: string;
  placeholder?: string;
  conversationId?: string;
  /** Intended purpose of the credential (displayed to user). */
  purpose?: string;
  /** Tools allowed to use this credential. */
  allowedTools?: string[];
  /** Domains where this credential may be used. */
  allowedDomains?: string[];
  /** Whether one-time send override is available. */
  allowOneTimeSend?: boolean;
}

export interface MessageComplete {
  type: "message_complete";
  conversationId?: string;
  attachments?: UserMessageAttachment[];
  attachmentWarnings?: string[];
  /** Database ID of the persisted assistant message, if any. */
  messageId?: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  /** Categorizes the error so the client can offer contextual actions (e.g. "Send Anyway" for secret_blocked). */
  category?: string;
}

export interface SecretDetected {
  type: "secret_detected";
  toolName: string;
  matches: Array<{ type: string; redactedValue: string }>;
  action: "redact" | "warn" | "block" | "prompt";
}

export interface MessageQueued {
  type: "message_queued";
  conversationId: string;
  requestId: string;
  position: number;
}

export interface MessageDequeued {
  type: "message_dequeued";
  conversationId: string;
  requestId: string;
}

/**
 * Request-level terminal signal for a user message lifecycle.
 *
 * Unlike `message_complete`, this does not imply the active assistant turn
 * has completed. It is used for paths that consume a request inline while a
 * separate in-flight turn may still be running.
 */
export interface MessageRequestComplete {
  type: "message_request_complete";
  conversationId: string;
  requestId: string;
  /** True when an existing turn is still running after this request is finalized. */
  runStillActive?: boolean;
}

export interface MessageQueuedDeleted {
  type: "message_queued_deleted";
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

/** Broadcast to clients when the two-axis permission mode changes. */
export interface PermissionModeUpdate {
  type: "permission_mode_update";
  askBeforeActing: boolean;
  hostAccess: boolean;
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
  | "secret_detected"
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
  | UserMessageEcho
  | AssistantTextDelta
  | AssistantThinkingDelta
  | ToolUseStart
  | ToolUsePreviewStart
  | ToolOutputChunk
  | ToolInputDelta
  | ToolResult
  | ConfirmationRequest
  | SecretRequest
  | MessageComplete
  | ErrorMessage
  | SecretDetected
  | MessageQueued
  | MessageDequeued
  | MessageRequestComplete
  | MessageQueuedDeleted
  | SuggestionResponse
  | TraceEvent
  | ConfirmationStateChanged
  | AssistantActivityState
  | PermissionModeUpdate;
