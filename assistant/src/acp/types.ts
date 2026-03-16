/**
 * ACP (Agent Client Protocol) types for agent session management and configuration.
 */

// Import StopReason for use in AcpSessionState
import type { StopReason } from "@agentclientprotocol/sdk";

// Re-export relevant types from the ACP SDK for convenience
export type {
  AgentCapabilities,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionId,
  SessionInfo,
  SessionNotification,
  SessionUpdate,
  StopReason,
  ToolCall,
  ToolCallContent,
  ToolCallId,
  ToolCallStatus,
} from "@agentclientprotocol/sdk";
export {
  AgentSideConnection,
  ClientSideConnection,
} from "@agentclientprotocol/sdk";

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
 * Top-level ACP configuration.
 */
export interface AcpConfig {
  enabled: boolean;
  maxConcurrentSessions: number;
  agents: Record<string, AcpAgentConfig>;
}

/**
 * Runtime state of an ACP session.
 */
export interface AcpSessionState {
  id: string;
  agentId: string;
  acpSessionId: string;
  status: "initializing" | "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  completedAt?: number;
  error?: string;
  stopReason?: StopReason;
}

/**
 * Classification of a tool call's operation kind.
 */
export type ToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";
