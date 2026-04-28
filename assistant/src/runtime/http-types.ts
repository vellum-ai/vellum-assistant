/**
 * Shared types for the runtime HTTP server and its route handlers.
 */
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
import type {
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
} from "./message-composer-types.js";


export type {
  ApprovalCopyGenerator,
  ApprovalMessageContext,
  ApprovalMessageScenario,
  ComposeApprovalMessageGenerativeOptions,
  ComposeGuardianActionMessageOptions,
  GuardianActionCopyGenerator,
  GuardianActionMessageContext,
  GuardianActionMessageScenario,
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

// ---------------------------------------------------------------------------
// Guardian follow-up conversation flow types
// ---------------------------------------------------------------------------

/** The disposition returned by the guardian follow-up conversation engine. */
export type GuardianFollowUpDisposition =
  | "call_back"
  | "decline"
  | "keep_pending";

/** Structured result from a single turn of the guardian follow-up conversation. */
export interface GuardianFollowUpTurnResult {
  disposition: GuardianFollowUpDisposition;
  replyText: string;
}

/** Input context for the guardian follow-up conversation engine. */
export interface GuardianFollowUpConversationContext {
  /** The original question that was asked during the voice call. */
  questionText: string;
  /** The guardian's late answer text that initiated the follow-up. */
  lateAnswerText: string;
  /** The guardian's latest reply in the follow-up conversation. */
  guardianReply: string;
}

/**
 * Daemon-injected function that processes one turn of a guardian follow-up
 * conversation. Classifies the guardian's intent into a structured disposition
 * and produces a natural reply.
 */
export type GuardianFollowUpConversationGenerator = (
  context: GuardianFollowUpConversationContext,
) => Promise<GuardianFollowUpTurnResult>;

export interface RuntimeMessageConversationOptions {
  transport?: {
    channelId: ChannelId;
    hints?: string[];
    uxBrief?: string;
    chatType?: string;
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
  /** Optional callback to receive real-time agent loop events (text deltas, tool starts, etc.). */
  onEvent?: (msg: ServerMessage) => void;
  /**
   * Optional LLM call-site identifier. Channel ingress and other inbound paths
   * may pass this so the daemon's per-call provider config picks up the right
   * profile via `resolveCallSiteConfig`. PRs 7-11 wire individual call-site
   * literals into specific call paths.
   */
  callSite?: LLMCallSite;
  /**
   * Slack inbound metadata captured at the channel ingress boundary. When
   * present (and the turn channel resolves to Slack), persistence writes a
   * `slackMeta` sub-object into the message's `metadata` JSON for the
   * chronological renderer to consume.
   */
  slackInbound?: SlackInboundMessageMetadata;
}

export type MessageProcessor = (
  conversationId: string,
  content: string,
  attachmentIds?: string[],
  options?: RuntimeMessageConversationOptions,
  sourceChannel?: ChannelId,
  sourceInterface?: InterfaceId,
) => Promise<{ messageId: string }>;

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
  processMessage?: MessageProcessor;
  /** Root directory for interface files on disk. */
  interfacesDir?: string;
  /** Daemon-injected generator for approval copy (provider-backed). */
  approvalCopyGenerator?: ApprovalCopyGenerator;
  /** Daemon-injected generator for conversational approval flow (provider-backed). */
  approvalConversationGenerator?: ApprovalConversationGenerator;
  /** Daemon-injected generator for guardian action copy (provider-backed). */
  guardianActionCopyGenerator?: GuardianActionCopyGenerator;
  /** Daemon-injected generator for guardian follow-up conversation (provider-backed). */
  guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator;
  /** Dependencies for the POST /v1/messages queue-if-busy handler. */
  sendMessageDeps?: SendMessageDeps;
}

export interface RuntimeAttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
  data?: string;
  thumbnailData?: string;
  fileBacked?: boolean;
}

export interface RuntimeMessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  attachments: RuntimeAttachmentMetadata[];
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isError?: boolean;
    riskLevel?: string;
    riskReason?: string;
    autoApproved?: boolean;
  }>;
  interfaces?: string[];
  surfaces?: Array<{
    surfaceId: string;
    surfaceType: string;
    title?: string;
    data: Record<string, unknown>;
    actions?: unknown[];
    display?: string;
  }>;
  textSegments?: string[];
  thinkingSegments?: string[];
  contentOrder?: string[];
  subagentNotification?: {
    subagentId: string;
    label: string;
    status: string;
    error?: string;
    conversationId?: string;
  };
}
