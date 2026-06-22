/**
 * Shared types for the runtime HTTP server and its route handlers.
 */
import type {
  ConversationMessage,
  ConversationMessageAttachment,
} from "../api/responses/conversation-message.js";
import type { ChannelId, InterfaceId } from "../channels/types.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { Conversation } from "../daemon/conversation.js";
import type {
  ConversationCreateOptions,
  SlackInboundMessageMetadata,
} from "../daemon/handlers/shared.js";

// Re-export so route modules (background-dispatch, etc.) can pull the type
// from the runtime barrel without reaching into daemon internals.
export type { SlackInboundMessageMetadata };
import type { ServerMessage } from "../daemon/message-protocol.js";
import type { AssistantEventHub } from "./assistant-event-hub.js";

export type {
  ApprovalCopyGenerator,
  ComposeApprovalMessageGenerativeOptions,
} from "./message-composer-types.js";
import type { TrustContext } from "../daemon/trust-context.js";

// ---------------------------------------------------------------------------
// Approval conversation flow types
// ---------------------------------------------------------------------------

/** The disposition returned by the approval conversation engine. */
export type ApprovalConversationDisposition =
  | "keep_pending"
  | "approve_once"
  | "reject";

/** Structured result from a single turn of the approval conversation. */
export interface ApprovalConversationResult {
  disposition: ApprovalConversationDisposition;
  replyText: string;
  /** Required when there are multiple pending approvals and the disposition is decision-bearing. */
  targetRequestId?: string;
}

/** Input context for the approval conversation engine. */
export interface ApprovalConversationContext {
  toolName: string;
  allowedActions: string[];
  role: "requester" | "guardian";
  pendingApprovals: Array<{ requestId: string; toolName: string }>;
  userMessage: string;
}

/**
 * Daemon-injected function that processes one turn of an approval conversation.
 * Takes conversation context and returns a structured approval decision + reply.
 */
export type ApprovalConversationGenerator = (
  context: ApprovalConversationContext,
) => Promise<ApprovalConversationResult>;

export interface RuntimeMessageConversationOptions {
  transport?: {
    channelId: ChannelId;
    hints?: string[];
    uxBrief?: string;
    chatType?: string;
    clientTimezone?: string;
  };
  assistantId?: string;
  trustContext?: TrustContext;
  /**
   * Whether this turn should permit interactive approval prompts.
   * Channel ingress sets this true so confirmations can be resolved
   * through channel approval flows.
   */
  isInteractive?: boolean;
  /** Channel command intent metadata (e.g. Telegram /start). */
  commandIntent?: { type: string; payload?: string; languageCode?: string };
  /**
   * Persisted user-facing content. When present, storage/UI use this value
   * while the model-facing turn continues to use `content`.
   */
  displayContent?: string;
  /** Optional callback to receive real-time agent loop events (text deltas, tool starts, etc.). */
  onEvent?: (msg: ServerMessage) => void;
  /**
   * Optional LLM call-site identifier. Channel ingress and other inbound paths
   * may pass this so the daemon's per-call provider config picks up the right
   * profile via `resolveCallSiteConfig`.
   */
  callSite?: LLMCallSite;
  /**
   * Slack inbound metadata captured at the channel ingress boundary. When
   * present (and the turn channel resolves to Slack), persistence writes a
   * `slackMeta` sub-object into the message's `metadata` JSON for the
   * chronological renderer to consume.
   */
  slackInbound?: SlackInboundMessageMetadata;
  /** IDs of user-uploaded attachments to resolve and include in the turn. */
  attachmentIds?: string[];
  /** Originating channel (e.g. "slack", "telegram"). Defaults to "vellum". */
  sourceChannel?: ChannelId;
  /** Originating interface (e.g. "cli", "web"). Defaults to "web". */
  sourceInterface?: InterfaceId;
}

export type MessageProcessor = (
  conversationId: string,
  content: string,
  options?: RuntimeMessageConversationOptions,
) => Promise<{ messageId: string; assistantMessageId?: string }>;

/**
 * Dependencies for the POST /v1/messages handler.
 *
 * The handler needs direct access to the conversation so it can check busy state,
 * persist user messages, fire the agent loop, or queue messages when busy.
 * Hub publishing wires outbound events to the SSE stream.
 */
export interface SendMessageDeps {
  getOrCreateConversation: (
    conversationId: string,
    options?: ConversationCreateOptions,
  ) => Promise<Conversation>;
  assistantEventHub: AssistantEventHub;
  resolveAttachments: (attachmentIds: string[]) => Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
    filePath?: string;
  }>;
}

export interface RuntimeHttpServerOptions {
  port?: number;
  /** Hostname / IP to bind to. Defaults to '127.0.0.1' (loopback-only). */
  hostname?: string;
}

/**
 * Structured attachment metadata returned on a history row. Canonical wire
 * shape lives in `@vellumai/assistant-api`; aliased here so route modules can
 * keep importing the runtime-local name.
 */
export type RuntimeAttachmentMetadata = ConversationMessageAttachment;

/**
 * The daemon's history-row payload. Canonical wire contract lives in
 * `@vellumai/assistant-api` (`responses/conversation-message.ts`) so the
 * producer and every consumer (web, CLI, evals) derive from one source.
 */
export type RuntimeMessagePayload = ConversationMessage;
