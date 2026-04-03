/**
 * Subagent domain types.
 *
 * A subagent is a child Conversation spawned by a parent Conversation's LLM via the
 * `subagent_spawn` tool.  It runs an independent AgentLoop and streams events
 * back to the parent's client socket wrapped in `subagent_event` envelopes.
 */

import type { UsageStats } from "../daemon/message-protocol.js";

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
  /** The parent Conversation's conversationId. */
  parentConversationId: string;
  /** Human-readable label (e.g. "Research competitor pricing"). */
  label: string;
  /** The task objective for this subagent. */
  objective: string;
  /** Optional extra context passed from the parent (recent messages, files, etc.). */
  context?: string;
  /** Optional system prompt override. Falls back to a default subagent prompt. */
  systemPromptOverride?: string;
  /** Optional skill IDs to pre-activate on the subagent conversation. */
  preactivatedSkillIds?: string[];
  /** Whether the parent should present the result to the user. Defaults to true. */
  sendResultToUser?: boolean;
  /** Optional role for the subagent. Defaults handled by consumers. */
  role?: SubagentRole;
}

// ── State (runtime) ─────────────────────────────────────────────────────

export interface SubagentState {
  config: SubagentConfig;
  status: SubagentStatus;
  /** The subagent's own conversationId (different from parentConversationId). */
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

// ── Roles ───────────────────────────────────────────────────────────────

export type SubagentRole = "general" | "researcher" | "coder" | "planner";

export interface SubagentRoleConfig {
  /**
   * When defined, only these tools are visible to the subagent.
   * `undefined` means no filter (all tools available).
   */
  allowedTools?: string[];
  /** Skill IDs to pre-activate on the subagent conversation. */
  skillIds: string[];
  /** Role-specific text prepended to the subagent system prompt. */
  systemPromptPreamble: string;
}

export const SUBAGENT_ROLE_REGISTRY: Record<SubagentRole, SubagentRoleConfig> =
  {
    general: {
      allowedTools: undefined,
      skillIds: ["subagent"],
      systemPromptPreamble:
        "You are a general-purpose subagent. Complete the delegated task thoroughly and concisely.",
    },
    researcher: {
      allowedTools: [
        "web_search",
        "web_fetch",
        "file_read",
        "memory_recall",
        "notify_parent",
      ],
      skillIds: ["subagent"],
      systemPromptPreamble:
        "You are a research-focused subagent with read-only access. Search the web, read files, and recall memories. You cannot write files or run shell commands.",
    },
    coder: {
      allowedTools: [
        "bash",
        "file_read",
        "file_write",
        "file_edit",
        "web_search",
        "notify_parent",
      ],
      skillIds: ["subagent"],
      systemPromptPreamble:
        "You are a code-focused subagent with file and shell access. Read, write, and edit files, and run shell commands.",
    },
    planner: {
      allowedTools: [
        "file_read",
        "web_search",
        "web_fetch",
        "memory_recall",
        "notify_parent",
      ],
      skillIds: ["subagent"],
      systemPromptPreamble:
        "You are an analysis-focused subagent with read-only access. Read files, search the web, and synthesize findings. You cannot write files or run shell commands.",
    },
  };
