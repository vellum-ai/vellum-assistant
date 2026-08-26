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
   * Identity of the Claude token `prepareAgentEnv` read from the vault into
   * `env`. Compared against the token believed stored when a run reports its
   * credential rejected, which is how a rejection of an already-replaced token
   * is told apart from a real one. Absent for agents that read no Claude
   * credential, and for a configured token, which carries no vault identity.
   */
  credentialDigest?: string;
  credentialFromConfig?: boolean;
  /**
   * Credential generation current when a configured Claude token was taken.
   * A rejection is recorded against this, not against the generation at
   * failure, so a replacement written in between counts as superseding it.
   */
  configCredentialGeneration?: number;
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
