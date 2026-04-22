// Conversation lifecycle, auth, model config, and history types.

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

export interface ModelSetRequest {
  type: "model_set";
  model: string;
  provider?: string;
}

export interface ImageGenModelSetRequest {
  type: "image_gen_model_set";
  model: string;
}

export interface MessageContentResponse {
  type: "message_content_response";
  conversationId: string;
  messageId: string;
  text?: string;
  toolCalls?: Array<{
    name: string;
    result?: string;
    input?: Record<string, unknown>;
  }>;
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

export interface ConversationSearchMatchingMessage {
  messageId: string;
  role: string;
  /** Plain-text excerpt around the match, truncated to ~200 chars. */
  excerpt: string;
  createdAt: number;
}

export interface ConversationSearchResultItem {
  conversationId: string;
  conversationTitle: string | null;
  conversationUpdatedAt: number;
  matchingMessages: ConversationSearchMatchingMessage[];
}

export interface ConversationSearchResponse {
  type: "conversation_search_response";
  query: string;
  results: ConversationSearchResultItem[];
}

export interface ConversationInfo {
  type: "conversation_info";
  conversationId: string;
  title: string;
  correlationId?: string;
  conversationType?: ConversationType;
  hostAccess: boolean;
}

export interface ConversationTitleUpdated {
  type: "conversation_title_updated";
  conversationId: string;
  title: string;
}

/** Channel binding metadata exposed in conversation list APIs. */
export interface ChannelBinding {
  sourceChannel: ChannelId;
  externalChatId: string;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
}

/** Attention state metadata for a conversation's latest assistant message. */
export interface AssistantAttention {
  hasUnseenLatestAssistantMessage: boolean;
  latestAssistantMessageAt?: number;
  lastSeenAssistantMessageAt?: number;
  lastSeenConfidence?: string;
  lastSeenSignalType?: string;
}

export interface ConversationForkParent {
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
    hostAccess: boolean;
    scheduleJobId?: string;
    channelBinding?: ChannelBinding;
    conversationOriginChannel?: ChannelId;
    conversationOriginInterface?: InterfaceId;
    assistantAttention?: AssistantAttention;
    displayOrder?: number;
    isPinned?: boolean;
    forkParent?: ConversationForkParent;
  }>;
  /** Whether more conversations exist beyond the returned page. */
  hasMore?: boolean;
}

export interface ConversationsClearResponse {
  type: "conversations_clear_response";
  cleared: number;
}

export interface AuthResult {
  type: "auth_result";
  success: boolean;
  message?: string;
}

export interface PongMessage {
  type: "pong";
}

export interface AssistantStatusMessage {
  type: "assistant_status";
  version?: string;
  keyFingerprint?: string;
}

export interface GenerationCancelled {
  type: "generation_cancelled";
  conversationId?: string;
}

export interface GenerationHandoff {
  type: "generation_handoff";
  conversationId: string;
  requestId?: string;
  queuedCount: number;
  attachments?: UserMessageAttachment[];
  attachmentWarnings?: string[];
  /** Database ID of the persisted assistant message, if any. */
  messageId?: string;
}

export interface ModelInfo {
  type: "model_info";
  model: string;
  provider: string;
  configuredProviders?: string[];
  availableModels?: Array<{ id: string; displayName: string }>;
  allProviders?: Array<{
    id: string;
    displayName: string;
    models: Array<{ id: string; displayName: string }>;
    defaultModel: string;
    apiKeyUrl?: string;
    apiKeyPlaceholder?: string;
  }>;
}

export interface HistoryResponseToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot). @deprecated Use imageDataList. */
  imageData?: string;
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot, image generation). */
  imageDataList?: string[];
  /** Unix ms when the tool started executing. */
  startedAt?: number;
  /** Unix ms when the tool completed. */
  completedAt?: number;
  /** Confirmation decision for this tool call: "approved" | "denied" | "timed_out". */
  confirmationDecision?: string;
  /** Friendly label for the confirmation (e.g. "Edit File", "Run Command"). */
  confirmationLabel?: string;
}

