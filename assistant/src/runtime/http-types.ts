/**
 * Shared types for the runtime HTTP server and its route handlers.
 */
import type { RunOrchestrator } from './run-orchestrator.js';
import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import type {
  ApprovalMessageContext,
  ComposeApprovalMessageGenerativeOptions,
} from './approval-message-composer.js';

/**
 * Dependency-injected approval copy generator. The daemon wires a real
 * provider-backed implementation; the runtime falls back to deterministic
 * templates when no generator is supplied.
 */
export type ApprovalCopyGenerator = (
  context: ApprovalMessageContext,
  fallbackText: string,
  options: ComposeApprovalMessageGenerativeOptions,
) => Promise<string | null>;

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
  /** Injected approval copy generator (daemon provides real provider-backed impl). */
  approvalCopyGenerator?: ApprovalCopyGenerator;
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
