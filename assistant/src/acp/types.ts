/**
 * ACP (Agent Client Protocol) types for agent session management and configuration.
 */

import type { StopReason } from "@agentclientprotocol/sdk";

import type { AcpAgentConfig as ConfiguredAcpAgent } from "../config/acp-schema.js";
import type { AcpModelOption } from "./model-config.js";

/**
 * A configured ACP agent plus what the daemon learns about it at spawn time.
 * The configured half is the schema's own inferred type, so a new config leaf
 * is declared once, in `config/acp-schema.ts`.
 */
export interface AcpAgentConfig extends ConfiguredAcpAgent {
  /**
   * Always set on a resolved agent: the resolver fills in a bundled profile's
   * command when the config entry omits it.
   */
  command: string;
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
  /**
   * Model the session is running on, as the adapter reports it. Absent while
   * the adapter advertises no model selector, which is how the feature stays
   * invisible for agents that cannot switch models.
   */
  model?: string;
  /** Models the adapter offers this session, flattened from its selector. */
  availableModels?: AcpModelOption[];
  /** Time-ordered identifier of the assistant process issuing revisions. */
  modelRevisionEpoch?: string;
  /** Monotonic revision within `modelRevisionEpoch`. */
  modelRevision?: number;
}

/**
 * Statuses a session is still live in. One list for every place that asks the
 * question: the boot sweep over persisted rows, the in-memory liveness guard,
 * `close()`, and the delete route's conflict guard.
 */
export const ACP_LIVE_STATUSES = ["running", "initializing"] as const;

/** Whether a status is one a session can still move from. */
export function isLiveAcpStatus(
  status: AcpSessionState["status"],
): status is (typeof ACP_LIVE_STATUSES)[number] {
  return ACP_LIVE_STATUSES.some((live) => live === status);
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

/**
 * The adapter answered `session/set_config_option` with an error: the value
 * was refused. Raised only for the adapter's own answer to that request, so a
 * closed connection, an exited process, or a failed authentication is never
 * mistaken for a refusal.
 */
export class AcpConfigOptionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpConfigOptionRefusedError";
  }
}
