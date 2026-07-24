// Conversation lifecycle, auth, model config, and history types.

import type { AssistantStatusEvent } from "../../api/events/assistant-status.js";
import type { CompactionCircuitClosedEvent } from "../../api/events/compaction-circuit-closed.js";
import type { CompactionCircuitOpenEvent } from "../../api/events/compaction-circuit-open.js";
import type { ContextCompactedEvent } from "../../api/events/context-compacted.js";
import type { ConversationErrorEvent } from "../../api/events/conversation-error.js";
import type { ConversationListInvalidatedEvent } from "../../api/events/conversation-list-invalidated.js";
import type { ConversationNoticeEvent } from "../../api/events/conversation-notice.js";
import type { ConversationTitleUpdatedEvent } from "../../api/events/conversation-title-updated.js";
import type { GenerationCancelledEvent } from "../../api/events/generation-cancelled.js";
import type { GenerationHandoffEvent } from "../../api/events/generation-handoff.js";
import type { ModelInfoEvent } from "../../api/events/model-info.js";
import type { OpenConversationEvent } from "../../api/events/open-conversation.js";
import type { ScheduleConversationCreatedEvent } from "../../api/events/schedule-conversation-created.js";
import type { UsageProgressEvent } from "../../api/events/usage-progress.js";
import type { UsageUpdateEvent } from "../../api/events/usage-update.js";
import type {
  ChannelId,
  HostProxyInterfaceId,
  InterfaceId,
} from "../../channels/types.js";
import { supportsHostProxy } from "../../channels/types.js";
import type { ConversationType } from "./shared.js";
import type { UserMessageAttachment } from "./shared.js";

// === Client → Server ===

export interface ConversationListRequest {
  type: "conversation_list";
  /** Number of conversations to skip (for pagination). Defaults to 0. */
  offset?: number;
  /** Maximum number of conversations to return. Defaults to 50. */
  limit?: number;
}

/** Shared fields for all transport metadata variants. */
interface BaseTransportMetadata {
  /** Logical channel identifier (e.g. "desktop", "telegram", "mobile"). */
  channelId: ChannelId;
  /** Optional natural-language hints for channel-specific UX behavior. */
  hints?: string[];
  /** Optional concise UX brief for this channel. */
  uxBrief?: string;
  /** Chat type from the gateway (e.g. "private", "group", "supergroup", "channel"). */
  chatType?: string;
  /** IANA timezone reported by the active client for the current turn. */
  clientTimezone?: string;
  /**
   * The client's operating-system surface ("web" | "ios" | "macos"),
   * reported independently of {@link interfaceId}. The web bundle ships to a
   * browser, the Capacitor iOS shell, and the Electron macOS app, all on the
   * same `"web"` transport interface — `clientOs` is what tells the assistant
   * which OS it is actually talking to (rendered as the `client_os:` line in
   * the per-turn context) WITHOUT perturbing transport/host-proxy capability
   * inference, which keys off `interfaceId`.
   */
  clientOs?: string;
}

/**
 * Transport metadata for interfaces that support the full desktop host-proxy
 * set (see `HostProxyInterfaceId` / `supportsHostProxy`). Carries the host
 * environment fields the client reports so the `<workspace>` block renders
 * the user's actual machine rather than a containerized daemon's own OS.
 *
 * Today this variant is populated only by the macOS client, but the shape
 * is capability-keyed (not interface-name-keyed) so future host-capable
 * clients (e.g. a native Linux or Windows desktop) get the same treatment
 * automatically when added to `HostProxyInterfaceId`.
 */
export interface HostProxyTransportMetadata extends BaseTransportMetadata {
  /** Interface identifier — restricted to interfaces that support host proxies. */
  interfaceId: HostProxyInterfaceId;
  /** Home directory of the user on the host machine (e.g. `NSHomeDirectory()`). */
  hostHomeDir?: string;
  /** Username of the user on the host machine (e.g. `NSUserName()`). */
  hostUsername?: string;
}

/**
 * Transport metadata for interfaces that do NOT support host-proxy tools
 * (iOS, CLI, channel ingress, chrome-extension, etc.). No host environment
 * because the assistant has no local filesystem to address on the client.
 */
export interface NonHostProxyTransportMetadata extends BaseTransportMetadata {
  /** Interface identifier for this transport (e.g. "ios", "cli"). */
  interfaceId?: Exclude<InterfaceId, HostProxyInterfaceId>;
}

/**
 * Discriminated union of transport metadata variants, keyed on whether the
 * interface supports host-proxy tools (`supportsHostProxy`). The daemon uses
 * that same predicate at runtime to decide whether to populate / read host
 * environment fields on the conversation, so the type system and the runtime
 * gate stay in lock-step as new host-capable interfaces are added.
 */
