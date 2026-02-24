/**
 * Shared types for the runtime HTTP server and its route handlers.
 */
import type { RunOrchestrator } from './run-orchestrator.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import type { ApprovalMessageContext, ComposeApprovalMessageGenerativeOptions } from './approval-message-composer.js';

/**
 * Daemon-injected function that generates approval copy using a provider.
 * Returns generated text or `null` on failure (caller falls back to deterministic text).
 */
export type ApprovalCopyGenerator = (
  context: ApprovalMessageContext,
  options?: ComposeApprovalMessageGenerativeOptions,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Approval conversation flow types
// ---------------------------------------------------------------------------

/** The disposition returned by the approval conversation engine. */
export type ApprovalConversationDisposition =
  | 'keep_pending'
  | 'approve_once'
  | 'approve_always'
  | 'reject';

/** Structured result from a single turn of the approval conversation. */
export interface ApprovalConversationResult {
  disposition: ApprovalConversationDisposition;
  replyText: string;
  /** Required when there are multiple pending approvals and the disposition is decision-bearing. */
  targetRunId?: string;
}

/** Input context for the approval conversation engine. */
export interface ApprovalConversationContext {
  toolName: string;
  allowedActions: string[];
  role: 'requester' | 'guardian';
  pendingApprovals: Array<{ runId: string; toolName: string }>;
  userMessage: string;
}

/**
 * Daemon-injected function that processes one turn of an approval conversation.
 * Takes conversation context and returns a structured approval decision + reply.
 */
export type ApprovalConversationGenerator = (
  context: ApprovalConversationContext,
) => Promise<ApprovalConversationResult>;

export interface RuntimeMessageSessionOptions {
  transport?: {
    channelId: string;
    hints?: string[];
    uxBrief?: string;
  };
  assistantId?: string;
  guardianContext?: GuardianRuntimeContext;
  /** Channel command intent metadata (e.g. Telegram /start). */
  commandIntent?: { type: string; payload?: string; languageCode?: string };
}

export type MessageProcessor = (
  conversationId: string,
  content: string,
  attachmentIds?: string[],
  options?: RuntimeMessageSessionOptions,
  sourceChannel?: string,
) => Promise<{ messageId: string }>;

/**
 * Non-blocking message processor that persists the user message and
 * starts the agent loop in the background, returning the messageId
 * immediately.
 */
export type NonBlockingMessageProcessor = (
  conversationId: string,
  content: string,
  attachmentIds?: string[],
  options?: RuntimeMessageSessionOptions,
  sourceChannel?: string,
) => Promise<{ messageId: string }>;

export interface RuntimeHttpServerOptions {
  port?: number;
  /** Hostname / IP to bind to. Defaults to '127.0.0.1' (loopback-only). */
  hostname?: string;
  /** Bearer token required on every request (except health checks). */
  bearerToken?: string;
  processMessage?: MessageProcessor;
  /** Non-blocking processor for POST /messages (persists + fires agent loop). */
  persistAndProcessMessage?: NonBlockingMessageProcessor;
  /** Run orchestrator for the approval-flow run endpoints. */
  runOrchestrator?: RunOrchestrator;
  /** Root directory for interface files on disk. */
  interfacesDir?: string;
  /** Daemon-injected generator for approval copy (provider-backed). */
  approvalCopyGenerator?: ApprovalCopyGenerator;
  /** Daemon-injected generator for conversational approval flow (provider-backed). */
  approvalConversationGenerator?: ApprovalConversationGenerator;
}

export interface RuntimeAttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
}

export interface RuntimeMessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  attachments: RuntimeAttachmentMetadata[];
  toolCalls?: Array<{ name: string; input: Record<string, unknown>; result?: string; isError?: boolean }>;
  interfaces?: string[];
}
