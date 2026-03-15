// Session lifecycle, auth, model config, and history types.

import type { ChannelId, InterfaceId } from "../../channels/types.js";
import type { ConversationType } from "./shared.js";
import type { UserMessageAttachment } from "./shared.js";

// === Client → Server ===

export interface SessionListRequest {
  type: "session_list";
  /** Number of sessions to skip (for pagination). Defaults to 0. */
  offset?: number;
  /** Maximum number of sessions to return. Defaults to 50. */
  limit?: number;
}

/** Lightweight session transport metadata for channel identity and natural-language guidance. */
export interface SessionTransportMetadata {
  /** Logical channel identifier (e.g. "desktop", "telegram", "mobile"). */
  channelId: ChannelId;
  /** Interface identifier for this transport (e.g. "macos", "ios", "cli"). */
  interfaceId?: InterfaceId;
  /** Optional natural-language hints for channel-specific UX behavior. */
  hints?: string[];
  /** Optional concise UX brief for this channel. */
  uxBrief?: string;
  /** Chat type from the gateway (e.g. "private", "group", "supergroup", "channel"). */
  chatType?: string;
}

export interface SessionCreateRequest {
  type: "session_create";
  title?: string;
  systemPromptOverride?: string;
  maxResponseTokens?: number;
  correlationId?: string;
  transport?: SessionTransportMetadata;
  conversationType?: ConversationType;
  /** Skill IDs to pre-activate in the new session (loaded before the first message). */
  preactivatedSkillIds?: string[];
  /** If provided, automatically sent as the first user message after session creation. */
  initialMessage?: string;
}

export interface SessionSwitchRequest {
  type: "session_switch";
  sessionId: string;
}

export interface SessionRenameRequest {
  type: "session_rename";
  sessionId: string;
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
  sessionId?: string;
}

export interface DeleteQueuedMessage {
  type: "delete_queued_message";
  sessionId: string;
  requestId: string;
}

export interface ModelGetRequest {
  type: "model_get";
}

export interface ModelSetRequest {
  type: "model_set";
  model: string;
}

export interface ImageGenModelSetRequest {
  type: "image_gen_model_set";
  model: string;
}

export interface MessageContentResponse {
  type: "message_content_response";
  sessionId: string;
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
  sessionId: string;
}

export interface RegenerateRequest {
  type: "regenerate";
  sessionId: string;
}

export interface UsageRequest {
  type: "usage_request";
  sessionId: string;
}

export interface SessionsClearRequest {
  type: "sessions_clear";
}

export interface ReorderConversationsRequest {
  type: "reorder_conversations";
  updates: Array<{
    sessionId: string;
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

export interface SessionInfo {
  type: "session_info";
  sessionId: string;
  title: string;
  correlationId?: string;
  conversationType?: ConversationType;
}

export interface SessionTitleUpdated {
  type: "session_title_updated";
  sessionId: string;
  title: string;
}

/** Channel binding metadata exposed in session/conversation list APIs. */
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

export interface SessionListResponse {
  type: "session_list_response";
  sessions: Array<{
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
  }>;
  /** Whether more sessions exist beyond the returned page. */
  hasMore?: boolean;
}

export interface SessionsClearResponse {
  type: "sessions_clear_response";
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

export interface DaemonStatusMessage {
  type: "daemon_status";
  httpPort?: number;
  version?: string;
  keyFingerprint?: string;
}

export interface GenerationCancelled {
  type: "generation_cancelled";
  sessionId?: string;
}

export interface GenerationHandoff {
  type: "generation_handoff";
  sessionId: string;
  requestId?: string;
  queuedCount: number;
  attachments?: UserMessageAttachment[];
  /** Database ID of the persisted assistant message, if any. */
  messageId?: string;
}

export interface ModelInfo {
  type: "model_info";
  model: string;
  provider: string;
  configuredProviders?: string[];
}

export interface HistoryResponseToolCall {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot). */
  imageData?: string;
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
}

export interface HistoryResponse {
  type: "history_response";
  sessionId: string;
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
    /** Present when this message is a subagent lifecycle notification (completed/failed/aborted). */
    subagentNotification?: {
      subagentId: string;
      label: string;
      status: "completed" | "failed" | "aborted";
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
  sessionId?: string;
}

export interface UsageUpdate {
  type: "usage_update";
  inputTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface UsageResponse {
  type: "usage_response";
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface ContextCompacted {
  type: "context_compacted";
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
}

export type SessionErrorCode =
  | "PROVIDER_NETWORK"
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_API"
  | "PROVIDER_BILLING"
  | "PROVIDER_ORDERING"
  | "PROVIDER_WEB_SEARCH"
  | "CONTEXT_TOO_LARGE"
  | "SESSION_ABORTED"
  | "SESSION_PROCESSING_FAILED"
  | "REGENERATE_FAILED"
  | "UNKNOWN";

export interface SessionErrorMessage {
  type: "session_error";
  sessionId: string;
  code: SessionErrorCode;
  userMessage: string;
  retryable: boolean;
  debugDetails?: string;
  /** Machine-readable error category for log report metadata and triage. */
  errorCategory?: string;
}

/** Server push — broadcast when a schedule creates a conversation. */
export interface ScheduleConversationCreated {
  type: "schedule_conversation_created";
  conversationId: string;
  scheduleJobId: string;
  title: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _SessionsClientMessages =
  | AuthMessage
  | PingMessage
  | CancelRequest
  | DeleteQueuedMessage
  | ModelGetRequest
  | ModelSetRequest
  | ImageGenModelSetRequest
  | UndoRequest
  | RegenerateRequest
  | UsageRequest
  | SessionListRequest
  | SessionCreateRequest
  | SessionSwitchRequest
  | SessionRenameRequest
  | SessionsClearRequest
  | ReorderConversationsRequest;

export type _SessionsServerMessages =
  | AuthResult
  | PongMessage
  | DaemonStatusMessage
  | GenerationCancelled
  | GenerationHandoff
  | ModelInfo
  | HistoryResponse
  | UndoComplete
  | UsageUpdate
  | UsageResponse
  | ContextCompacted
  | SessionErrorMessage
  | SessionInfo
  | SessionTitleUpdated
  | SessionListResponse
  | SessionsClearResponse
  | ConversationSearchResponse
  | MessageContentResponse
  | ScheduleConversationCreated;
