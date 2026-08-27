/**
 * SubagentManager — owns the lifecycle of all subagent conversations.
 *
 * Responsibilities:
 *   - spawn / abort / dispose subagent conversations
 *   - enforce concurrency and depth limits
 *   - route events from child conversations through parent's socket
 *   - inject completion summaries back into parent context
 */

import { v4 as uuid } from "uuid";

import type { AssistantEvent } from "../api/index.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { Conversation } from "../daemon/conversation.js";
import {
  findConversation,
  removeSubagentConversation,
  setSubagentConversation,
} from "../daemon/conversation-registry.js";
import { bootstrapConversation } from "../persistence/conversation-bootstrap.js";
import {
  deleteAllSubagentRecords,
  deleteSubagentRecordsByParent,
  loadRehydratableSubagentRecords,
  type SubagentRecord,
  upsertSubagentRecord,
} from "../persistence/subagent-store.js";
import { wrapWithCallSiteRouting } from "../providers/call-site-routing.js";
import {
  mainAgentResolutionError,
  resolveDefaultProvider,
} from "../providers/connection-resolution.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import { listProviders } from "../providers/registry.js";
import type { Message, TextContent } from "../providers/types.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import { sleep } from "../util/retry.js";
import { injectMessageIntoParent } from "./notify.js";
import { isSubagentProgressEvent } from "./progress-events.js";
import {
  DEFAULT_SUBAGENT_ROLE,
  formatSubagentToolStats,
  normalizeSubagentLabel,
  settleUnsupervisedStatus,
  SUBAGENT_LIMITS,
  SUBAGENT_ROLE_REGISTRY,
  type SubagentConfig,
  subagentOutputContractText,
  type SubagentRole,
  type SubagentSpawnMode,
  type SubagentState,
  type SubagentStatus,
  type SubagentToolStatsReading,
  type SubagentToolStatsSummary,
  TERMINAL_STATUSES,
} from "./types.js";

const log = getLogger("subagent-manager");

/** How long to keep terminal subagent metadata after the live conversation is released (ms). */
const TERMINAL_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
/** How often to sweep expired terminal entries (ms). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
/**
 * Cap on the terminal subagents a restart rebuilds in memory. Rows live as long
 * as their parent conversation, so the table is unbounded history, while a
 * rehydrated terminal entry only serves the in-process subagent tools for the
 * current session. Both route surfaces read the durable table directly and
 * carry their own bounds, so this one is invisible to them. Subagents that are
 * not terminal are never capped: an unsettled row has to be settled to
 * `interrupted` at any age.
 */
const MAX_REHYDRATED_TERMINAL_RECORDS = 200;

/**
 * How long {@link SubagentManager.settleQueuedTurns} waits for a queued
 * follow-up turn before reporting the subagent as still moving.
 *
 * Sized for the drain handoff, not for the turn itself: the queue is taken
 * some milliseconds before the processing lock, and a wait shorter than that
 * gap would mistake a turn that is starting for one that already finished. A
 * guidance turn that is genuinely mid-flight outlives any budget worth
 * blocking the parent's tool call for, so it is reported as unfinished instead
 * of waited out.
 */
const QUEUED_TURN_SETTLE_TIMEOUT_MS = 2_000;
/** Gap between queue observations while a queued turn is waiting to start. */
const QUEUED_TURN_POLL_MS = 25;

// ── Durable record → state mapping ─────────────────────────────────────

/**
 * The in-memory view of a durable subagent record. Shared by the startup
 * rehydration and by the subagent tools' fallback for a record the manager
 * does not hold, so the two cannot drift.
 *
 * The recorded status maps through verbatim. What an active status means for a
 * subagent nothing is executing is a separate decision, made by
 * {@link settleUnsupervisedStatus} at the call site. The spawn-time
 * `SubagentConfig` fields that are not persisted (context, prompts, trust,
 * profile overrides) are absent, so this shape answers lifecycle questions
 * only.
 *
 * Tool-call counters are in-memory only and the row carries none, so a state
 * built here never has {@link SubagentState.stats}. What that absence means is
 * the manager's answer to give, not this shape's: see
 * {@link SubagentManager.currentToolStats}.
 */
export function subagentStateFromRecord(rec: SubagentRecord): SubagentState {
  return {
    config: {
      id: rec.id,
      parentConversationId: rec.parentConversationId,
      label: rec.label,
      objective: rec.objective,
      role: rec.role as SubagentRole,
      fork: rec.isFork,
      ...(rec.sendResultToUser != null
        ? { sendResultToUser: rec.sendResultToUser }
        : {}),
      ...(rec.parentToolUseId != null
        ? { parentToolUseId: rec.parentToolUseId }
        : {}),
    },
    status: rec.status as SubagentStatus,
    conversationId: rec.conversationId,
    isFork: rec.isFork,
    ...(rec.error != null ? { error: rec.error } : {}),
    createdAt: rec.createdAt,
    ...(rec.startedAt != null ? { startedAt: rec.startedAt } : {}),
    ...(rec.completedAt != null ? { completedAt: rec.completedAt } : {}),
    usage: {
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      estimatedCost: rec.estimatedCost,
    },
  };
}

// ── Spawn ordering ─────────────────────────────────────────────────────

/** Total order on spawns: recorded spawn time, then the row's insertion order. */
interface SpawnKey {
  createdAt: number;
  spawnSeq: number;
}

/**
 * Whether `a` was spawned after `b`. `created_at` is millisecond-resolution, so
 * two subagents spawned in the same tick compare equal on it; `spawnSeq` (the
 * row's `rowid`) then decides, giving the same last-spawn-wins answer the live
 * label index gives.
 */
function isLaterSpawn(a: SpawnKey, b: SpawnKey): boolean {
  return a.createdAt === b.createdAt
    ? a.spawnSeq > b.spawnSeq
    : a.createdAt > b.createdAt;
}

// ── Skill ID merge helper ──────────────────────────────────────────────

/**
 * Merge role-defined skill IDs with caller-provided skill IDs, deduplicating.
 * Exported for direct unit testing.
 */
export function mergeSkillIds(
  roleSkillIds: string[],
  configSkillIds?: string[],
): string[] {
  return [...new Set([...roleSkillIds, ...(configSkillIds ?? [])])];
}

// ── Final-text extraction helper ────────────────────────────────────────

/**
 * Concatenate the `text` blocks of the conversation's trailing assistant
 * message. Used by `spawnAndAwait` to return the child's final synthesis to
 * the awaiting caller. Returns an empty string when the conversation has no
 * assistant message or the final assistant message carries no text blocks
 * (e.g. it ended on a tool_use).
 */
function extractFinalAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") {
      continue;
    }
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
  return "";
}

/**
 * Snapshot the child conversation's live tool-call counters before the
 * conversation is released. The `filesWritten` Set collapses to its size so
 * nothing keeps a reference into the released conversation.
 */
function snapshotToolStats(
  conversation: Conversation,
): SubagentToolStatsSummary {
  const { calls, succeeded, filesWritten } = conversation.subagentToolStats;
  return { calls, succeeded, filesWritten: filesWritten.size };
}

/**
 * Pull the user-visible text out of a streaming delta event, or null for any
 * other event type. Used by the synchronous `onText` tap to forward
 * `assistant_text_delta` / `assistant_thinking_delta` chunks to the caller.
 */
function extractDeltaText(msg: AssistantEvent): string | null {
  if (msg.type === "assistant_text_delta") {
    return msg.text;
  }
  if (msg.type === "assistant_thinking_delta") {
    return msg.thinking;
  }
  return null;
}

// ── Default subagent system prompt ──────────────────────────────────────

export function buildSubagentSystemPrompt(
  config: SubagentConfig,
  role: SubagentRole,
): string {
  const roleConfig = SUBAGENT_ROLE_REGISTRY[role];
  const sections: string[] = [roleConfig.systemPromptPreamble];
  if (config.persona) {
    sections.push(`- Persona: act as ${config.persona} for this task.`);
  }
  const contractText = subagentOutputContractText(config.outputContract);
  if (contractText) {
    sections.push(`- Output contract: ${contractText}`);
  }
  sections.push("", "## Your Task", config.objective);
  if (config.context) {
    sections.push("", "## Context from Parent", config.context);
  }
  sections.push(
    "",
    "## Constraints",
    `- Role: ${role}`,
    "- You cannot spawn nested subagents.",
    "- Use notify_parent to report important findings, or if you are blocked.",
    '- If the objective needs a capability your role\'s tools do not provide (for example, writing or editing a file, or running a command, with a read-only role), do NOT fabricate a completed result — call notify_parent with urgency "blocked", name the capability you lack (e.g. file_write), and stop.',
    "- If a tool call fails, or a tool you expected is unavailable, report the failure verbatim and stop that line of work. Never simulate, reconstruct, or invent tool output you did not actually receive.",
  );
  return sections.join("\n");
}

