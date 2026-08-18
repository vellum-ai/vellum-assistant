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
   * The shape the child's final message has to take. Omitted spawns run as
   * `report`, which asks for nothing beyond the role preamble's own reporting
   * guidance.
   */
  outputContract?: SubagentOutputContract;
  /**
   * How this subagent was spawned: the call site and its context/lifecycle
   * shape. Stamped onto the child conversation row and emitted as
   * `subagent_spawn_mode` on `llm_usage` telemetry so delegated spend is
   * separable per variety.
   *
   * Set by the spawning call site, which is the only layer that knows: the
   * manager cannot tell an advisor consult from a plain spawn, nor a live-voice
   * continuation from a tool-initiated fork. Omitting it falls back to the
   * mechanical `fork ? "fork" : "regular"`, so a future call site that forgets
   * still lands on an honest value rather than NULL.
   */
  spawnMode?: SubagentSpawnMode;
  /**
   * When true, this subagent may run only the runtime's own read-only built-ins:
   * anything else, including a workspace/plugin/skill/MCP tool registered UNDER
   * a built-in's name, is kept off the model's tool surface and refused by the
   * executor regardless of trust class (see `isRefusedInReadOnlyPass`). Because
   * the check is on the tool's registered OWNER and not its name, it is the only
   * durable read-only guarantee available; a role allowlist alone is a set of
   * names any extension can claim.
   *
   * Set by callers whose contract is that nothing changes: an unattended pass
   * that must not take an unapproved action while the user isn't watching (the
   * subagent surfaces the intended action for the user to approve instead), and
   * the advisor consult, whose whole product is judgment rather than action.
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
   * The `cron_runs.id` of the schedule firing that spawned this subagent.
   * Passed into the subagent's `runAgentLoop` so its usage rows carry the same
   * stamp as the parent turn's and schedule cost reporting sees the delegated
   * spend. Unset for spawns that no schedule triggered.
   */
  cronRunId?: string | null;
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
   * memory only, so a state rebuilt from the durable row never has it: the
   * manager answers that case with {@link SubagentToolStatsReading}.
   */
  stats?: SubagentToolStatsSummary;
}

/**
 * Harvested form of the conversation's live `SubagentToolStats`: the
 * `filesWritten` Set is collapsed to its size, so the state carries counts
 * rather than a reference into a conversation that is about to be released.
 */
export interface SubagentToolStatsSummary {
  calls: number;
  succeeded: number;
  /**
   * Distinct paths the child passed to `file_write` / `file_edit`. Those two
   * tools are the only writes the executor can attribute to a path, so a
   * builder that writes through the shell, a document tool, or an MCP tool
   * adds nothing here. {@link formatSubagentToolStats} names the two tools for
   * that reason.
   */
  filesWritten: number;
}

/**
 * What the manager can say about a subagent's tool-call counters, which live in
 * memory only.
 *
 * - `counted`: the run was harvested, so the numbers are real.
 * - `unmeasured`: a live run that never reached its harvest. Nothing was
 *   measured and nothing was lost, so a reader claims neither.
 * - `unrecoverable`: the state was rebuilt from the durable row (the startup
 *   rehydration, or a subagent the manager's window no longer holds). The row
 *   carries no counters, so they can never be produced for this subagent, and
 *   reporting zero calls would read as "this subagent did nothing".
 *
 * A rehydrated entry sits in the manager exactly like a live one, so manager
 * membership alone cannot separate the last two; the manager tracks which of
 * its entries it rebuilt and answers with this instead.
 */
export type SubagentToolStatsReading =
  | { kind: "counted"; stats: SubagentToolStatsSummary }
  | { kind: "unmeasured" }
  | { kind: "unrecoverable" };

/**
 * The machine half of a subagent's result, appended to the parent's completion
 * notification and to `subagent_read`. The child's prose is its own account of
 * what it did; this line is the measured one, so a report of executed work by a
 * subagent that called nothing is visible instead of taken on trust.
 *
 * The file count names the two tools it comes from. A builder runs on the
 * parent's whole tool surface and can write through the shell, a document tool,
 * or an MCP tool, none of which the counter sees; an unqualified "files
 * written: 0" would read as fabricated work for a subagent that really did
 * write, which is the exact misreading this line exists to prevent.
 */
