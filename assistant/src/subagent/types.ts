/**
 * Subagent domain types.
 *
 * A subagent is a child Conversation spawned by a parent Conversation's LLM via the
 * `subagent_spawn` tool.  It runs an independent AgentLoop and streams events
 * back to the parent's client socket wrapped in `subagent_event` envelopes.
 */

import type { UsageStats } from "../daemon/message-protocol.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import type { Message } from "../providers/types.js";

// ── Status ──────────────────────────────────────────────────────────────

export type SubagentStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "aborted"
  // Assigned on daemon restart to a subagent that was still in flight when the
  // process died. Terminal — the run is not auto-resumed; the parent is left to
  // decide whether to re-spawn.
  | "interrupted";

/** Terminal states — once entered, a subagent cannot transition out. */
export const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> =
  new Set<SubagentStatus>(["completed", "failed", "aborted", "interrupted"]);

/**
 * The status to report for a subagent with no live instance.
 *
 * Invariant: a subagent runs from an in-memory entry, so a durable row without
 * one can only describe a run that is no longer executing. Whatever the row
 * says, nothing is driving it, so a stale `pending`/`running`/`awaiting_input`
 * reads as `interrupted`. A terminal status is the run's real outcome and
 * passes through untouched.
 *
 * For the routes this closes a startup window rather than a steady state:
 * `setDbReady(true)` precedes `rehydrateFromDb()` in `daemon/lifecycle.ts`, so
 * a request can pass the DB gate while the manager is still empty and read rows
 * the rehydration has not yet normalized. Without the coercion a client
 * reconciling on its SSE reopen adopts `running`, and the later rehydration
 * flips the row to `interrupted` with no status event to say so, leaving the UI
 * stuck.
 *
 * Only ever applied to record-derived statuses. Live state is authoritative and
 * never coerced.
 */
export function settleUnsupervisedStatus(
  status: SubagentStatus,
): SubagentStatus {
  return TERMINAL_STATUSES.has(status) ? status : "interrupted";
}

// ── Label lookup ────────────────────────────────────────────────────────

/**
 * The comparable form of a subagent label. Labels are addressed by the model,
 * so lookups are case- and whitespace-insensitive; every label comparison, in
 * memory or against the durable table, goes through this.
 */
export function normalizeSubagentLabel(label: string): string {
  return label.toLowerCase().trim();
}

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
  /**
   * Optional full model request sent as the subagent's first user message in
   * place of `objective`. Display surfaces (lifecycle events, persisted
   * records, the detail panel) keep showing the concise `objective`; use this
   * when the model request carries bulky internal context that must not leak
   * into those surfaces (e.g. the advisor's situational context pack).
   */
  requestText?: string;
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
  /**
   * When true, side-effecting tools (send/write/delete/purchase, host commands)
   * are refused for this subagent regardless of trust class — the executor
   * rejects any such dispatch and the tool is kept off the model's tool surface.
   * For unattended passes that must never take an unapproved action while the
   * user isn't watching; the subagent surfaces the intended action for the
   * user to approve instead.
   */
  denySideEffectTools?: boolean;
  /**
   * Explicit trust context for the subagent. When set, it wins over the
   * default inheritance from the parent conversation's live `trustContext`.
   * For spawners whose parent stamps trust per-turn and clears it at teardown
   * (the live-voice bridge), inheritance reads the cleared window and the
   * child would run fail-closed as `unknown`; the caller resolves trust
   * itself and passes it here instead.
   */
  trustContext?: TrustContext;
  /**
   * When true, the sub-agent inherits the parent's full context instead of
   * receiving only the objective + context fields.
   */
  fork?: boolean;
  /**
   * The parent conversation's in-memory message history at fork time.
   * Only set when `fork: true`.
   */
  parentMessages?: Message[];
  /**
   * The parent's current resolved system prompt. Only set when `fork: true`.
   * Distinct from `systemPromptOverride` which replaces the subagent-built prompt;
   * for forks, this IS the system prompt (no subagent preamble is built).
   */
  parentSystemPrompt?: string;
  /**
   * Optional ad-hoc inference-profile override the parent inherits down to this
   * subagent. When set, every LLM call the subagent issues carries
   * `SendMessageOptions.config.overrideProfile = <name>` so the resolver layers
   * `llm.profiles[<name>]` between the workspace's `activeProfile` and the
   * call-site's named profile. If a parent conversation is pinned to a
   * profile, every spawned subagent inherits it automatically.
   */
  overrideProfile?: string;
  /**
   * When true, the subagent's `overrideProfile` is an explicit spawn-time
   * request and must float above call-site layers. Inherited parent profiles
   * leave this unset so existing call-site precedence stays intact.
   */
  forceOverrideProfile?: boolean;
  /**
   * Tool-use id of the `skill_execute` call that spawned this subagent.
   * Forwarded into the `subagent_spawned` event so the client can anchor the
   * inline subagent card to the exact spawn tool call.
   */
  parentToolUseId?: string;
}