/**
 * Build the message injected into the parent conversation when a subagent
 * reaches a terminal state.
 *
 * For a completed subagent the final synthesis is inlined directly, so the
 * parent acts on the result without a `subagent_read` round-trip and has
 * nothing left to re-spawn. The `subagent_read` pointer survives only as a
 * fallback for the rare run that ends with no trailing assistant text.
 *
 * Exported for unit testing.
 */
export function buildSubagentTerminalMessage(opts: {
  label: string;
  subagentId: string;
  isFork: boolean;
  outcome: "completed" | "failed";
  silent: boolean;
  finalText?: string;
  error?: string;
  /** A follow-up turn is still queued, so the current synthesis is a snapshot. */
  deferred?: boolean;
  /** Tools the subagent attempted but that its role allowlist denied. */
  deniedTools?: string[];
  /** What the subagent actually ran, harvested when the run ended. */
  stats?: SubagentToolStatsSummary;
}): string {
  const {
    label,
    subagentId,
    isFork,
    outcome,
    silent,
    finalText,
    error,
    deferred,
    deniedTools,
    stats,
  } = opts;
  const prefix = isFork ? "Fork" : "Subagent";

  // When the subagent reached for tools its role does not permit, tell the
  // parent so it re-spawns with a capable role instead of blindly retrying (a
  // read-only role produces nothing). Only attached to completed outcomes.
  const many = (deniedTools?.length ?? 0) > 1;
  const deniedNote =
    deniedTools && deniedTools.length > 0
      ? `\n\nNote: this ${prefix.toLowerCase()} attempted ${deniedTools.join(", ")} but its role does not permit ${many ? "them" : "it"}. If the objective requires ${many ? "those" : "that"}, re-spawn with a role that includes ${many ? "them" : "it"} (e.g. \`builder\`).`
      : "";

  // Machine truth envelope: the counts the parent can check the synthesis
  // above against. Absent when the run never reached the harvest, and on the
  // deferred path, where the counters are still moving (see the caller).
  const statsNote = stats ? `\n\n${formatSubagentToolStats(stats)}` : "";

  if (outcome === "failed") {
    return (
      `[${prefix} "${label}" failed]\n\n` +
      `Error: ${error ?? "Unknown error"}\n` +
      `Do NOT re-spawn or retry this ${prefix.toLowerCase()} unless the user explicitly asks.`
    );
  }

  const trimmed = finalText?.trim() ?? "";
  if (trimmed && !deferred) {
    return (
      `[${prefix} "${label}" completed — result below]\n\n` +
      `${trimmed}\n\n` +
      (silent
        ? `(Use these findings internally; do not relay the raw ${prefix.toLowerCase()} output to the user.)`
        : `(Incorporate this into your reply to the user as appropriate.)`) +
      deniedNote +
      statsNote
    );
  }

  // Read-pointer path: either the run left no trailing assistant text to inline,
  // or a queued follow-up turn is still draining — so the current synthesis is a
  // stale snapshot and the parent should read the latest output instead.
  const lastN = isFork ? " and last_n: 1" : "";
  const reason = deferred
    ? `Queued follow-up guidance is still being processed`
    : `The ${prefix.toLowerCase()} produced no final text`;
  return (
    `[${prefix} "${label}" completed]\n\n` +
    `${reason}. Use subagent_read with subagent_id "${subagentId}"${lastN} for the latest output.` +
    (silent ? ` Keep the result internal.` : ``) +
    deniedNote +
    statsNote
  );
}

// ── Manager ─────────────────────────────────────────────────────────────

interface ManagedSubagent {
  /** Live conversation — null after the subagent reaches a terminal state and is released. */
  conversation: Conversation | null;
  state: SubagentState;
  /** Mutable reference to the parent's current sendToClient. Updated on reconnect. */
  parentSendToClient: (msg: AssistantEvent) => void;
  /** Epoch ms after which this terminal entry can be removed by the TTL sweep. */
  retainedUntil?: number;
  /**
   * True for an entry the startup rehydration rebuilt from a durable row
   * rather than a run this process executed. Such an entry sits in the manager
   * exactly like a live one but can never have tool-call counters, so
   * {@link SubagentManager.currentToolStats} reads this to tell "never
   * measured here" apart from "not measured yet".
   */
  rehydrated?: boolean;
  /**
   * Sticky monotonic flag: set to true when sendMessage enqueues a follow-up
   * message while a run is in progress, and never cleared. Needed because the
   * drain dispatch is racy against the observation window around runAgentLoop's
   * `finally`: drainQueue is async — it awaits buildPassthroughBatch (which
   * awaits resolveSlash) before shifting anything — and runAgentLoop fires it
   * without awaiting. So between the moment `finally` schedules drainQueue and
   * the moment a queued item is actually dispatched by drainBatch /
   * drainSingleMessage, `hasQueuedMessages()` and `isProcessing()` can each
   * flip in either direction (queue empties mid-await, or `processing` flips
   * false while items are still pending). Checking this sticky flag lets the
   * finally block in runSubagent reason about "any queued work existed for
   * this subagent during the run" without racing drain dispatch, and defer
   * the release to the TTL sweep rather than tearing down mid-drain.
   */
  hadEnqueuedMessages?: boolean;
  /**
   * Set on the synchronous `spawnAndAwait` path. When true, `runSubagent`
   * skips the terminal parent-injection (`notifyParentTerminal`) — the awaiting
   * caller receives the child's final text directly, so re-injecting a
   * "read the result" notification into the parent would be redundant noise.
   */
  synchronous?: boolean;
  /**
   * Optional text tap for the synchronous path. When set, `wrappedSendToClient`
   * forwards each `assistant_text_delta` / `assistant_thinking_delta` chunk to
   * this callback IN ADDITION to the normal `subagent_event` envelope.
   */
  onText?: (chunk: string) => void;
  /**
   * Optional liveness tap for the synchronous path. When set,
   * `wrappedSendToClient` fires it once per event that shows the child is still
   * moving (see {@link isSubagentProgressEvent}), which is a superset of the
   * `onText` chunks: a subagent executing a tool streams no token but is not
   * stalled. Callers that bound a synchronous run by an idle window re-arm it
   * here.
   */
  onProgress?: () => void;
}

export interface SubagentNotificationInfo {
  subagentId: string;
  label: string;
  status: "running" | "completed" | "failed" | "aborted";
  error?: string;
  conversationId?: string;
  objective?: string;
}

/**
 * Thrown by `spawnAndAwait` when the run is aborted (e.g. an external timeout)
 * before reaching a terminal `completed` state. Carries `partialText` — the
 * child's trailing assistant text captured at the moment of abort — so a caller
 * that times out a long generation can still surface the partial result instead
 * of discarding it. Extends `Error` with the same legacy message, so callers
 * that only inspect `.message` keep working.
 */
export class SubagentAbortedError extends Error {
  constructor(readonly partialText: string) {
    super("Subagent run aborted before completion.");
    this.name = "SubagentAbortedError";
  }
}

export class SubagentManager {
  /** subagentId → ManagedSubagent */
  private subagents = new Map<string, ManagedSubagent>();
  /** parentConversationId → Set<subagentId> */
  private parentToChildren = new Map<string, Set<string>>();
  /** `${parentConversationId}:${normalizedLabel}` → subagentId */
  private labelIndex = new Map<string, string>();

  /**
   * Set during `disposeAll()` (shutdown) so `dispose()` keeps the durable rows
   * instead of deleting them — an in-flight subagent must survive as a row to
   * be rehydrated as `interrupted` on the next boot.
   */
  private shuttingDown = false;

  /**
   * Cross-conversation rate-limit window. The conversation store reads this
   * same array when building its per-conversation RateLimitProvider, so
   * subagent requests and conversation requests share one global budget.
   */
  sharedRequestTimestamps: number[] = [];

  // ── Spawn ───────────────────────────────────────────────────────────

