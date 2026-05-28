// User/assistant messages, tool results, confirmations, secrets, errors, and generation lifecycle.

import type { AssistantTextDeltaEvent } from "../../api/events/assistant-text-delta.js";
import type { AssistantTurnStartEvent } from "../../api/events/assistant-turn-start.js";
import type { MessageCompleteEvent } from "../../api/events/message-complete.js";
import type { MessageDequeuedEvent } from "../../api/events/message-dequeued.js";
import type { MessageQueuedEvent } from "../../api/events/message-queued.js";
import type { MessageQueuedDeletedEvent } from "../../api/events/message-queued-deleted.js";
import type { MessageRequestCompleteEvent } from "../../api/events/message-request-complete.js";
import type { ToolUseStartEvent } from "../../api/events/tool-use-start.js";
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
   *  `UserMessageEcho.clientMessageId` — the server echoes this value
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

export interface UserMessageEcho {
  type: "user_message_echo";
  text: string;
  conversationId?: string;
  /** Database ID of the persisted user message, used by the originating
   *  client to dedupe its optimistic row. Absent for synthetic echoes
   *  (e.g. surface-action prompts) where no distinct user row is persisted. */
  messageId?: string;
  /** Server-generated request ID for the send. Allows correlation with
   *  `message_queued` / `message_dequeued` events for the same turn. */
  requestId?: string;
  /** Client-generated correlation nonce from the HTTP POST body. Echoed
   *  back so the originating client can dedupe its optimistic row even
   *  if the SSE echo beats the 202 response. Absent for synthetic echoes
   *  (e.g. surface-action prompts) that did not originate from a client POST. */
  clientMessageId?: string;
}

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
   * `allowlistOptions` field on `ConfirmationRequest`. May be absent
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

export interface ConfirmationRequest {
  type: "confirmation_request";
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: string;
  /** Human-readable reason for the risk classification (e.g. "Modifies remote repository state"). */
  riskReason?: string;
  /** Whether the daemon is running in a containerized (Docker) environment. */
  isContainerized?: boolean;
  executionTarget?: "sandbox" | "host";
  allowlistOptions: Array<{
    label: string;
    description: string;
    pattern: string;
  }>;
  scopeOptions: Array<{ label: string; scope: string }>;
  directoryScopeOptions?: Array<{ scope: string; label: string }>;
  diff?: {
    filePath: string;
    oldContent: string;
    newContent: string;
    isNewFile: boolean;
  };
  conversationId?: string;
  /** When false, the client should hide "always allow" / trust-rule persistence affordances. */
  persistentDecisionsAllowed?: boolean;
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

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * One entry in a batched ask-question request.
 *
 * `id` is daemon-assigned (e.g. `q1`, `q2`...) — the LLM neither sees nor
 * supplies it. It exists so the client has a stable handle to post the
 * user's answer back against. See `QuestionRequest` for the batching
 * contract.
 */
export interface QuestionEntry {
  id: string;
  question: string;
  description?: string;
  /** LLM-supplied options, capped at 4. The client always renders a fixed
   *  5th "Type something else" slot wired to a free-text response — so this
   *  array never represents the full choice set the user sees. */
  options: QuestionOption[];
  /** Optional placeholder shown in the free-text input. */
  freeTextPlaceholder?: string;
}

/**
 * A single broadcast that carries either one or a small batch (≤5) of
 * clarifying questions. The whole batch is one card lifecycle on the client:
 * one render, one state machine, one response submission.
 *
 * Wire-compat plan: both shapes are populated on every broadcast.
 *  - `questions[]` is the canonical shape new clients should consume.
 *  - The flat `question` / `description` / `options` / `freeTextPlaceholder`
 *    fields mirror `questions[0]` for backwards compat with the existing
 *    web client, which keys off the flat fields. Once that client adopts
 *    `questions[]`, the flat fields can be dropped (separate cleanup).
 *
 * Daemon callers that don't supply a batch get a one-element `questions`
 * array synthesized from the flat fields.
 */
export interface QuestionRequest {
  type: "question_request";
  requestId: string;
  /** Batched-question payload. Always populated (single questions are sent
   *  as a one-element array). Each entry's `id` is daemon-assigned. */
  questions: QuestionEntry[];
  /** Legacy: mirrors `questions[0].question`. Kept populated for clients
   *  that haven't adopted the batched `questions[]` shape yet. */
  question: string;
  /** Legacy: mirrors `questions[0].description`. */
  description?: string;
  /** Legacy: mirrors `questions[0].options`. */
  options: QuestionOption[];
  /** Legacy: mirrors `questions[0].freeTextPlaceholder`. */
  freeTextPlaceholder?: string;
  conversationId?: string;
  toolUseId?: string;
}

export interface ErrorMessage {
  type: "error";
  conversationId?: string;
  requestId?: string;
  code?: string;
  message: string;
  /** Categorizes the error so the client can offer contextual actions (e.g. "Send Anyway" for secret_blocked). */
  category?: string;
  /** Machine-readable conversation error category for clients that need source-aware recovery UI. */
  errorCategory?: string;
}

export type MessageQueued = MessageQueuedEvent;

export type MessageDequeued = MessageDequeuedEvent;

export type MessageRequestComplete = MessageRequestCompleteEvent;

export type MessageQueuedDeleted = MessageQueuedDeletedEvent;

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
 * Lifecycle states reported by `interaction_resolved`.
 *
 *  - `"approved"` / `"rejected"` — user-supplied verdict on a confirmation.
 *  - `"answered"` — user/client provided a response (secret value, question
 *    answer, host-proxy result).
 *  - `"cancelled"` — the interaction was torn down without a user response
 *    (timeout, abort, dispose, prompter shutdown).
 *  - `"superseded"` — invalidated by a newer event (auto-deny on enqueue, a
 *    fresh user message arriving while a confirmation was outstanding).
 */
export type InteractionResolutionState =
  | "approved"
  | "rejected"
  | "answered"
  | "cancelled"
  | "superseded";

/**
 * Broadcast when a pending interaction (confirmation, secret, question,
 * host-proxy request) transitions to a resolved state. Clients use this to
 * drop attention/processing indicators without polling.
 */
export interface InteractionResolved {
  type: "interaction_resolved";
  requestId: string;
  /** Conversation id the interaction belongs to. */
  conversationId: string;
  state: InteractionResolutionState;
  /** Kind of the resolved interaction (e.g. "confirmation", "secret", "host_bash"). */
  kind: string;
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
  | UserMessageEcho
  | AssistantTurnStartEvent
  | AssistantTextDeltaEvent
  | AssistantThinkingDelta
  | ToolUseStartEvent
  | ToolUsePreviewStart
  | ToolOutputChunk
  | ToolInputDelta
  | ToolResult
  | ConfirmationRequest
  | SecretRequest
  | QuestionRequest
  | MessageCompleteEvent
  | ErrorMessage
  | MessageQueued
  | MessageDequeued
  | MessageRequestComplete
  | MessageQueuedDeleted
  | MessageSteered
  | SuggestionResponse
  | TraceEvent
  | ConfirmationStateChanged
  | AssistantActivityState
  | TurnProfileAutoRouted
  | ConversationInferenceProfileUpdated
  | InteractionResolved;