// ── State (runtime) ─────────────────────────────────────────────────────

export interface SubagentState {
  config: SubagentConfig;
  status: SubagentStatus;
  /** The subagent's own conversationId (different from parentConversationId). */
  conversationId: string;
  /** Whether this sub-agent is a fork (inherits parent context). Defaults to `false`. */
  isFork: boolean;
  /** Error message if status is 'failed'. */
  error?: string;
  /** Timestamps (epoch ms). */
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Cumulative token usage. */
  usage: UsageStats;
}

// ── Bounded listing ─────────────────────────────────────────────────────

/** Recency key matching the durable query's `COALESCE(completed_at, created_at)`. */
function settledAt(child: SubagentState): number {
  return child.completedAt ?? child.createdAt;
}

/**
 * Every non-terminal child, plus the `maxTerminal` most recently settled
 * terminal ones. `rehydrateFromDb` seeds memory with a much larger cap, so a
 * caller listing children has to re-bound what it actually ships.
 */
export function boundRecentTerminal(
  children: SubagentState[],
  maxTerminal: number,
): SubagentState[] {
  const bounded: SubagentState[] = [];
  const terminal: SubagentState[] = [];
  for (const child of children) {
    if (TERMINAL_STATUSES.has(child.status)) {
      terminal.push(child);
    } else {
      bounded.push(child);
    }
  }
  terminal.sort((a, b) => settledAt(b) - settledAt(a));
  bounded.push(...terminal.slice(0, maxTerminal));
  return bounded;
}

// ── Limits ───────────────────────────────────────────────────────────────

export const SUBAGENT_LIMITS = {
  /** Max nesting depth (1 = no nested subagents). */
  maxDepth: 1,
} as const;

// ── Roles ───────────────────────────────────────────────────────────────

export type SubagentRole =
  | "general"
  | "researcher"
  | "coder"
  | "planner"
  | "investigator"
  | "advisor";

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
      skillIds: [],
      systemPromptPreamble:
        "You are a general-purpose subagent. Complete the delegated task thoroughly and concisely.",
    },
    researcher: {
      allowedTools: [
        "web_search",
        "web_fetch",
        "file_read",
        "file_list",
        "recall",
        "notify_parent",
      ],
      skillIds: [],
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
        "recall",
        "notify_parent",
      ],
      skillIds: [],
      systemPromptPreamble:
        "You are a code-focused subagent with file and shell access. Read, write, and edit files, and run shell commands.",
    },
    planner: {
      allowedTools: [
        "file_read",
        "file_list",
        "web_search",
        "web_fetch",
        "recall",
        "notify_parent",
      ],
      skillIds: [],
      systemPromptPreamble:
        "You are an analysis-focused subagent with read-only access. Read files, search the web, and synthesize findings. You cannot write files or run shell commands.",
    },
    investigator: {
      allowedTools: [
        "code_search",
        "file_read",
        "file_list",
        "web_search",
        "web_fetch",
        "recall",
        "notify_parent",
      ],
      skillIds: [],
      systemPromptPreamble: [
        "You are an investigation-focused subagent for root-cause analysis: debugging, log forensics, and tracing behavior across code.",
        "You have read-only investigation tools only — there is no shell. Use code_search to search file contents across directories, file_list to enumerate paths, and file_read to read whole files and logs. You cannot modify files or system state.",
        "Working method: read whole files instead of many small line-range slices; prefer broad code_search queries across a directory over one-symbol-at-a-time queries.",
        "Send notify_parent (urgency 'important') as soon as each finding is confirmed, so progress survives interruption.",
        "Your final message must be a compact root-cause report with these sections: Symptom, Root cause, Evidence (file:line references), Suggested fix, Open questions.",
        "If you approach context limits, stop investigating and produce the report from what you have — a partial report delivered is worth more than a complete investigation lost.",
      ].join(" "),
    },
    advisor: {
      allowedTools: [],
      skillIds: [],
      systemPromptPreamble:
        "You are a read-only senior advisor consulted for a one-shot strategic review. Read the inherited conversation, then return focused, high-leverage guidance in a single response. You have no tools — you cannot search, read files, or run commands — so reason from the context you were given.",
    },
  };
