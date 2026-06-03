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
  /**
   * Session lifecycle status.
   *
   * - `initializing` / `running`: a prompt is in flight.
   * - `idle`: the previous prompt finished and the process is still alive,
   *   ready to accept a follow-up prompt (multi-turn continuity). A terminal
   *   `acp_session_history` row already reflects the completed task; the live
   *   session lingers until reused, idle-timed-out, or explicitly closed.
   * - `completed` / `failed` / `cancelled`: terminal — the process is gone.
   */
  status:
    | "initializing"
    | "running"
    | "idle"
    | "completed"
    | "failed"
    | "cancelled";
  startedAt: number;
  completedAt?: number;
  error?: string;
  stopReason?: StopReason;
}