export interface HistoryResponseSurface {
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
    id?: string; // Database message ID (for matching surfaces)
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

export interface UsageUpdate {
  type: "usage_update";
  conversationId: string;
  inputTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
  contextWindowTokens?: number;
  contextWindowMaxTokens?: number;
}

export interface UsageResponse {
  type: "usage_response";
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

/**
 * Emitted after a compaction turn completes (both auto-compaction and
 * `/compact`). Carries the fresh `estimatedInputTokens` so clients can refresh
 * the context-window indicator without waiting for the next `usage_update`.
 *
 * Scoped per-conversation — see `CompactionCircuitOpen` doc for why.
 */
export interface ContextCompacted {
  type: "context_compacted";
  conversationId: string;
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
  /**
   * Quality signals for the generated summary. Emitted for every
   * compaction (including truncation-only paths where the summary text
   * is unchanged from the prior pass). Consumers can use these to detect
   * regressions without needing to read the summary text itself.
   *
   * - `summaryCharCount`: length of the produced summary text.
   * - `summaryHeaderCount`: number of `## ` section headers in the summary.
   * - `summaryHadMemoryEcho`: `true` if the summary contains any runtime
   *   injection tag (e.g. `<memory`, `<turn_context>`, `<workspace>`).
   *   Should always be `false` — `true` indicates the compaction strip
   *   logic failed to remove an injected block from the summarizer input.
   */
  summaryCharCount?: number;
  summaryHeaderCount?: number;
  summaryHadMemoryEcho?: boolean;
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
export interface CompactionCircuitOpen {
  type: "compaction_circuit_open";
  conversationId: string;
  reason: "3_consecutive_failures";
  /** Timestamp (ms since epoch) when the breaker will allow auto-compaction again. */
  openUntil: number;
}

/**
 * Emitted when the compaction circuit breaker transitions from open → closed
 * because a successful compaction reset
 * `ctx.compactionCircuitOpenUntil`. The Swift client clears its banner state
 * on receipt so the "auto-compaction paused" indicator dismisses immediately
 * instead of lingering until the original `openUntil` deadline (up to 1h).
 *
 * Only fires on the open→closed transition — successful compactions while
 * the breaker was already closed would be noise.
 *
 * Scoped per-conversation — see `CompactionCircuitOpen` doc for why.
 */
export interface CompactionCircuitClosed {
  type: "compaction_circuit_closed";
  conversationId: string;
}

export type ConversationErrorCode =
  | "PROVIDER_NETWORK"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_OVERLOADED"
  | "PROVIDER_API"
  | "PROVIDER_BILLING"
  | "PROVIDER_ORDERING"
  | "PROVIDER_WEB_SEARCH"
  | "PROVIDER_MODIFIED_THINKING"
  | "PROVIDER_NOT_CONFIGURED"
  | "MANAGED_KEY_INVALID"
  | "CONTEXT_TOO_LARGE"
  | "CONVERSATION_ABORTED"
  | "CONVERSATION_PROCESSING_FAILED"
  | "REGENERATE_FAILED"
  | "UNKNOWN";

export interface ConversationErrorMessage {
  type: "conversation_error";
  conversationId: string;
  code: ConversationErrorCode;
  userMessage: string;
  retryable: boolean;
  debugDetails?: string;
  /** Machine-readable error category for log report metadata and triage. */
  errorCategory?: string;
}

/** Reason the conversation list was invalidated. */
export type ConversationListInvalidatedReason =
  | "created"
  | "renamed"
  | "deleted"
  | "reordered"
  | "seen_changed";

/** Server push — tells clients their sidebar conversation list is stale. */
export interface ConversationListInvalidated {
  type: "conversation_list_invalidated";
  reason: ConversationListInvalidatedReason;
}

/** Server push — broadcast when a schedule creates a conversation. */
export interface ScheduleConversationCreated {
  type: "schedule_conversation_created";
  conversationId: string;
  scheduleJobId: string;
  title: string;
}

/**
 * Server push — instructs the client to open and focus a conversation. If
 * the conversation isn't already present in the client's sidebar list (e.g.
 * it was just created via `POST /v1/conversations`), the client should stub
 * a sidebar entry using the provided `title` before navigating.
 */
export interface OpenConversation {
  type: "open_conversation";
  conversationId: string;
  /** Optional conversation title; supplied when the client may not yet have the conversation in its list. */
  title?: string;
  /** Optional message ID to scroll to after focus. */
  anchorMessageId?: string;
  /** When `false`, the client should register the conversation in its sidebar (so it's visible and navigable) but must NOT switch focus to it. Omitting the field defaults to `true` for backward compatibility with existing single-target 'jump to conversation' callers. */
  focus?: boolean;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _ConversationsClientMessages =
  | AuthMessage
  | PingMessage
  | CancelRequest
  | DeleteQueuedMessage
  | ModelGetRequest
  | ModelSetRequest
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
  | AuthResult
  | PongMessage
  | AssistantStatusMessage
  | GenerationCancelled
  | GenerationHandoff
  | ModelInfo
  | HistoryResponse
  | UndoComplete
  | UsageUpdate
  | UsageResponse
  | ContextCompacted
  | CompactionCircuitOpen
  | CompactionCircuitClosed
  | ConversationErrorMessage
  | ConversationInfo
  | ConversationTitleUpdated
  | ConversationListResponse
  | ConversationsClearResponse
  | ConversationSearchResponse
  | MessageContentResponse
  | ConversationListInvalidated
  | ScheduleConversationCreated
  | OpenConversation;
