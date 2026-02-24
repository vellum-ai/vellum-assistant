// Session lifecycle, auth, model config, and history types.

import type { ThreadType } from './shared.js';
import type { UserMessageAttachment } from './shared.js';

// === Client → Server ===

export interface SessionListRequest {
  type: 'session_list';
  /** Number of sessions to skip (for pagination). Defaults to 0. */
  offset?: number;
  /** Maximum number of sessions to return. Defaults to 50. */
  limit?: number;
}

/** Lightweight session transport metadata for channel identity and natural-language guidance. */
export interface SessionTransportMetadata {
  /** Logical channel identifier (e.g. "desktop", "telegram", "mobile"). */
  channelId: string;
  /** Optional natural-language hints for channel-specific UX behavior. */
  hints?: string[];
  /** Optional concise UX brief for this channel. */
  uxBrief?: string;
}

export interface SessionCreateRequest {
  type: 'session_create';
  title?: string;
  systemPromptOverride?: string;
  maxResponseTokens?: number;
  correlationId?: string;
  transport?: SessionTransportMetadata;
  threadType?: ThreadType;
  /** Skill IDs to pre-activate in the new session (loaded before the first message). */
  preactivatedSkillIds?: string[];
  /** If provided, automatically sent as the first user message after session creation. */
  initialMessage?: string;
}

export interface SessionSwitchRequest {
  type: 'session_switch';
  sessionId: string;
}

export interface AuthMessage {
  type: 'auth';
  token: string;
}

export interface PingMessage {
  type: 'ping';
}

export interface CancelRequest {
  type: 'cancel';
  sessionId?: string;
}

export interface DeleteQueuedMessage {
  type: 'delete_queued_message';
  sessionId: string;
  requestId: string;
}

export interface ModelGetRequest {
  type: 'model_get';
}

export interface ModelSetRequest {
  type: 'model_set';
  model: string;
}

export interface ImageGenModelSetRequest {
  type: 'image_gen_model_set';
  model: string;
}

export interface HistoryRequest {
  type: 'history_request';
  sessionId: string;
}

export interface UndoRequest {
  type: 'undo';
  sessionId: string;
}

export interface RegenerateRequest {
  type: 'regenerate';
  sessionId: string;
}

export interface UsageRequest {
  type: 'usage_request';
  sessionId: string;
}

export interface SandboxSetRequest {
  type: 'sandbox_set';
  enabled: boolean;
}

export interface SessionsClearRequest {
  type: 'sessions_clear';
}

export interface ConversationSearchRequest {
  type: 'conversation_search';
  /** The search query string. */
  query: string;
  /** Maximum number of conversations to return. Defaults to 20. */
  limit?: number;
  /** Maximum number of matching messages to return per conversation. Defaults to 3. */
  maxMessagesPerConversation?: number;
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
  type: 'conversation_search_response';
  query: string;
  results: ConversationSearchResultItem[];
}

export interface SessionInfo {
  type: 'session_info';
  sessionId: string;
  title: string;
  correlationId?: string;
  threadType?: ThreadType;
}

/** Channel binding metadata exposed in session/conversation list APIs. */
export interface ChannelBinding {
  sourceChannel: string;
  externalChatId: string;
  externalUserId?: string | null;
  displayName?: string | null;
  username?: string | null;
}

export interface SessionListResponse {
  type: 'session_list_response';
  sessions: Array<{ id: string; title: string; updatedAt: number; threadType?: ThreadType; source?: string; channelBinding?: ChannelBinding }>;
  /** Whether more sessions exist beyond the returned page. */
  hasMore?: boolean;
}

export interface SessionsClearResponse {
  type: 'sessions_clear_response';
  cleared: number;
}

export interface AuthResult {
  type: 'auth_result';
  success: boolean;
  message?: string;
}

export interface PongMessage {
  type: 'pong';
}

export interface DaemonStatusMessage {
  type: 'daemon_status';
  httpPort?: number;
  version?: string;
}

export interface GenerationCancelled {
  type: 'generation_cancelled';
  sessionId?: string;
}

export interface GenerationHandoff {
  type: 'generation_handoff';
  sessionId: string;
  requestId?: string;
  queuedCount: number;
  attachments?: UserMessageAttachment[];
}

export interface ModelInfo {
  type: 'model_info';
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
}

export interface HistoryResponseSurface {
  surfaceId: string;
  surfaceType: string;
  title?: string;
  data: Record<string, unknown>;
  actions?: Array<{ id: string; label: string; style?: string }>;
  display?: string;
}

export interface HistoryResponse {
  type: 'history_response';
  sessionId: string;
  messages: Array<{
    id?: string;  // Database message ID (for matching surfaces)
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
      status: 'completed' | 'failed' | 'aborted';
      error?: string;
      conversationId?: string;
    };
  }>;
}

export interface UndoComplete {
  type: 'undo_complete';
  removedCount: number;
  sessionId?: string;
}

export interface UsageUpdate {
  type: 'usage_update';
  inputTokens: number;
  outputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface UsageResponse {
  type: 'usage_response';
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  model: string;
}

export interface ContextCompacted {
  type: 'context_compacted';
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
  | 'PROVIDER_NETWORK'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_API'
  | 'CONTEXT_TOO_LARGE'
  | 'QUEUE_FULL'
  | 'SESSION_ABORTED'
  | 'SESSION_PROCESSING_FAILED'
  | 'REGENERATE_FAILED'
  | 'UNKNOWN';

export interface SessionErrorMessage {
  type: 'session_error';
  sessionId: string;
  code: SessionErrorCode;
  userMessage: string;
  retryable: boolean;
  debugDetails?: string;
}
