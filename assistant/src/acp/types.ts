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
  /**
   * Identity of the Claude token `prepareAgentEnv` resolved into `env`,
   * whichever source it came from. Recorded on the history row when Claude
   * refuses it, so the marker can later be compared against the credential a
   * spawn would resolve now. Absent for agents that use no Claude credential.
   */
  credentialDigest?: string;
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
  /**
   * Credential failure that ended the run, when one did. Persisted on the
   * history row so a client that reopens the conversation can re-raise the
   * inline Connect card, and cleared there when a replacement token lands.
   */
  authErrorCode?: string;
  /** Digest of the Claude token that failure was refused on, carried to the
   *  history row so the marker can be compared against the credential a later
   *  spawn resolves. */
  authErrorCredential?: string;
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
}
