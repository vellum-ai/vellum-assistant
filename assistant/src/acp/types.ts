/**
 * ACP (Agent Client Protocol) types for agent session management and configuration.
 */

import type { StopReason } from "@agentclientprotocol/sdk";

/**
 * Configuration for a single ACP agent process.
 */
export interface AcpAgentConfig {
  command: string;
  args: string[];
  description?: string;
  env?: Record<string, string>;
}

/**
 * Runtime state of an ACP session.
 */
export interface AcpSessionState {
  id: string;
  agentId: string;
  acpSessionId: string;
  /** Conversation that spawned this session. */
  parentConversationId: string;
  status: "initializing" | "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  error?: string;
  stopReason?: StopReason;
}