export type ConversationTransportMetadata =
  | HostProxyTransportMetadata
  | NonHostProxyTransportMetadata;

/**
 * Type guard: does this transport belong to an interface that supports the
 * full host-proxy set? Wraps `supportsHostProxy` so the capability logic
 * stays in one place (channels/types.ts) and narrows the discriminated
 * union to `HostProxyTransportMetadata` for safe field access.
 */
export function isHostProxyTransport(
  transport: ConversationTransportMetadata,
): transport is HostProxyTransportMetadata {
  return (
    transport.interfaceId !== undefined &&
    supportsHostProxy(transport.interfaceId)
  );
}

export interface ConversationCreateRequest {
  type: "conversation_create";
  title?: string;
  systemPromptOverride?: string;
  maxResponseTokens?: number;
  correlationId?: string;
  transport?: ConversationTransportMetadata;
  conversationType?: ConversationType;
  /** Skill IDs to pre-activate in the new conversation (loaded before the first message). */
  preactivatedSkillIds?: string[];
  /** If provided, automatically sent as the first user message after conversation creation. */
  initialMessage?: string;
}

export interface ConversationSwitchRequest {
  type: "conversation_switch";
  conversationId: string;
}

export interface ConversationRenameRequest {
  type: "conversation_rename";
  conversationId: string;
  title: string;
}

export interface AuthMessage {
  type: "auth";
  token: string;
}

export interface PingMessage {
  type: "ping";
}

export interface CancelRequest {
  type: "cancel";
  conversationId?: string;
}

export interface DeleteQueuedMessage {
  type: "delete_queued_message";
  conversationId: string;
  requestId: string;
}

export interface ModelGetRequest {
  type: "model_get";
}

export interface ImageGenModelSetRequest {
  type: "image_gen_model_set";
  model: string;
}

export interface UndoRequest {
  type: "undo";
  conversationId: string;
}

export interface UsageRequest {
  type: "usage_request";
  conversationId: string;
}

export interface ConversationsClearRequest {
  type: "conversations_clear";
}

export interface ReorderConversationsRequest {
  type: "reorder_conversations";
  updates: Array<{
    conversationId: string;
    displayOrder: number | null;
    isPinned: boolean;
  }>;
}

// === Server → Client ===

export interface ConversationInfo {
  type: "conversation_info";
  conversationId: string;
  title: string;
  correlationId?: string;
  conversationType?: ConversationType;
  /**
   * Per-conversation override for the LLM inference profile. `undefined`
   * means the conversation inherits the workspace `llm.activeProfile`.
   */
  inferenceProfile?: string;
}

/** Channel binding metadata exposed in conversation list APIs. */
interface ChannelBinding {
  sourceChannel: ChannelId;
  externalChatId: string;
  externalChatName?: string | null;
  externalThreadId?: string | null;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
  slackThread?: {
    channelId: string;
    threadTs: string;
    link?: {
      appUrl?: string;
      webUrl?: string;
    };
  };
  slackChannel?: {
    channelId: string;
    name?: string;
    link?: {
      webUrl?: string;
    };
  };
}

/** Attention state metadata for a conversation's latest assistant message. */
interface AssistantAttention {
  hasUnseenLatestAssistantMessage: boolean;
  latestAssistantMessageAt?: number;
  lastSeenAssistantMessageAt?: number;
  lastSeenConfidence?: string;
  lastSeenSignalType?: string;
}

interface ConversationForkParent {
  conversationId: string;
  messageId: string;
  title: string;
}

export interface ConversationListResponse {
  type: "conversation_list_response";
  conversations: Array<{
    id: string;
    title: string;
    createdAt?: number;
    updatedAt: number;
    conversationType?: ConversationType;
    source?: string;
    scheduleJobId?: string;
    channelBinding?: ChannelBinding;
    conversationOriginChannel?: ChannelId;
    conversationOriginInterface?: InterfaceId;
    assistantAttention?: AssistantAttention;
    displayOrder?: number;
    isPinned?: boolean;
    forkParent?: ConversationForkParent;
    /**
     * Per-conversation override for the LLM inference profile. Omitted when
     * the conversation inherits the workspace `llm.activeProfile`.
     */
    inferenceProfile?: string;
  }>;
  /** Whether more conversations exist beyond the returned page. */
  hasMore?: boolean;
}

