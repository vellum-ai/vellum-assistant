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
  /** The subagent's type. Omitted spawns run as {@link DEFAULT_SUBAGENT_ROLE}. */
  role?: SubagentRole;
  /**
   * Free-text framing rendered as a persona line under the role preamble, for
   * a spawn whose requested role names a character rather than a type ("staff
   * security engineer", "financial journalist"). The role still decides what
   * the child may do; the persona only decides how it reads the task.
   */
  persona?: string;
  /**
   * How this subagent was spawned: the call site and its context/lifecycle
   * shape. Stamped onto the child conversation row and emitted as
   * `subagent_spawn_mode` on `llm_usage` telemetry so delegated spend is
   * separable per variety.
   *
   * Set by the spawning call site, which is the only layer that knows: the
   * manager cannot tell an advisor consult from a plain fork, nor a live-voice
   * continuation from a tool-initiated one. Omitting it falls back to the
   * mechanical `fork ? "fork" : "regular"`, so a future call site that forgets
   * still lands on an honest value rather than NULL.
   */
  spawnMode?: SubagentSpawnMode;
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
  /**
   * What the subagent actually ran, harvested from the child conversation when
   * the run ends and re-read while that conversation is still retained (a
   * follow-up turn queued during the run drains after the run returns). In
   * memory only: see {@link rehydrated}.
   */
  stats?: SubagentToolStatsSummary;
  /**
   * True when this state was rebuilt from the subagent's durable row rather
   * than from a run this process executed: the startup rehydration, or the
   * tools' fallback for a subagent the manager's window no longer holds.
   *
   * The row carries no tool-call counters, so {@link stats} can never be
   * filled in for one of these. Readers key the "unavailable" stats footer on
   * this flag: a rehydrated entry sits in the manager exactly like a live one,
   * so manager membership alone cannot tell the two apart.
   */
  rehydrated?: boolean;
}

/**
 * Harvested form of the conversation's live `SubagentToolStats`: the
 * `filesWritten` Set is collapsed to its size, so the state carries counts
 * rather than a reference into a conversation that is about to be released.
 */
export interface SubagentToolStatsSummary {
  calls: number;
  succeeded: number;
  filesWritten: number;
}

/**
 * The machine half of a subagent's result, appended to the parent's completion
 * notification and to `subagent_read`. The child's prose is its own account of
 * what it did; this line is the measured one, so a report of executed work by a
 * subagent that called nothing is visible instead of taken on trust.
 */
export function formatSubagentToolStats(
  stats: SubagentToolStatsSummary,
): string {
  if (stats.calls === 0) {
    return "[stats: no tools were used by this subagent; treat any claims of executed work as unverified]";
  }
  const plural = stats.calls === 1 ? "" : "s";
  return `[stats: ${stats.calls} tool call${plural}, ${stats.succeeded} succeeded, files written: ${stats.filesWritten}]`;
}

/** Stats footer for a subagent whose in-memory counters no longer exist. */
export const SUBAGENT_STATS_UNAVAILABLE =
  "[stats: unavailable (tool counters are not retained for this subagent)]";

/**
 * Appended to a read taken while the subagent is still working through
 * guidance queued during its run. Its own run is over by then, which is what
 * makes it terminal, but the queued turn adds output and tool calls after
 * that, so such a read is a progress report rather than the final one.
 */
export const SUBAGENT_READ_STILL_PROCESSING =
  "[note: this subagent is still processing queued follow-up guidance. The output above and the counts below stop at its last finished turn; read again for the rest.]";

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

/**
 * What a subagent is, derived from two questions: can it change things, and
 * does the parent wait for it.
 *
 * - `researcher`: read-only, runs in the background, scoped to a fixed
 *   allowlist.
 * - `builder`: write-capable, runs in the background, on the parent's whole
 *   tool surface.
 * - `advisor`: read-only, the parent turn blocks on its guidance.
 *
 * Write-plus-blocking is deliberately absent: a parent that waits on a change
 * has no reason to delegate it. Model tier is a separate knob
 * (`inference_profile`), and a persona is free text
 * (`SubagentConfig.persona`), so neither is a type.
 *
 * The legacy names (`general`, `coder`, `planner`, `investigator`) remain
 * accepted at the tool boundary as aliases; see ./role-resolution.ts.
 */
export type SubagentRole = "researcher" | "builder" | "advisor";