  /**
   * Spawn a new subagent.  Returns the subagent ID immediately.
   * The subagent's agent loop is started asynchronously (fire-and-forget).
   */
  async spawn(
    config: Omit<SubagentConfig, "id">,
    parentSendToClient: (msg: AssistantEvent) => void,
  ): Promise<string> {
    const { subagentId } = await this.setUpSubagent(config, parentSendToClient);

    // ── Kick off the agent loop (fire-and-forget) ───────────────────
    this.runSubagent(subagentId, config.requestText ?? config.objective).catch(
      (err) => {
        log.error({ subagentId, err }, "Subagent run failed unexpectedly");
      },
    );

    return subagentId;
  }

  // ── Internal: shared spawn setup ──────────────────────────────────────

  /**
   * Perform all spawn-time setup shared by `spawn` and `spawnAndAwait`:
   * enforce the depth limit, resolve role/provider/system prompt, construct
   * the child Conversation, register it, and emit the `subagent_spawned`
   * event. Does NOT start the agent loop — the caller decides whether to run
   * fire-and-forget (`spawn`) or awaited (`spawnAndAwait`).
   */
  private async setUpSubagent(
    config: Omit<SubagentConfig, "id">,
    parentSendToClient: (msg: AssistantEvent) => void,
    opts?: {
      synchronous?: boolean;
      onText?: (chunk: string) => void;
      onProgress?: () => void;
    },
  ): Promise<{ subagentId: string; managed: ManagedSubagent }> {
    // ── Limit checks ────────────────────────────────────────────────

    // Depth check: prevent subagents from spawning nested subagents.
    const isParentASubagent = [...this.subagents.values()].some(
      (s) => s.state.conversationId === config.parentConversationId,
    );
    if (isParentASubagent) {
      throw new Error(
        `Cannot spawn subagent: parent is itself a subagent (max depth ${SUBAGENT_LIMITS.maxDepth}).`,
      );
    }

    // ── Resolve role ─────────────────────────────────────────────────
    // A role is one of the three types, or absent for an internal caller that
    // states no shape and runs on the default. The `subagent_spawn` tool
    // resolves whatever the model wrote into a type before it gets here (see
    // subagent/role-resolution.ts), so an unregistered value at this point is
    // an internal caller's bug and is worth throwing over.
    const isFork = config.fork === true;
    const role: SubagentRole = config.role ?? DEFAULT_SUBAGENT_ROLE;
    if (!SUBAGENT_ROLE_REGISTRY[role]) {
      throw new Error(
        `Invalid subagent role "${config.role}". Must be one of: ${Object.keys(SUBAGENT_ROLE_REGISTRY).join(", ")}`,
      );
    }
    const roleConfig = SUBAGENT_ROLE_REGISTRY[role];

    // ── Resolve spawn mode ───────────────────────────────────────────
    // The spawning call site is the only layer that can tell an advisor
    // consult apart from a plain spawn, or a live-voice continuation apart
    // from a plain fork, so it declares its mode. The fallback is mechanical
    // rather than NULL: a future call site that forgets still records honest
    // context-inheritance shape instead of dropping out of the telemetry
    // breakdown entirely.
    const spawnMode: SubagentSpawnMode =
      config.spawnMode ?? (isFork ? "fork" : "regular");

    // ── Create conversation ─────────────────────────────────────────
    const subagentId = uuid();
    // `subagentRole` / `subagentSpawnMode` are stamped on the conversation
    // row, not just the `subagents` row, because `subagents` rows are deleted
    // on dispose while usage telemetry flushes on a watermark that can trail
    // far behind. See migration 362.
    const conversationRecord = await bootstrapConversation({
      conversationType: "background",
      source: "subagent",
      origin: "subagent",
      systemHint: `Subagent: ${config.label}`,
      parentConversationId: config.parentConversationId,
      subagentRole: role,
      subagentSpawnMode: spawnMode,
    });

    // ── Build conversation dependencies ─────────────────────────────
    const appConfig = getConfig();
    // Connection-aware default-provider resolution. Throws
    // `ConnectionResolutionError` if the resolved default config carries no
    // provider_connection or the connection row is missing/mismatched
    // (config bugs).
    // Returns null on soft credential failures (missing credential,
    // platform auth unavailable).
    const baseProvider = await resolveDefaultProvider(appConfig);
    if (!baseProvider) {
      throw await mainAgentResolutionError(appConfig.llm, listProviders());
    }
    // Per-call `options.config.callSite` (e.g. `subagentSpawn`) can resolve
    // to a profile that differs from the default's. The shared wrapper
    // threads `appConfig` through so per-call alternate-profile routing is
    // also connection-aware (matches the canonical dispatch path).
    let provider = wrapWithCallSiteRouting(baseProvider, appConfig);
    const { rateLimit } = appConfig;
    if (rateLimit.maxRequestsPerMinute > 0) {
      provider = new RateLimitProvider(
        provider,
        rateLimit,
        this.sharedRequestTimestamps,
      );
    }

    const parentConversation = findConversation(config.parentConversationId);

    let systemPrompt: string;
    if (isFork) {
      // Forks default to the parent's system prompt verbatim (no subagent
      // preamble) so the KV cache stays aligned with the parent. An explicit
      // `systemPromptOverride` opts out of that alignment and takes precedence.
      const resolved =
        config.systemPromptOverride ??
        config.parentSystemPrompt ??
        parentConversation?.getCurrentSystemPrompt();
      if (!resolved) {
        throw new Error(
          "Fork spawn requires a parent system prompt but neither config.parentSystemPrompt " +
            "nor findConversation yielded one.",
        );
      }
      systemPrompt = resolved;
    } else {
      systemPrompt =
        config.systemPromptOverride ??
        buildSubagentSystemPrompt({ ...config, id: subagentId }, role);
    }
    // Resolve under the same profile the run will use (forwarded via
    // `SubagentConfig`) so the constructed conversation's default token cap
    // matches the inherited profile rather than the static `subagentSpawn`
    // default. Per-call routing re-resolves the model anyway; this keeps the
    // initial value consistent.
    const maxTokens = resolveCallSiteConfig("subagentSpawn", appConfig.llm, {
      ...(config.overrideProfile
        ? { overrideProfile: config.overrideProfile }
        : {}),
      ...(config.forceOverrideProfile ? { forceOverrideProfile: true } : {}),
    }).maxTokens;
    const workingDir = getSandboxWorkingDir();

    // ── Initialise state ────────────────────────────────────────────
    const now = Date.now();
    // For forks, default sendResultToUser to false (silent) unless explicitly true.
    const resolvedSendResultToUser = isFork
      ? config.sendResultToUser === true
        ? true
        : false
      : config.sendResultToUser;
    const state: SubagentState = {
      config: {
        ...config,
        id: subagentId,
        sendResultToUser: resolvedSendResultToUser,
      },
      status: "pending",
      conversationId: conversationRecord.id,
      isFork,
      createdAt: now,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    };

    // Store the managed subagent early so the wrapper can read the mutable
    // parentSendToClient reference — this ensures reconnects are picked up.
    const managed: ManagedSubagent = {
      // Placeholder — replaced with the real Conversation a few lines below, before
      // any code reads this field. Using null! avoids the `as unknown as` cast.
      conversation: null! as Conversation,
      state,
      parentSendToClient,
      ...(opts?.synchronous ? { synchronous: true } : {}),
      ...(opts?.onText ? { onText: opts.onText } : {}),
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    };

    // Wrap sendToClient to envelope all events with the subagent ID.
    // Reads from managed.parentSendToClient so reconnects are picked up.
    const wrappedSendToClient = (msg: AssistantEvent): void => {
      // Tap streaming text/thinking deltas for the synchronous caller (if any),
      // in addition to the normal envelope below. Reads from managed.onText so
      // the synchronous path can forward chunks without altering event routing.
      if (managed.onText) {
        const text = extractDeltaText(msg);
        if (text) {
          managed.onText(text);
        }
      }
      // Liveness tap, separate from the text tap because tool activity is
      // progress the caller must see and is not a chunk it can forward.
      if (managed.onProgress && isSubagentProgressEvent(msg)) {
        managed.onProgress();
      }
      managed.parentSendToClient({
        type: "subagent_event",
        subagentId,
        conversationId: config.parentConversationId,
        event: msg,
      } as AssistantEvent);
    };

    const conversation = new Conversation(
      conversationRecord.id,
      provider,
      systemPrompt,
      wrappedSendToClient,
      workingDir,
      {
        maxTokens,
        cacheTtl: "5m",
        // Records the parent at construction; drives isSubagent and notify
        // routing from non-writable in-process state.
        parentConversationId: config.parentConversationId,
        // The advisor consult is scoped to read-only CLIENT tools and should
        // also ground its guidance with provider-native web search when the
        // resolved provider supports it. This is a server tool the provider
        // runs itself, so no client tool is surfaced and the allowlist is
        // unchanged.
        // Other roles keep the default (no native search appended).
        ...(role === "advisor" ? { enableNativeWebSearch: true } : {}),
      },
    );

    // A subagent has no client of its own: its sink (above) re-envelopes
    // events under the parent, and its turns run non-interactive, so
    // interactive prompts (host attachment reads) fail fast.
    // Subagents are created as background conversations (see the
    // `bootstrapConversation` call above) and never call `loadFromDb`, so cache
    // the type on the live conversation directly for the runtime-assembly path.
    conversation.conversationType = "background";

    // Subagents execute as background child conversations, but their tool
    // permissions must still be scoped to the actor that spawned them. Without
    // this, tool execution falls back to `unknown` trust and guardian-owned
    // desktop turns get denied as unverified. An explicit config trust context
    // wins over parent inheritance: a parent that stamps trust per-turn (the
    // live-voice bridge) has already cleared it by the time a detached spawn
    // reads it, so its spawner resolves trust itself.
    //
    // Inherit the parent's *turn* trust ahead of its conversation-level slot:
    // the slot holds whichever actor sent most recently, so a spawn during one
    // actor's turn would otherwise run under another's privileges.
    const parentTurnTrust = parentConversation?.getTurnOrRestingTrust();
    if (config.trustContext) {
      conversation.setTrustContext({ ...config.trustContext });
    } else if (parentTurnTrust) {
      conversation.setTrustContext({ ...parentTurnTrust });
    }
    const parentAuthContext = parentConversation?.getAuthContext();
    if (parentAuthContext) {
      conversation.setAuthContext({ ...parentAuthContext });
    }
    if (parentConversation?.assistantId) {
      conversation.setAssistantId(parentConversation.assistantId);
    }
    // Inherit the parent chat's per-conversation plugin scope so a subagent
    // spawned from a scoped chat can't see or execute plugins the user
    // deselected. `null` (no per-chat restriction) is the default and
    // propagates unchanged; a materialized scope is copied by value.
    if (parentConversation) {
      conversation.setEnabledPlugins(
        parentConversation.enabledPlugins
          ? [...parentConversation.enabledPlugins]
          : null,
      );
    }

    if (isFork && !config.systemPromptOverride) {
      // A verbatim-prompt fork pins the parent's system prompt as-is, skipping
      // the dynamic rebuild so the KV cache stays aligned with the parent. A
      // fork that supplies its own override prompt opts out of that alignment,
      // so leave `hasSystemPromptOverride` at its default.
      conversation.hasSystemPromptOverride = true;
    }

    // Apply the role's tool allowlist when one is defined. `builder` defines
    // none, so it keeps the full surface its conversation projects; the scoped
    // roles are filtered to their own list whether or not this is a fork.
    if (roleConfig.allowedTools) {
      conversation.setSubagentAllowedTools(new Set(roleConfig.allowedTools));
    }

    // A read-only subagent refuses side-effecting tools regardless of trust
    // class; the executor gate rejects any such dispatch and they are kept off
    // the model's tool surface. The role carries the gate so a caller cannot
    // spawn a role past it, and a spawn can still ask for it on top.
    if (config.denySideEffectTools || roleConfig.denySideEffects) {
      conversation.setSubagentDenySideEffects(true);
    }

    // A synchronous child's only parent channel is the awaiting caller: a
    // mid-run notify_parent would inject a user-role turn into the live
    // parent conversation (starting an unsolicited parent run) instead of
    // reaching that caller, so suppress it — the same reason runSubagent
    // skips the terminal parent-injection on this path.
    if (opts?.synchronous) {
      conversation.setSubagentSuppressParentNotifications(true);
    }

    // Pre-activate skills defined by the role config, merged with any caller-provided skill IDs.
    const mergedSkillIds = mergeSkillIds(
      roleConfig.skillIds,
      config.preactivatedSkillIds,
    );
    if (mergedSkillIds.length > 0) {
      conversation.setPreactivatedSkillIds(mergedSkillIds);
    }

    managed.conversation = conversation;
    this.subagents.set(subagentId, managed);
    // Index the live conversation so the per-conversation injectors (workspace
    // context, disk-pressure warning) can resolve it by id; subagents are not
    // in the eviction-managed conversation store.
    setSubagentConversation(conversationRecord.id, conversation);
    const labelKey = `${config.parentConversationId}:${normalizeSubagentLabel(config.label)}`;
    if (this.labelIndex.has(labelKey)) {
      log.warn(
        {
          label: config.label,
          parentConversationId: config.parentConversationId,
          existingSubagentId: this.labelIndex.get(labelKey),
          newSubagentId: subagentId,
        },
        "Label collision: new subagent overwrites label index entry (previous subagent still accessible by UUID)",
      );
    }
    this.labelIndex.set(labelKey, subagentId);

    // Track parent → child relationship.
    if (!this.parentToChildren.has(config.parentConversationId)) {
      this.parentToChildren.set(config.parentConversationId, new Set());
    }
    this.parentToChildren.get(config.parentConversationId)!.add(subagentId);

    // Persist the initial record so the subagent survives a daemon restart.
    this.persistState(managed.state);

    // Notify client that a subagent was spawned.
    parentSendToClient({
      type: "subagent_spawned",
      subagentId,
      parentConversationId: config.parentConversationId,
      label: config.label,
      objective: config.objective,
      isFork: config.fork ?? false,
      parentToolUseId: config.parentToolUseId,
    } as AssistantEvent);

    log.info(
      {
        subagentId,
        parentConversationId: config.parentConversationId,
        label: config.label,
      },
      "Subagent spawned",
    );

    return { subagentId, managed };
  }