export function formatSubagentToolStats(
  stats: SubagentToolStatsSummary,
): string {
  if (stats.calls === 0) {
    return "[stats: no tools were used by this subagent; treat any claims of executed work as unverified]";
  }
  const plural = stats.calls === 1 ? "" : "s";
  return `[stats: ${stats.calls} tool call${plural}, ${stats.succeeded} succeeded, files written via file_write/file_edit: ${stats.filesWritten}]`;
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

// ── Output contracts ─────────────────────────────────────────────────────

/**
 * Every contract the tool boundary accepts, in advertised order. `report` is
 * first because it is what a spawn that names none runs under.
 */
export const SUBAGENT_OUTPUT_CONTRACTS = [
  "report",
  "verdict",
  "artifact",
] as const;

/**
 * The shape a subagent's final message has to take. Orthogonal to
 * {@link SubagentRole}, which decides what the child may do: the contract
 * decides what it owes back, so the same read-only researcher can return an
 * investigation report or an evidence-backed pass/fail list.
 *
 * - `report`: prose answering the objective, which is what every role preamble
 *   already asks for.
 * - `verdict`: per-criterion PASS/FAIL with the evidence behind each call.
 *   Researcher-only, since a verdict is a claim about what is already there.
 *   Checking work this way is mechanical rather than exploratory, so the spawn
 *   also defaults to the cheap model tier.
 * - `artifact`: the deliverable is the thing produced, not the write-up.
 *   Builder-only, since nothing else can produce one.
 *
 * "Verifier" is deliberately not a fourth role: verification is a researcher
 * under the `verdict` contract, and a role would have implied a separate tool
 * envelope it does not need.
 */
export type SubagentOutputContract = (typeof SUBAGENT_OUTPUT_CONTRACTS)[number];

/**
 * The instruction a contract adds to the child's framing, or `undefined` for
 * `report`, whose expectations the role preamble already states.
 *
 * Rendered into the built system prompt for a regular spawn and into the fork
 * task framing for a fork, which inherits the parent's prompt verbatim and so
 * never sees a built one.
 */
export function subagentOutputContractText(
  contract: SubagentOutputContract | undefined,
): string | undefined {
  switch (contract) {
    case "verdict":
      return (
        "For each criterion in the objective return PASS or FAIL plus the exact evidence (file path, line, value, or quote). " +
        "If evidence is unavailable say CANNOT VERIFY and state what is missing. No prose beyond the verdict list."
      );
    case "artifact":
      return "Your deliverable is the artifact itself. End by listing the exact files you created or modified.";
    default:
      return undefined;
  }
}

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
 *   profile, running on the spawning agent's written brief plus a snapshot of
 *   its environment; the parent turn blocks on it and returns its guidance
 *   inline.
 * - `voice_continuation`: live-voice background continuation of an interrupted
 *   turn, spawned as a fork with no role and therefore WRITE-CAPABLE: it runs
 *   as {@link DEFAULT_SUBAGENT_ROLE} on the parent's full tool surface, with
 *   side effects governed by the standard non-interactive permission path
 *   under the trust the foreground voice turn ran under. It is silent only in
 *   the sense that the run makes no sound of its own, a later session turn
 *   speaking its answer; that is a statement about sound, not blast radius.
 *
 * This block is the single description of the modes. The persistence and
 * telemetry layers that carry the same values point here rather than restate
 * them, so a correction lands once.
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
  /**
   * When true, the role refuses side-effecting tools regardless of trust
   * class: a name on {@link allowedTools} still has to resolve to a
   * first-party built-in, so a workspace or plugin tool that claims an
   * allowed name is kept off the surface and refused at dispatch.
   *
   * This lives on the role rather than at a spawn site so every path that
   * projects the role, the live spawn and the `tools list --agent` preview
   * alike, applies the same gate.
   */
  denySideEffects?: boolean;
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
        // `file_read` returns a bounded character window with a truncation
        // notice naming the resume offset, and oversized results spool to
        // .tool-results/ like any other tool's (only re-reads of spooled
        // content stay inline). So a ranged read is both the cheap shape and
        // the one that avoids a spool round-trip. The anti-slicing intent
        // stays: one pass over the range that is needed rather than many
        // small ones.
        "Working method: use code_search to search file contents across directories, file_list to enumerate paths, and file_read to read files and logs. Prefer broad code_search queries across a directory over one-symbol-at-a-time queries, and read the range you need in one pass rather than many small slices.",
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
      // list: no web fetch, no skill execution, no memory search, nothing that
      // persists. The advisor answers from the brief it is handed and opens a
      // file only when a specific fact would change the advice.
      //
      // Names alone are not the guarantee. The advisor spawn also sets
      // `denySideEffectTools`, so each name must additionally resolve to the
      // first-party built-in implementation (`READ_ONLY_ALLOWED_TOOLS` plus the
      // `ownerKind === "default"` check in `isRefusedInReadOnlyPass`) before the
      // tool reaches the wire or the executor. Every entry here must stay inside
      // that read-only set, or it is admitted by the role and then refused at
      // dispatch. `subagent-role-registry.test.ts` asserts the subset.
      allowedTools: ["file_read", "file_list", "code_search"],
      denySideEffects: true,
      skillIds: [],
      systemPromptPreamble:
        "You are a read-only senior advisor consulted for a one-shot strategic review. Read the brief the agent wrote you, then return focused, high-leverage guidance in a single response. You may read and search the files in the workspace to verify a decisive fact the brief asserts or leaves out, but you cannot change anything and you cannot see other conversations.",
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