// ── Spawn modes ──────────────────────────────────────────────────────────

/**
 * How a subagent was spawned. Orthogonal to {@link SubagentRole}: the role
 * selects the tool allowlist and system-prompt preamble (what the child may
 * do), the spawn mode selects context inheritance and lifecycle (how many
 * input tokens the child starts with, and whether the parent blocks on it).
 * A fork's inherited parent transcript is the dominant input-token driver and
 * is independent of which role ran, which is why neither field subsumes the
 * other.
 *
 * - `regular`: fire-and-forget `subagent_spawn`, fresh objective-only context.
 * - `fork`: `subagent_spawn` with `fork: true`, inherits the parent transcript.
 * - `advisor_consult`: synchronous, read-only advisor consult on the advisor
 *   profile; the parent turn blocks on it and returns its guidance inline.
 * - `voice_continuation`: silent, read-only live-voice background
 *   continuation of an interrupted turn.
 *
 * Mirrored on the wire as `llm_usage.subagent_spawn_mode`, which is an OPEN
 * string set on the platform side: adding a value here needs no coordinated
 * platform release.
 */
export type SubagentSpawnMode =
  | "regular"
  | "fork"
  | "advisor_consult"
  | "voice_continuation";

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
    researcher: {
      allowedTools: [
        "web_search",
        "web_fetch",
        "file_read",
        "file_list",
        "code_search",
        "recall",
        "skill_execute",
        "notify_parent",
      ],
      skillIds: [],
      systemPromptPreamble: [
        "You are a research subagent with read-only access: search the web, read and search files, and recall memories. There is no shell, and you cannot write or edit files.",
        "Working method: use code_search to search file contents across directories, file_list to enumerate paths, and file_read to read whole files and logs. Read whole files instead of many small line-range slices, and prefer broad code_search queries across a directory over one-symbol-at-a-time queries.",
        "Send notify_parent (urgency 'important') as soon as each finding is confirmed, so progress survives interruption.",
        "Your final message is the deliverable: a compact report that answers the objective, gives the evidence behind each claim (file:line references, URLs, or quotes), and names what you could not determine. For a root-cause investigation, use the sections Symptom, Root cause, Evidence, Suggested fix, Open questions.",
        "If you approach context limits, stop investigating and write the report from what you have. A partial report delivered is worth more than a complete investigation lost.",
      ].join(" "),
    },
    builder: {
      // No allowlist: a builder projects the same tool surface its parent
      // conversation does, connectors, MCP tools, browser and computer use
      // included. A fixed list would be a ceiling on what "can change things"
      // means, and the tools a build task needs are not enumerable in advance:
      // the work that has to file the ticket, send the message, or drive the
      // browser is exactly the work a parent delegates.
      skillIds: [],
      systemPromptPreamble: [
        "You are a build subagent with the parent's full tool surface: read, write, and edit files, run shell commands, search code, search the web, and use any other tool the parent conversation can reach.",
        "Carry the task through end to end, then verify it yourself with the command that proves it (a build, a test run, a re-read of what you wrote) before reporting.",
        "Send notify_parent (urgency 'important') when a milestone lands or a decision only the parent can make blocks you.",
        "Your final message must state what you changed, the exact files you touched, and the result of the verification you ran.",
      ].join(" "),
    },
    advisor: {
      // Read-only fact checking, deliberately narrower than the researcher's
      // list: no web fetch, no skill execution, nothing that persists. The
      // advisor answers from the inherited conversation and opens a file only
      // when a specific fact would change the advice. `recall` keeps its own
      // trust gating at the tool layer.
      allowedTools: ["file_read", "file_list", "code_search", "recall"],
      skillIds: [],
      systemPromptPreamble:
        "You are a read-only senior advisor consulted for a one-shot strategic review. Read the inherited conversation, then return focused, high-leverage guidance in a single response. You may read files, search code, and recall memories to verify a decisive fact, but you cannot change anything.",
    },
  };

/**
 * The type a spawn that names no role runs as. `builder` imposes no tool
 * allowlist, so a caller that omits the field keeps the full surface its
 * conversation projects: the internal context-inheriting callers (the
 * live-voice continuation) continue the parent's turn with the tools that turn
 * had, and a delegated task whose shape was never stated can still write.
 */
export const DEFAULT_SUBAGENT_ROLE: SubagentRole = "builder";