  // ── Spawn and await (synchronous) ─────────────────────────────────────

  /**
   * Spawn a subagent and AWAIT its run, resolving to the child's final
   * assistant text. Unlike `spawn` (fire-and-forget), the caller blocks until
   * the child reaches a terminal state and receives the text directly — so the
   * terminal parent-injection (`notifyParentTerminal`) is skipped on this path.
   *
   * `opts.signal` aborts the underlying run when triggered (e.g. an external
   * timeout). `opts.onText` receives each streaming text/thinking chunk in
   * addition to the normal `subagent_event` envelope.
   */
  async spawnAndAwait(
    config: Omit<SubagentConfig, "id">,
    parentSendToClient: (msg: AssistantEvent) => void,
    opts?: {
      signal?: AbortSignal;
      onText?: (chunk: string) => void;
      onProgress?: () => void;
    },
  ): Promise<string> {
    const { subagentId, managed } = await this.setUpSubagent(
      config,
      parentSendToClient,
      {
        synchronous: true,
        ...(opts?.onText ? { onText: opts.onText } : {}),
        ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      },
    );

    // Wire the external signal to abort the child conversation. If the signal
    // is already aborted, abort immediately so the run rejects promptly.
    const signal = opts?.signal;
    const onAbort = (): void => {
      // Route through the manager abort path so the subagent is marked terminal
      // ("aborted") and broadcast as such. A bare conversation.abort() leaves
      // status non-terminal, so runSubagent's success branch would record the
      // run as "completed" once runAgentLoop resolves the consumed cancellation.
      // Suppress the parent notification: the awaiting caller observes the abort
      // as a thrown rejection, so a "do NOT re-spawn" injection would be
      // redundant noise.
      this.abort(subagentId, managed.parentSendToClient, undefined, {
        suppressNotification: true,
      });
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    try {
      const finalText = await this.runSubagent(
        subagentId,
        config.requestText ?? config.objective,
      );
      // Surface aborts as a rejection so the caller's timeout path is
      // observable — but carry the partial text on the error so a caller that
      // timed out a long generation (e.g. the advisor consult) can still
      // surface what was produced instead of throwing it away.
      if (signal?.aborted) {
        throw new SubagentAbortedError(finalText);
      }
      return finalText;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // ── Internal: run the subagent ────────────────────────────────────────

  private async runSubagent(
    subagentId: string,
    objective: string,
  ): Promise<string> {
    const managed = this.subagents.get(subagentId);
    if (!managed) {
      return "";
    }

    // Capture the live conversation — it is non-null at this point because
    // spawn() sets it before firing runSubagent.
    const conversation = managed.conversation!;

    // The child's trailing assistant text, captured after runAgentLoop resolves
    // (before the `finally` releases the conversation). Returned to the
    // synchronous `spawnAndAwait` caller; the fire-and-forget `spawn` caller
    // ignores it.
    let finalText = "";

    // Aborted before the run started (e.g. an already-aborted signal on the
    // synchronous spawnAndAwait path): the subagent is already terminal. Do not
    // start the agent loop or reset status back to "running" — but still release
    // the conversation, exactly as the post-run `finally` does for a terminal
    // run. The loop never started, so no messages were enqueued; this matches
    // the finally's non-deferred release branch.
    if (TERMINAL_STATUSES.has(managed.state.status)) {
      this.releaseConversation(managed);
      return finalText;
    }

    // Read the current parent sender so reconnects are picked up.
    const getSender = () => managed.parentSendToClient;

    // Stamp startedAt before the status transition so the persistence hook
    // inside setStatus captures it on the running row (otherwise a crash mid-run
    // rehydrates as interrupted with no start time).
    managed.state.startedAt = Date.now();
    this.setStatus(subagentId, "running", getSender());

    try {
      // For forks, inject the parent's message history before the first message.
      // This prepends the inherited context so the fork has full conversational
      // awareness while the objective becomes the latest user turn.
      if (managed.state.isFork && managed.state.config.parentMessages) {
        conversation.injectInheritedContext(
          managed.state.config.parentMessages,
        );
        // Release the parent message arrays now that they've been injected — holding
        // them in SubagentState.config would retain significant memory until the TTL
        // sweep disposes this entry (up to 30 minutes for terminal subagents).
        managed.state.config.parentMessages = undefined;
        managed.state.config.parentSystemPrompt = undefined;
      }

      // Send the objective as the first user message and process it.
      // For forks, wrap the objective in directive framing so it overrides
      // conversational momentum from the inherited context. Without this,
      // the fork tends to continue the parent conversation instead of
      // pivoting to the task: the inherited context is louder than a bare
      // objective buried after 100k+ tokens of chat history.
      //
      // A fork's persona and output contract ride in this framing rather than
      // the system prompt: the prompt is the parent's, inherited verbatim to
      // keep the KV cache aligned, so the task message is the only place a
      // fork-specific instruction can land.
      const useForkFraming = managed.state.isFork;
      const forkPersona = managed.state.config.persona;
      const forkContract = subagentOutputContractText(
        managed.state.config.outputContract,
      );
      const message = useForkFraming
        ? [
            "⎯⎯⎯ FORK TASK ⎯⎯⎯",
            "You have been forked from the parent conversation to execute a specific task.",
            "The conversation above is context — do NOT continue it. Do NOT spawn sub-agents.",
            ...(forkPersona ? [`Act as ${forkPersona} for this task.`] : []),
            ...(forkContract ? [`Output contract: ${forkContract}`] : []),
            "Complete this task directly and return only your findings:",
            "",
            objective,
            "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
          ].join("\n")
        : objective;
      const { id: messageId } = await conversation.persistUserMessage({
        content: message,
      });
      await conversation.runAgentLoop(message, messageId, {
        callSite: "subagentSpawn",
        ...(managed.state.config.overrideProfile
          ? { overrideProfile: managed.state.config.overrideProfile }
          : {}),
        ...(managed.state.config.forceOverrideProfile
          ? { forceOverrideProfile: true }
          : {}),
        // Stamp the child's usage with the firing that spawned it so schedule
        // cost reporting sees delegated spend.
        ...(managed.state.config.cronRunId
          ? { cronRunId: managed.state.config.cronRunId }
          : {}),
      });

      // Agent loop completed successfully.
      // Capture the trailing assistant text before any release nulls the
      // conversation reference. The fire-and-forget caller ignores the return.
      finalText = extractFinalAssistantText(conversation.messages);
      // Capture any tools the subagent reached for but its role denied, before a
      // release nulls the conversation reference, so we can tell the parent.
      const deniedTools = [...conversation.subagentDeniedToolNames];
      // Copy usage stats from the conversation before sending status (which includes usage).
      managed.state.usage = { ...conversation.usageStats };
      // Same window for the tool-call counts: the terminal notification below
      // reads them off the state. This is the first reading, not necessarily
      // the last, since a follow-up turn queued during the run drains after
      // this returns and keeps counting into the same conversation. Later
      // readers go through `currentToolStats` for the settled numbers.
      managed.state.stats = snapshotToolStats(conversation);
      // Only update state + notify if still non-terminal (guards against abort race).
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        managed.state.completedAt = Date.now();
        this.setStatus(subagentId, "completed", getSender());

        log.info({ subagentId }, "Subagent completed");

        // Notify the parent conversation, inlining the subagent's final
        // synthesis so the LLM acts on the result without a subagent_read
        // round-trip. Skipped on the synchronous path — the awaiting caller
        // receives the final text directly.
        if (!managed.synchronous) {
          this.notifyParentTerminal(
            managed,
            "completed",
            finalText,
            deniedTools,
          );
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      managed.state.error = errorMsg;
      managed.state.completedAt = Date.now();
      // Copy usage from the captured conversation reference — managed.conversation
      // may have been nulled by an external dispose() before catch runs.
      managed.state.usage = { ...conversation.usageStats };
      managed.state.stats = snapshotToolStats(conversation);

      // Only update status if not already terminal (e.g. aborted).
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        this.setStatus(subagentId, "failed", getSender(), errorMsg);
        // Skip terminal parent-injection on the synchronous path — the failure
        // surfaces to the awaiting caller as a rejected promise instead.
        if (!managed.synchronous) {
          this.notifyParentTerminal(managed, "failed");
        }
      }

      log.error({ subagentId, err }, "Subagent failed");

      // Surface the failure to the synchronous caller. The fire-and-forget
      // path has no awaiter, so re-throwing there only feeds the `.catch()`
      // logger in `spawn` — harmless but noisy — so it is confined to the
      // synchronous path.
      if (managed.synchronous) {
        throw err;
      }
    } finally {
      // Release the heavyweight Conversation — output is already persisted in DB.
      // drainQueue is async: it awaits buildPassthroughBatch (which awaits
      // resolveSlash) before shifting anything, and runAgentLoop fires it
      // without awaiting. That means by the time this finally runs, a drain
      // may already be scheduled but not yet dispatched — so checking
      // hasQueuedMessages() / isProcessing() here races the dispatch and can
      // observe an empty queue (or `processing === false`) while queued work
      // is still pending. The hadEnqueuedMessages flag (set in sendMessage)
      // is a sticky monotonic marker that any queued work existed during this
      // run, letting us defer the release to the TTL sweep rather than
      // tearing down mid-drain.
      if (managed.hadEnqueuedMessages) {
        log.debug(
          { subagentId },
          "Deferring conversation release — messages were enqueued during run",
        );
        managed.retainedUntil = Date.now() + TERMINAL_RETENTION_MS;
        this.ensureSweepRunning();
      } else {
        this.releaseConversation(managed);
      }
    }

    return finalText;
  }

  // ── Abort ─────────────────────────────────────────────────────────────

  abort(
    subagentId: string,
    parentSendToClient?: (msg: AssistantEvent) => void,
    callerConversationId?: string,
    options?: { suppressNotification?: boolean },
  ): boolean {
    const managed = this.subagents.get(subagentId);
    if (!managed) {
      return false;
    }
    if (TERMINAL_STATUSES.has(managed.state.status)) {
      return false;
    }
    // If a caller conversation is specified, verify ownership.
    if (
      callerConversationId &&
      managed.state.config.parentConversationId !== callerConversationId
    ) {
      log.warn(
        {
          subagentId,
          callerConversationId,
          parentConversationId: managed.state.config.parentConversationId,
        },
        "Abort rejected: caller does not own this subagent",
      );
      return false;
    }

    managed.conversation?.abort(
      createAbortReason(
        "subagent_aborted",
        "SubagentManager.abort",
        managed.conversation.conversationId,
      ),
    );
    managed.state.completedAt = Date.now();
    // Capture the conversation's latest usage before emitting the terminal
    // status. `subagent_status_changed` ships `state.usage`, and the abort path
    // (unlike the completion/failure paths, which sync at agent-loop exit) would
    // otherwise send the {0,0,0} init usage — zeroing the client's token counts
    // even though those tokens were already spent. `usageStats` accrues per LLM
    // turn (see conversation-usage.ts), so this is the most recent total.
    if (managed.conversation) {
      managed.state.usage = { ...managed.conversation.usageStats };
    }
    if (parentSendToClient) {
      // Route the status update through the stored parent sender so the
      // owning conversation's UI chip updates, even when the abort comes from a
      // different socket (e.g. after conversation switching). Fall back to the
      // caller-provided sender if no stored sender exists.
      const statusSender = managed.parentSendToClient ?? parentSendToClient;
      this.setStatus(subagentId, "aborted", statusSender);
      // Notify parent that the subagent was explicitly aborted — tell it NOT to re-spawn.
      // Skip when the parent LLM itself called subagent_abort (it already has the tool result).
      if (!options?.suppressNotification) {
        const label = managed.state.config.label;
        const prefix = managed.state.isFork ? "Fork" : "Subagent";
        const message =
          `[${prefix} "${label}" was explicitly aborted]\n\n` +
          `This ${prefix.toLowerCase()} was cancelled on purpose. Do NOT re-spawn or retry it.`;
        injectMessageIntoParent(
          managed.state.config.parentConversationId,
          message,
          {
            subagentNotification: {
              subagentId,
              label,
              status: "aborted" as const,
              conversationId: managed.state.conversationId,
            },
          },
        );
      }
    } else {
      managed.state.status = "aborted";
      this.persistState(managed.state);
    }

    log.info({ subagentId }, "Subagent aborted");
    return true;
  }

  /**
   * Abort all in-flight subagents belonging to a parent conversation, keeping
   * every child's metadata (and durable record) readable for the normal
   * terminal-retention window. Called when the parent conversation stops or is
   * released from memory but its id lives on — user cancel, idle eviction,
   * config-reload rebuild — so a completed child's result stays retrievable via
   * `subagent_read` afterwards. Aborted children release their live
   * conversations through the run's own teardown and are swept on the TTL like
   * any other terminal entry.
   */
  abortAllForParent(
    parentConversationId: string,
    parentSendToClient?: (msg: AssistantEvent) => void,
  ): number {
    const children = this.parentToChildren.get(parentConversationId);
    if (!children) {
      return 0;
    }

    let count = 0;
    for (const childId of children) {
      if (this.abort(childId, parentSendToClient)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Abort and fully dispose every subagent across all parents, deleting their
   * durable records. For clear-all: every conversation's data is going away,
   * including retained children of parents that are no longer in the in-memory
   * conversation store.
   *
   * `keepRecords` tears down the in-memory side only, leaving every row for the
   * caller to delete. Clear-all passes it so the ordered persistence wipe that
   * follows owns row deletion (conversations first, then subagents), matching
   * the retry-safe pattern already on `disposeAllForParent`: an eager delete
   * here would lose the rows if that wipe throws. Without it, behavior is
   * unchanged and the records are deleted here.
   */
  disposeAllForAllParents(opts?: { keepRecords?: boolean }): void {
    for (const parentId of [...this.parentToChildren.keys()]) {
      this.disposeAllForParent(parentId, undefined, opts);
    }
    // `parentToChildren` only names parents that still hold in-memory children,
    // and the TTL sweep drops a child's entry while keeping its row, so a
    // parent whose children were all swept has no key to iterate. Clearing the
    // table is the only way to take every retained row with the data it
    // belongs to.
    if (!this.shuttingDown && !opts?.keepRecords) {
      try {
        deleteAllSubagentRecords();
      } catch (err) {
        log.warn({ err }, "Failed to delete subagent records");
      }
    }
  }

  /**
   * Abort and fully dispose all subagents belonging to a parent conversation,
   * deleting their durable records. Only for parents whose conversation data is
   * going away (deletion, clear-all) — nobody will call subagent_read.
   *
   * `keepRecords` tears down the in-memory side only, leaving the rows for the
   * caller to delete itself. For a caller that has destructive work of its own
   * still to do: the rows are a subagent's only durable metadata, so dropping
   * them before that work commits loses them for good if it throws, while the
   * conversation they describe survives for a retried delete.
   */
  disposeAllForParent(
    parentConversationId: string,
    parentSendToClient?: (msg: AssistantEvent) => void,
    opts?: { keepRecords?: boolean },
  ): number {
    const count = this.abortAllForParent(
      parentConversationId,
      parentSendToClient,
    );

    const children = this.parentToChildren.get(parentConversationId);
    if (children) {
      // Use snapshot since dispose mutates the set.
      for (const childId of [...children]) {
        this.dispose(childId);
      }
    }

    // The durable rows are dropped here rather than per child: a subagent's row
    // lives as long as its parent conversation, and one the TTL sweep already
    // evicted has no in-memory entry left to dispose, so its row is only
    // reachable by parent. Shutdown keeps every row so in-flight children can
    // rehydrate as `interrupted` on the next boot.
    if (!this.shuttingDown && !opts?.keepRecords) {
      try {
        deleteSubagentRecordsByParent(parentConversationId);
      } catch (err) {
        log.warn(
          { parentConversationId, err },
          "Failed to delete subagent records for parent",
        );
      }
    }

    return count;
  }

  // ── Send message to subagent ──────────────────────────────────────────

  /**
   * Deliver a follow-up message to a live subagent.
   *
   * `opts.cronRunId` is the firing that produced THIS message, not the one the
   * subagent was spawned under: a continuation turn's spend belongs to the
   * firing that asked for it. Only the immediately-processed turn carries it,
   * since a queued message drains through the conversation's own queue, which
   * holds no per-message run options.
   */
  async sendMessage(
    subagentId: string,
    content: string,
    opts?: { cronRunId?: string | null },
  ): Promise<"sent" | "empty" | "not_found" | "terminal"> {
    const trimmed = content?.trim();
    if (!trimmed) {
      return "empty";
    }

    const managed = this.subagents.get(subagentId);
    if (!managed) {
      return "not_found";
    }
    if (TERMINAL_STATUSES.has(managed.state.status) || !managed.conversation) {
      return "terminal";
    }

    // If the conversation is busy, queue the message; otherwise process immediately.
    const result = managed.conversation.enqueueMessage({ content: trimmed });
    if (result.rejected) {
      return "sent"; // error event already delivered via sendToClient
    }
    if (result.queued) {
      managed.hadEnqueuedMessages = true;
    }
    if (!result.queued) {
      // Capture conversation before the await — managed.conversation may be
      // nulled by an external dispose() while persistUserMessage is awaited.
      const conversation = managed.conversation;
      const { id: messageId } = await conversation.persistUserMessage({
        content: trimmed,
      });
      conversation
        .runAgentLoop(trimmed, messageId, {
          callSite: "subagentSpawn",
          ...(managed.state.config.overrideProfile
            ? { overrideProfile: managed.state.config.overrideProfile }
            : {}),
          ...(managed.state.config.forceOverrideProfile
            ? { forceOverrideProfile: true }
            : {}),
          ...(opts?.cronRunId ? { cronRunId: opts.cronRunId } : {}),
        })
        .catch((err) => {
          log.error({ subagentId, err }, "Subagent message processing failed");
        });
    }
    return "sent";
  }

  // ── Queries ───────────────────────────────────────────────────────────

  getState(subagentId: string): SubagentState | undefined {
    return this.subagents.get(subagentId)?.state;
  }

  /**
   * The subagent's tool-call counters, brought up to date first, or why there
   * are none (see {@link SubagentToolStatsReading}).
   *
   * `runSubagent` harvests when its awaited agent loop returns, but that is not
   * the end of the child's work: guidance queued during the run drains
   * afterwards, on the same conversation, and those calls land in the same
   * counters. So any read taken later re-reads them while the conversation is
   * still retained (see {@link refreshToolStats}), and the release freezes the
   * settled numbers. Readers that need the queued turn's calls included wait
   * for it first, via {@link settleQueuedTurns}.
   *
   * An id the manager does not hold is `unrecoverable` rather than unknown:
   * counters exist nowhere else, so no caller can ever obtain them, and the
   * only state a caller can be holding for such an id came from the durable
   * row.
   */
  currentToolStats(subagentId: string): SubagentToolStatsReading {
    const managed = this.subagents.get(subagentId);
    if (!managed) {
      return { kind: "unrecoverable" };
    }
    this.refreshToolStats(managed);
    if (managed.state.stats) {
      return { kind: "counted", stats: managed.state.stats };
    }
    return managed.rehydrated
      ? { kind: "unrecoverable" }
      : { kind: "unmeasured" };
  }

  /**
   * Wait for a follow-up turn queued during the subagent's run to finish.
   *
   * `runSubagent` marks the subagent terminal as soon as its own agent loop
   * returns, and the parent is told to read from there. Guidance queued during
   * that run drains afterwards though, on the same retained conversation, so a
   * read taken in that window sees the transcript and the counters from before
   * the guidance landed and never comes back for the rest. Waiting here closes
   * the window.
   *
   * Resolves `true` once the retained conversation is idle with an empty
   * queue, and `false` when `timeoutMs` elapses first, so the reader always
   * gets an answer within a bound and can say the subagent is still moving
   * rather than pass a partial result off as final.
   *
   * `true` comes back immediately when nothing can still be running: no
   * manager entry, no retained conversation (a released one has its transcript
   * and counters frozen), or a run that never had anything queued.
   *
   * Idle is confirmed across two observations a poll apart. The drain takes
   * the queue before it takes the processing lock (`drainQueue` shifts the
   * message, then `drainSingleMessage` awaits slash resolution and the
   * user-message persist before `runAgentLoop` sets processing), so a single
   * look into that gap finds an empty queue and an unlocked conversation while
   * the turn is in fact starting.
   */
  async settleQueuedTurns(
    subagentId: string,
    timeoutMs: number = QUEUED_TURN_SETTLE_TIMEOUT_MS,
  ): Promise<boolean> {
    const managed = this.subagents.get(subagentId);
    const conversation = managed?.conversation;
    if (!managed || !conversation || managed.hadEnqueuedMessages !== true) {
      return true;
    }
    const deadline = Date.now() + timeoutMs;
    let idleObservations = 0;
    for (;;) {
      // A release during the wait (the TTL sweep, or a dispose) freezes
      // everything a reader can see, so there is nothing left to wait for.
      if (managed.conversation !== conversation) {
        return true;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return false;
      }
      if (conversation.isProcessing()) {
        idleObservations = 0;
        await conversation.waitForIdle({ timeoutMs: remainingMs });
        continue;
      }
      if (conversation.hasQueuedMessages()) {
        idleObservations = 0;
        await sleep(Math.min(QUEUED_TURN_POLL_MS, remainingMs));
        continue;
      }
      idleObservations += 1;
      if (idleObservations >= 2) {
        return true;
      }
      await sleep(Math.min(QUEUED_TURN_POLL_MS, remainingMs));
    }
  }

  /**
   * Re-read the child conversation's live counters into its state.
   *
   * Only ever updates a harvest that already happened: a run that never
   * reached its harvest (aborted before the first turn, or still going) has
   * nothing measured to report, and a zero taken mid-flight would read as
   * "this subagent used no tools" rather than "not measured yet".
   */
  private refreshToolStats(managed: ManagedSubagent): void {
    if (managed.conversation && managed.state.stats) {
      managed.state.stats = snapshotToolStats(managed.conversation);
    }
  }

  getByLabel(
    label: string,
    parentConversationId: string,
  ): SubagentState | undefined {
    const key = `${parentConversationId}:${normalizeSubagentLabel(label)}`;
    const id = this.labelIndex.get(key);
    return id ? this.getState(id) : undefined;
  }

  getChildrenOf(parentConversationId: string): SubagentState[] {
    const children = this.parentToChildren.get(parentConversationId);
    if (!children) {
      return [];
    }
    return [...children]
      .map((id) => this.subagents.get(id)?.state)
      .filter((s): s is SubagentState => s !== undefined);
  }

  /**
   * True when this parent still has a child that is not terminal (`pending`,
   * `running`, or `awaiting_input`). Idle-eviction and config-reload rebuild
   * skip those parents so an otherwise-idle conversation does not abort
   * mid-task children.
   */
  hasActiveChildren(parentConversationId: string): boolean {
    return this.getChildrenOf(parentConversationId).some(
      (child) => !TERMINAL_STATUSES.has(child.status),
    );
  }

  /** Total number of active (non-terminal) subagents. */
  get activeCount(): number {
    return [...this.subagents.values()].filter(
      (s) => !TERMINAL_STATUSES.has(s.state.status),
    ).length;
  }

  /**
   * Re-emit every child's current status through its parent sink. The send
   * route calls this on each interactive send so a client that reconnected
   * mid-run resyncs any status it missed while disconnected (e.g. a subagent
   * marked `interrupted` during rehydration after a daemon restart, whose card
   * would otherwise stay stuck on a stale `running`).
   */
  reannounceChildStatuses(parentConversationId: string): void {
    const children = this.parentToChildren.get(parentConversationId);
    if (!children) {
      return;
    }

    for (const childId of children) {
      const managed = this.subagents.get(childId);
      if (!managed) {
        continue;
      }
      managed.parentSendToClient({
        type: "subagent_status_changed",
        subagentId: childId,
        status: managed.state.status,
        error: managed.state.error,
        usage: managed.state.usage,
      } as AssistantEvent);
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  /**
   * Release the live Conversation from a terminal subagent, keeping only
   * lightweight metadata (state, config, usage) for later queries.
   * The conversation's output is already persisted in the database.
   */
  private releaseConversation(managed: ManagedSubagent): void {
    if (!managed.conversation) {
      return;
    }
    // Last chance at the counters: on the deferred path this release happens
    // after the queued follow-up turn drained, so this is the reading that
    // includes it. Everything read after this point is this snapshot.
    this.refreshToolStats(managed);
    const conversation = managed.conversation;
    removeSubagentConversation(conversation.conversationId, conversation);
    conversation.dispose();
    managed.conversation = null;
    managed.retainedUntil = Date.now() + TERMINAL_RETENTION_MS;
    this.ensureSweepRunning();

    log.debug(
      { subagentId: managed.state.config.id },
      "Released live conversation for terminal subagent",
    );
  }

  /**
   * Dispose a subagent and remove it from tracking.
   * Should be called after the subagent reaches a terminal state
   * and its data is no longer needed.
   *
   * In-memory only: a subagent's row in the `subagents` table lives as long as
   * its parent conversation, so it survives this and keeps answering
   * `getSubagentDetail` for a client that missed the spawn event. Rows are
   * deleted by parent, from `disposeAllForParent` / `disposeAllForAllParents`.
   */
  dispose(subagentId: string): void {
    const managed = this.subagents.get(subagentId);
    if (!managed) {
      return;
    }

    if (managed.conversation) {
      const conversation = managed.conversation;
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        conversation.abort(
          createAbortReason(
            "subagent_aborted",
            "SubagentManager.dispose",
            conversation.conversationId,
          ),
        );
      }
      removeSubagentConversation(conversation.conversationId, conversation);
      conversation.dispose();
      managed.conversation = null;
    }
    this.subagents.delete(subagentId);

    // Remove from label index only if it still maps to this subagent
    // (guards against stale delete when a newer subagent reused the label).
    const label = managed.state.config.label;
    const parentConvId = managed.state.config.parentConversationId;
    const labelKey = `${parentConvId}:${normalizeSubagentLabel(label)}`;
    if (this.labelIndex.get(labelKey) === subagentId) {
      this.labelIndex.delete(labelKey);
    }

    // Remove from parent tracking.
    const parentId = managed.state.config.parentConversationId;
    const siblings = this.parentToChildren.get(parentId);
    if (siblings) {
      siblings.delete(subagentId);
      if (siblings.size === 0) {
        this.parentToChildren.delete(parentId);
      }
    }
  }

  /** Dispose all subagents. Called on daemon shutdown. */
  disposeAll(): void {
    // Mark shutdown so dispose() keeps the durable rows: an in-flight subagent
    // must survive as a row to be rehydrated as `interrupted` on the next boot.
    this.shuttingDown = true;
    this.stopSweep();
    for (const id of [...this.subagents.keys()]) {
      this.dispose(id);
    }
  }

  // ── Persistence / rehydration ─────────────────────────────────────────

  /**
   * Write the subagent's current state to the durable `subagents` table.
   * Best-effort: persistence failures are logged, never thrown — a background
   * subagent must not fail because its bookkeeping row could not be written.
   */
  private persistState(state: SubagentState): void {
    try {
      upsertSubagentRecord({
        id: state.config.id,
        parentConversationId: state.config.parentConversationId,
        conversationId: state.conversationId,
        label: state.config.label,
        objective: state.config.objective,
        role: state.config.role ?? DEFAULT_SUBAGENT_ROLE,
        isFork: state.isFork,
        sendResultToUser: state.config.sendResultToUser ?? null,
        parentToolUseId: state.config.parentToolUseId ?? null,
        status: state.status,
        error: state.error ?? null,
        createdAt: state.createdAt,
        startedAt: state.startedAt ?? null,
        completedAt: state.completedAt ?? null,
        inputTokens: state.usage.inputTokens,
        outputTokens: state.usage.outputTokens,
        estimatedCost: state.usage.estimatedCost,
      });
    } catch (err) {
      log.warn(
        { subagentId: state.config.id, err },
        "Failed to persist subagent record",
      );
    }
  }

  /**
   * Rebuild in-memory subagent metadata from the durable table after a restart.
   * Terminal records load as-is so `subagent_read`/`getState` keep working
   * (output is read from the child conversation's persisted messages). Records
   * still in flight when the process died are marked `interrupted` — the run is
   * not resumed; the parent decides whether to re-spawn. Rehydrated entries
   * carry a no-op sender and no live conversation, and are swept on the normal
   * TTL like any other terminal subagent.
   *
   * Bounded by `MAX_REHYDRATED_TERMINAL_RECORDS`: every row still unsettled
   * loads however old it is, plus the most recently finished terminal ones.
   * Older terminal subagents stay in the table and are read from there.
   *
   * Best-effort and idempotent: a second restart re-reads `interrupted` rows
   * and leaves them unchanged.
   */
  rehydrateFromDb(): { rehydrated: number; interrupted: number } {
    const records = loadRehydratableSubagentRecords({
      terminalStatuses: [...TERMINAL_STATUSES],
      maxTerminal: MAX_REHYDRATED_TERMINAL_RECORDS,
    });
    let interrupted = 0;
    const now = Date.now();
    // Spawn key of the record currently holding each label. Precedence is
    // decided here rather than by the order rows arrive in, and follows spawn
    // order to match the live index, which `spawn()` moves to the newest
    // subagent regardless of what finishes first.
    const labelClaimedBy = new Map<string, SpawnKey>();
    for (const rec of records) {
      const wasInFlight = !TERMINAL_STATUSES.has(rec.status as SubagentStatus);
      if (wasInFlight) {
        interrupted++;
      }

      const mapped = subagentStateFromRecord(rec);
      const state: SubagentState = {
        ...mapped,
        status: settleUnsupervisedStatus(mapped.status),
      };

      const managed: ManagedSubagent = {
        conversation: null,
        state,
        parentSendToClient: () => {},
        retainedUntil: now + TERMINAL_RETENTION_MS,
        rehydrated: true,
      };
      this.subagents.set(rec.id, managed);

      const labelKey = `${rec.parentConversationId}:${normalizeSubagentLabel(rec.label)}`;
      const spawnKey: SpawnKey = {
        createdAt: rec.createdAt,
        spawnSeq: rec.spawnSeq,
      };
      const claimedBy = labelClaimedBy.get(labelKey);
      if (claimedBy === undefined || isLaterSpawn(spawnKey, claimedBy)) {
        labelClaimedBy.set(labelKey, spawnKey);
        this.labelIndex.set(labelKey, rec.id);
      }

      if (!this.parentToChildren.has(rec.parentConversationId)) {
        this.parentToChildren.set(rec.parentConversationId, new Set());
      }
      this.parentToChildren.get(rec.parentConversationId)!.add(rec.id);

      // Persist the interrupted transition so a second restart is a no-op.
      if (wasInFlight) {
        this.persistState(state);
      }
    }
    if (records.length > 0) {
      this.ensureSweepRunning();
    }
    return { rehydrated: records.length, interrupted };
  }

  // ── TTL sweep for terminal metadata ──────────────────────────────────

  private sweepTimer?: ReturnType<typeof setInterval>;

  private ensureSweepRunning(): void {
    if (this.sweepTimer) {
      return;
    }
    this.sweepTimer = setInterval(
      () => this.sweepTerminal(),
      SWEEP_INTERVAL_MS,
    );
    // Don't let the sweep timer keep the process alive.
    if (
      this.sweepTimer &&
      typeof this.sweepTimer === "object" &&
      "unref" in this.sweepTimer
    ) {
      (this.sweepTimer as { unref: () => void }).unref();
    }
  }

  private stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Remove terminal entries whose retention period has expired. */
  private sweepTerminal(): void {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, managed] of this.subagents) {
      if (!managed.retainedUntil || now < managed.retainedUntil) {
        continue;
      }
      // If the retention window has expired and the conversation is still live,
      // release it now — the drain has had ample time to complete.
      if (managed.conversation) {
        this.releaseConversation(managed);
        // releaseConversation resets retainedUntil to keep metadata around for
        // another window; the entry will be swept on the next pass.
        continue;
      }
      expired.push(id);
    }
    for (const id of expired) {
      log.debug(
        { subagentId: id },
        "Sweeping expired terminal subagent metadata",
      );
      // Metadata only: the durable row outlives the sweep so a client that
      // missed `subagent_spawned` can still resolve the child conversation.
      this.dispose(id);
    }
    // Stop the timer if there are no more entries to sweep.
    const hasTerminal = [...this.subagents.values()].some(
      (s) => s.retainedUntil !== undefined,
    );
    if (!hasTerminal) {
      this.stopSweep();
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private setStatus(
    subagentId: string,
    status: SubagentStatus,
    parentSendToClient: (msg: AssistantEvent) => void,
    error?: string,
  ): void {
    const managed = this.subagents.get(subagentId);
    if (!managed) {
      return;
    }

    // Idempotent terminal state guard.
    if (
      TERMINAL_STATUSES.has(managed.state.status) &&
      managed.state.status !== status
    ) {
      return;
    }

    managed.state.status = status;
    if (error !== undefined) {
      managed.state.error = error;
    }

    parentSendToClient({
      type: "subagent_status_changed",
      subagentId,
      status,
      error,
      usage: managed.state.usage,
    } as AssistantEvent);

    // Mirror the transition to the durable record.
    this.persistState(managed.state);
  }

  // ── Child → Parent notification ────────────────────────────────────

  /**
   * Inject a completion/failure notification into the parent conversation so
   * the LLM automatically informs the user. On completion the subagent's final
   * synthesis is inlined (via `buildSubagentTerminalMessage`) so the parent acts
   * on the result directly rather than issuing a `subagent_read` call.
   */
  private notifyParentTerminal(
    managed: ManagedSubagent,
    outcome: "completed" | "failed",
    finalText?: string,
    deniedTools?: string[],
  ): void {
    const { config } = managed.state;
    const isFork = managed.state.isFork;
    // Forks default to internal/silent unless explicitly shared; regular
    // subagents share with the user unless explicitly silenced.
    const silent = isFork
      ? config.sendResultToUser !== true
      : config.sendResultToUser === false;

    // A queued follow-up turn means the snapshot we hold is stale; defer to a
    // read pointer so the parent picks up the queued turn's output instead.
    const deferred = managed.hadEnqueuedMessages === true;

    const message = buildSubagentTerminalMessage({
      label: config.label,
      subagentId: config.id,
      isFork,
      outcome,
      silent,
      finalText,
      error: managed.state.error,
      deferred,
      deniedTools,
      // Same staleness applies to the counters, and worse: the queued turn has
      // not run yet at this point, so any number quoted here would under-report
      // it, permanently, in a message that is never rewritten. The deferred
      // message sends the parent to `subagent_read`, whose footer re-reads the
      // counters once the queued turn has actually landed.
      ...(deferred ? {} : { stats: managed.state.stats }),
    });

    const notification: SubagentNotificationInfo = {
      subagentId: config.id,
      label: config.label,
      status: outcome,
      conversationId: managed.state.conversationId,
      objective: config.objective,
      ...(outcome === "failed"
        ? { error: managed.state.error ?? "Unknown error" }
        : {}),
    };

    injectMessageIntoParent(config.parentConversationId, message, {
      subagentNotification: notification,
    });
  }
}
