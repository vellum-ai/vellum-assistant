/**
 * Shared types for the runtime HTTP server and its route handlers.
 */
import type { RunOrchestrator } from './run-orchestrator.js';

export interface RuntimeMessageSessionOptions {
  transport?: {
    channelId: string;
    hints?: string[];
    uxBrief?: string;
  };
}

export type MessageProcessor = (
  assistantId: string,
  conversationId: string,
  content: string,
  attachmentIds?: string[],
  options?: RuntimeMessageSessionOptions,
) => Promise<{ messageId: string }>;

/**
 * Non-blocking message processor that persists the user message and
 * starts the agent loop in the background, returning the messageId
 * immediately.
 */
export type NonBlockingMessageProcessor = (
  assistantId: string,
  conversationId: string,
  content: string,
  attachmentIds?: string[],
  options?: RuntimeMessageSessionOptions,
) => Promise<{ messageId: string }>;

export interface RuntimeHttpServerOptions {
  port?: number;
  processMessage?: MessageProcessor;
  /** Non-blocking processor for POST /messages (persists + fires agent loop). */
  persistAndProcessMessage?: NonBlockingMessageProcessor;
  /** Run orchestrator for the approval-flow run endpoints. */
  runOrchestrator?: RunOrchestrator;
  /** Root directory for interface files on disk. */
  interfacesDir?: string;
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
