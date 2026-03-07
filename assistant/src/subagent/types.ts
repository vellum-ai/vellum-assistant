/**
 * Subagent domain types.
 *
 * A subagent is a child Session spawned by a parent Session's LLM via the
 * `subagent_spawn` tool.  It runs an independent AgentLoop and streams events
 * back to the parent's client socket wrapped in `subagent_event` envelopes.
 */

import type { UsageStats } from "../daemon/ipc-protocol.js";

// ── Status ──────────────────────────────────────────────────────────────

export type SubagentStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "aborted";

/** Terminal states — once entered, a subagent cannot transition out. */
export const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> =
  new Set<SubagentStatus>(["completed", "failed", "aborted"]);

// ── Config (spawn-time) ─────────────────────────────────────────────────

export interface SubagentConfig {
  /** Unique subagent identifier (UUID). */
  id: string;
  /** The parent Session's conversationId. */
  parentSessionId: string;
  /** Human-readable label (e.g. "Research competitor pricing"). */
  label: string;
  /** The task objective for this subagent. */
  objective: string;
  /** Optional extra context passed from the parent (recent messages, files, etc.). */
  context?: string;
  /** Optional system prompt override. Falls back to a default subagent prompt. */
  systemPromptOverride?: string;
  /** Optional skill IDs to pre-activate on the subagent session. */
  preactivatedSkillIds?: string[];
  /** Whether the parent should present the result to the user. Defaults to true. */
  sendResultToUser?: boolean;
}

// ── State (runtime) ─────────────────────────────────────────────────────

export interface SubagentState {
  config: SubagentConfig;
  status: SubagentStatus;
  /** The subagent's own conversationId (different from parentSessionId). */
  conversationId: string;
  /** Error message if status is 'failed'. */
  error?: string;
  /** Timestamps (epoch ms). */
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Cumulative token usage. */
  usage: UsageStats;
}

// ── Limits ───────────────────────────────────────────────────────────────

export const SUBAGENT_LIMITS = {
  /** Max nesting depth (1 = no nested subagents). */
  maxDepth: 1,
} as const;
