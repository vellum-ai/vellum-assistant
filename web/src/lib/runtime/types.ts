/**
 * Runtime client contract — same interface for local and cloud runtimes.
 *
 * All assistant-owned operations (messages, attachments, channels) flow
 * through this interface so web routes never branch on deployment mode.
 */

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface RuntimeHealthResponse {
  status: string;
  message?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface RuntimeMessageAttachment {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
}

export interface RuntimeMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  attachments: RuntimeMessageAttachment[];
  toolCalls?: unknown[];
}

export interface ListMessagesParams {
  conversationKey: string;
  cursor?: string;
  limit?: number;
}

export interface ListMessagesResponse {
  messages: RuntimeMessage[];
  nextCursor?: string;
}

export interface SendMessageParams {
  conversationKey: string;
  content: string;
  attachmentIds?: string[];
}

export interface SendMessageResponse {
  accepted: boolean;
  messageId: string;
  runId?: string;
  assistantMessage?: RuntimeMessage;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export interface UploadAttachmentParams {
  filename: string;
  mimeType: string;
  data: string; // base64-encoded
}

export interface UploadAttachmentResponse {
  id: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  kind: string;
}

export interface DeleteAttachmentParams {
  attachmentId: string;
}

// ---------------------------------------------------------------------------
// Suggestion
// ---------------------------------------------------------------------------

export interface GetSuggestionParams {
  conversationKey: string;
  messageId?: string;
}

export interface GetSuggestionResponse {
  suggestion: string | null;
  messageId: string | null;
  source: "heuristic" | "llm" | "none";
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface ChannelInboundParams {
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
  content: string;
  senderName?: string;
}

export interface ChannelInboundResponse {
  accepted: boolean;
  assistantMessage?: RuntimeMessage;
}

export interface ChannelDeliveryAckParams {
  sourceChannel: string;
  externalChatId: string;
  externalMessageId: string;
}

// ---------------------------------------------------------------------------
// Client interface
// ---------------------------------------------------------------------------

export interface RuntimeClient {
  health(): Promise<RuntimeHealthResponse>;

  listMessages(params: ListMessagesParams): Promise<ListMessagesResponse>;
  sendMessage(params: SendMessageParams): Promise<SendMessageResponse>;

  getSuggestion(params: GetSuggestionParams): Promise<GetSuggestionResponse>;

  uploadAttachment(params: UploadAttachmentParams): Promise<UploadAttachmentResponse>;
  deleteAttachment(params: DeleteAttachmentParams): Promise<void>;

  channelInbound(params: ChannelInboundParams): Promise<ChannelInboundResponse>;
  channelDeliveryAck(params: ChannelDeliveryAckParams): Promise<void>;
}
