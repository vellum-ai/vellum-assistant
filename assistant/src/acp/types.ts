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
  /** Objective text the session was spawned with, if known. */
  task?: string;
  /** Tool-use id of the `acp_spawn` call that spawned this session, if any. */
  parentToolUseId?: string;
  /** Latest context-window usage gauge, from the most recent `usage_update`. */
  latestUsage?: AcpUsageSnapshot;
}

/** Context-window usage snapshot tracked from ACP `usage_update`. */
export interface AcpUsageSnapshot {
  usedTokens: number;
  contextSize: number;
  costAmount?: number;
  costCurrency?: string;
  /** Cumulative input tokens across all turns, from `PromptResponse.usage`. */
  inputTokens?: number;
  /** Cumulative output tokens across all turns, from `PromptResponse.usage`. */
  outputTokens?: number;
  /** Model the adapter reported for the session, if known. */
  model?: string;
  /** Cumulative cache-read tokens, from `PromptResponse.usage`. */
  cacheReadTokens?: number;
  /** Cumulative cache-write tokens, from `PromptResponse.usage`. */
  cacheWriteTokens?: number;
}
