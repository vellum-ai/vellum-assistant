// User/assistant messages, tool results, confirmations, secrets, errors, and generation lifecycle.

import type { AssistantActivityStateEvent } from "../../api/events/assistant-activity-state.js";
import type { AssistantTextDeltaEvent } from "../../api/events/assistant-text-delta.js";
import type { AssistantThinkingDeltaEvent } from "../../api/events/assistant-thinking-delta.js";
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
import type { ToolOutputChunkEvent } from "../../api/events/tool-output-chunk.js";
import type { ToolResultEvent } from "../../api/events/tool-result.js";
import type { ToolUsePreviewStartEvent } from "../../api/events/tool-use-preview-start.js";
import type { ToolUseStartEvent } from "../../api/events/tool-use-start.js";
import type { UserMessageEchoEvent } from "../../api/events/user-message-echo.js";
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
  | AssistantThinkingDeltaEvent
  | ToolUseStartEvent
  | ToolUsePreviewStartEvent
  | ToolOutputChunkEvent
  | ToolInputDelta
  | ToolResultEvent
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
  | ConfirmationStateChanged
  | AssistantActivityStateEvent
  | ConversationInferenceProfileUpdated
  | InteractionResolvedEvent;