interface HistoryResponseToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot). @deprecated Use imageDataList. */
  imageData?: string;
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot, image generation). */
  imageDataList?: string[];
  /** Workspace attachment ids for tool-result images persisted as references; clients fetch bytes by id on render instead of embedding base64. */
  imageAttachmentIds?: string[];
  /** Unix ms when the tool started executing. */
  startedAt?: number;
  /** Unix ms when the tool completed. */
  completedAt?: number;
  /** Confirmation decision for this tool call: "approved" | "denied" | "timed_out". */
  confirmationDecision?: string;
  /** Friendly label for the confirmation (e.g. "Edit File", "Run Command"). */
  confirmationLabel?: string;
  /** Risk level at the time of invocation ("low" | "medium" | "high" | "unknown"). */
  riskLevel?: string;
  /** Human-readable reason for the risk classification. */
  riskReason?: string;
  /**
   * @deprecated Use `approvalMode` and `approvalReason` instead.
   * Kept for backward compatibility during the migration window.
   */
  autoApproved?: boolean;
  /** How the approval decision was reached: prompted, auto, blocked, or unknown (legacy). */
  approvalMode?: string;
  /** Why the approval decision was reached (stable enum for client display). */
  approvalReason?: string;
  /** Snapshot of the auto-approve threshold at execution time. */
  riskThreshold?: string;
}

interface HistoryResponseSurface {
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
  actions?: Array<{
    id: string;
    label: string;
    style?: string;
    data?: Record<string, unknown>;
  }>;
  display?: string;
  /** True when the surface was completed (e.g. form submitted, action taken). */
  completed?: boolean;
  /** Human-readable summary shown in the completion chip. */
  completionSummary?: string;
}

export interface HistoryResponse {
  type: "history_response";
  conversationId: string;
  messages: Array<{
    /** Database ID used by clients for the rendered message. */
    id?: string;
    role: string;
    text: string;
    timestamp: number;
    toolCalls?: HistoryResponseToolCall[];
    /** True when tool_use blocks appeared before any text block in the original content. */
    toolCallsBeforeText?: boolean;
    attachments?: UserMessageAttachment[];
    /** Text segments split by tool-call boundaries. Preserves interleaving order. */
    textSegments?: string[];
    /** Content block ordering using "text:N", "tool:N", "surface:N" encoding. */
    contentOrder?: string[];
    /** UI surfaces (widgets) embedded in the message. */
    surfaces?: HistoryResponseSurface[];
    /** Present when this message is a subagent lifecycle notification (running/completed/failed/aborted). */
    subagentNotification?: {
      subagentId: string;
      label: string;
      status: "running" | "completed" | "failed" | "aborted";
      error?: string;
      conversationId?: string;
      objective?: string;
    };
    /** True when text or tool result content was truncated due to maxTextChars/maxToolResultChars. */
    wasTruncated?: boolean;
  }>;
  /** Whether older messages exist beyond the returned page. */
  hasMore: boolean;
  /** Timestamp of the oldest message in the response (client uses as next pagination cursor). */
  oldestTimestamp?: number;
  /** ID of the oldest message in the response (tie-breaker for same-millisecond cursors). */
  oldestMessageId?: string;
}

export interface UndoComplete {
  type: "undo_complete";
  removedCount: number;
  conversationId?: string;
}

export interface UsageResponse {
  type: "usage_response";
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

/**
 * Emitted when the compaction circuit breaker trips. After three consecutive
 * summary-LLM failures (with local fallback covering each), auto-compaction is
 * suspended until `openUntil` to avoid repeatedly hammering a broken provider.
 * User-initiated compaction (`/compact`, `force: true`) bypasses the breaker.
 *
 * `conversationId` scopes the event so clients can ignore breaker trips from
 * other conversations — `EventStreamClient` broadcasts every parsed server
 * message to all subscribers, so without this field a breaker trip in one
 * conversation would set the "auto-compaction paused" banner on every open
 * `ChatViewModel`.
 */

// `open_conversation` is a migrated event: its canonical wire contract lives
// in `../../api/events/open-conversation.ts` (imported as
// `OpenConversationEvent`). Instructs the client to open and, by default,
// focus a conversation — see that file for the full field docs.

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _ConversationsClientMessages =
  | AuthMessage
  | PingMessage
  | CancelRequest
  | DeleteQueuedMessage
  | ModelGetRequest
  | ImageGenModelSetRequest
  | UndoRequest
  | UsageRequest
  | ConversationListRequest
  | ConversationCreateRequest
  | ConversationSwitchRequest
  | ConversationRenameRequest
  | ConversationsClearRequest
  | ReorderConversationsRequest;

export type _ConversationsServerMessages =
  | AssistantStatusEvent
  | GenerationCancelledEvent
  | GenerationHandoffEvent
  | ModelInfoEvent
  | HistoryResponse
  | UndoComplete
  | UsageUpdateEvent
  | UsageProgressEvent
  | UsageResponse
  | ContextCompactedEvent
  | CompactionCircuitOpenEvent
  | CompactionCircuitClosedEvent
  | ConversationErrorEvent
  | ConversationNoticeEvent
  | ConversationInfo
  | ConversationTitleUpdatedEvent
  | ConversationListResponse
  | ConversationListInvalidatedEvent
  | ScheduleConversationCreatedEvent
  | OpenConversationEvent;
