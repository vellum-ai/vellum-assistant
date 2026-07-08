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

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { Conversation } from "../daemon/conversation.js";
import {
  findConversation,
  removeSubagentConversation,
  setSubagentConversation,
} from "../daemon/conversation-registry.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { bootstrapConversation } from "../persistence/conversation-bootstrap.js";
import {
  deleteSubagentRecord,
  loadAllSubagentRecords,
  upsertSubagentRecord,
} from "../persistence/subagent-store.js";
import { wrapWithCallSiteRouting } from "../providers/call-site-routing.js";
import { resolveDefaultProvider } from "../providers/connection-resolution.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import { listProviders } from "../providers/registry.js";
import type { Message, TextContent } from "../providers/types.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import { getSandboxWorkingDir } from "../util/platform.js";
import { injectMessageIntoParent } from "./notify.js";
import {
  SUBAGENT_LIMITS,
  SUBAGENT_ROLE_REGISTRY,
  type SubagentConfig,
  type SubagentRole,
  type SubagentState,
  type SubagentStatus,
  TERMINAL_STATUSES,
} from "./types.js";

const log = getLogger("subagent-manager");

/** How long to keep terminal subagent metadata after the live conversation is released (ms). */
const TERMINAL_RETENTION_MS = 30 * 60 * 1000; // 30 minutes
/** How often to sweep expired terminal entries (ms). */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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
 * Pull the user-visible text out of a streaming delta event, or null for any
 * other event type. Used by the synchronous `onText` tap to forward
 * `assistant_text_delta` / `assistant_thinking_delta` chunks to the caller.
 */
function extractDeltaText(msg: ServerMessage): string | null {
  if (msg.type === "assistant_text_delta") {
    return msg.text;
  }
  if (msg.type === "assistant_thinking_delta") {
    return msg.thinking;
  }
  return null;
}

// ── Default subagent system prompt ──────────────────────────────────────

function buildSubagentSystemPrompt(
  config: SubagentConfig,
  role: SubagentRole,
): string {
  const roleConfig = SUBAGENT_ROLE_REGISTRY[role];
  const sections: string[] = [
    roleConfig.systemPromptPreamble,
    "",
    "## Your Task",
    config.objective,
  ];
  if (config.context) {
    sections.push("", "## Context from Parent", config.context);
  }
  sections.push(
    "",
    "## Constraints",
    `- Role: ${role}`,
    "- You cannot spawn nested subagents.",
    "- Use notify_parent to report important findings or if you are blocked.",
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
  } = opts;
  const prefix = isFork ? "Fork" : "Subagent";

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
        : `(Incorporate this into your reply to the user as appropriate.)`)
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
    (silent ? ` Keep the result internal.` : ``)
  );
}

// ── Manager ─────────────────────────────────────────────────────────────

interface ManagedSubagent {
  /** Live conversation — null after the subagent reaches a terminal state and is released. */
  conversation: Conversation | null;
  state: SubagentState;
  /** Mutable reference to the parent's current sendToClient. Updated on reconnect. */
  parentSendToClient: (msg: ServerMessage) => void;
  /** Epoch ms after which this terminal entry can be removed by the TTL sweep. */
  retainedUntil?: number;
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
    parentSendToClient: (msg: ServerMessage) => void,
  ): Promise<string> {
    const { subagentId } = await this.setUpSubagent(config, parentSendToClient);

    // ── Kick off the agent loop (fire-and-forget) ───────────────────
    this.runSubagent(subagentId, config.objective).catch((err) => {
      log.error({ subagentId, err }, "Subagent run failed unexpectedly");
    });

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
    parentSendToClient: (msg: ServerMessage) => void,
    opts?: { synchronous?: boolean; onText?: (chunk: string) => void },
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
    const isFork = config.fork === true;
    const role: SubagentRole = (config.role as SubagentRole) ?? "general";
    if (isFork && role !== "general") {
      // A context-inheriting subagent normally keeps the parent's `general`
      // role so its KV cache stays aligned with the parent conversation. An
      // explicit non-general role opts out of that alignment on purpose
      // (e.g. the advisor role running on a stronger profile), so honor it.
      log.warn(
        {
          requestedRole: role,
          parentConversationId: config.parentConversationId,
          label: config.label,
        },
        "Fork requested with non-general role — caller opted out of parent KV-cache alignment",
      );
    }
    if (!SUBAGENT_ROLE_REGISTRY[role]) {
      throw new Error(
        `Invalid subagent role "${config.role}". Must be one of: ${Object.keys(SUBAGENT_ROLE_REGISTRY).join(", ")}`,
      );
    }
    const roleConfig = SUBAGENT_ROLE_REGISTRY[role];

    // ── Create conversation ─────────────────────────────────────────
    const subagentId = uuid();
    const conversationRecord = await bootstrapConversation({
      conversationType: "background",
      source: "subagent",
      origin: "subagent",
      systemHint: `Subagent: ${config.label}`,
    });

    // ── Build conversation dependencies ─────────────────────────────
    const appConfig = getConfig();
    // Connection-aware default-provider resolution. Throws
    // `ConnectionResolutionError` if `llm.default.provider_connection` is
    // unset or the connection row is missing/mismatched (config bugs).
    // Returns null on soft credential failures (missing credential,
    // platform auth unavailable).
    const baseProvider = await resolveDefaultProvider(appConfig);
    if (!baseProvider) {
      const resolved = resolveCallSiteConfig("mainAgent", appConfig.llm);
      throw new ProviderNotConfiguredError(resolved.provider, listProviders(), {
        connectionName: resolved.provider_connection,
      });
    }
    // Per-call `options.config.callSite` (e.g. `subagentSpawn`) can resolve
    // to a profile that differs from `llm.default`. The shared wrapper
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
      // Forks default to the parent's system prompt verbatim — no subagent
      // preamble — so the KV cache stays aligned with the parent. An explicit
      // `systemPromptOverride` opts out of that alignment and takes precedence
      // (e.g. the advisor role framing the inherited context as advice).
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
    };

    // Wrap sendToClient to envelope all events with the subagent ID.
    // Reads from managed.parentSendToClient so reconnects are picked up.
    const wrappedSendToClient = (msg: ServerMessage): void => {
      // Tap streaming text/thinking deltas for the synchronous caller (if any),
      // in addition to the normal envelope below. Reads from managed.onText so
      // the synchronous path can forward chunks without altering event routing.
      if (managed.onText) {
        const text = extractDeltaText(msg);
        if (text) {
          managed.onText(text);
        }
      }
      managed.parentSendToClient({
        type: "subagent_event",
        subagentId,
        conversationId: config.parentConversationId,
        event: msg,
      } as ServerMessage);
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
        // The advisor consult runs tool-less for CLIENT tools but should ground
        // its guidance with provider-native web search when the resolved
        // provider supports it. This is a server tool the provider runs itself,
        // so it stays one-shot — no client tool surfaced, allowlist unchanged.
        // Other roles keep the default (no native search appended).
        ...(role === "advisor" ? { enableNativeWebSearch: true } : {}),
      },
    );

    // Mark conversation as having no direct client — it routes through parent.
    // This ensures interactive prompts (host attachment reads) fail fast.
    conversation.updateClient(wrappedSendToClient, true);
    // Subagents are created as background conversations (see the
    // `bootstrapConversation` call above) and never call `loadFromDb`, so cache
    // the type on the live conversation directly for the runtime-assembly path.
    conversation.conversationType = "background";

    // Subagents execute as background child conversations, but their tool
    // permissions must still be scoped to the actor that spawned them. Without
    // this, tool execution falls back to `unknown` trust and guardian-owned
    // desktop turns get denied as unverified.
    if (parentConversation?.trustContext) {
      conversation.setTrustContext({ ...parentConversation.trustContext });
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

    // Apply the role's tool allowlist when one is defined. The `general` role
    // has `allowedTools: undefined`, so default forks (which keep the general
    // role) are unaffected; a fork carrying an explicit role gets its
    // allowlist applied like any other subagent.
    if (roleConfig.allowedTools) {
      conversation.setSubagentAllowedTools(new Set(roleConfig.allowedTools));
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
    const labelKey = `${config.parentConversationId}:${config.label.toLowerCase().trim()}`;
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
    } as ServerMessage);

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
    parentSendToClient: (msg: ServerMessage) => void,
    opts?: { signal?: AbortSignal; onText?: (chunk: string) => void },
  ): Promise<string> {
    const { subagentId, managed } = await this.setUpSubagent(
      config,
      parentSendToClient,
      { synchronous: true, ...(opts?.onText ? { onText: opts.onText } : {}) },
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
      const finalText = await this.runSubagent(subagentId, config.objective);
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
      // pivoting to the task — the inherited context is louder than a bare
      // objective buried after 100k+ tokens of chat history.
      //
      // The advisor consult is the exception: it is a fork, but its
      // `systemPromptOverride` already frames the inherited context as advice
      // ("you are a senior advisor … do not write its final deliverable"), so
      // the generic "complete this task and return your findings" wrapper would
      // fight that framing. The advisor's objective is already the bare advice
      // request (`advisorRequestText()`), so it is sent uncontested.
      const useForkFraming =
        managed.state.isFork && managed.state.config.role !== "advisor";
      const message = useForkFraming
        ? [
            "⎯⎯⎯ FORK TASK ⎯⎯⎯",
            "You have been forked from the parent conversation to execute a specific task.",
            "The conversation above is context — do NOT continue it. Do NOT spawn sub-agents.",
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
      });

      // Agent loop completed successfully.
      // Capture the trailing assistant text before any release nulls the
      // conversation reference. The fire-and-forget caller ignores the return.
      finalText = extractFinalAssistantText(conversation.messages);
      // Copy usage stats from the conversation before sending status (which includes usage).
      managed.state.usage = { ...conversation.usageStats };
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
          this.notifyParentTerminal(managed, "completed", finalText);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      managed.state.error = errorMsg;
      managed.state.completedAt = Date.now();
      // Copy usage from the captured conversation reference — managed.conversation
      // may have been nulled by an external dispose() before catch runs.
      managed.state.usage = { ...conversation.usageStats };

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
    parentSendToClient?: (msg: ServerMessage) => void,
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
   * Abort all subagents belonging to a parent conversation.
   * Called when the parent conversation is aborted or evicted.
   */
  abortAllForParent(
    parentConversationId: string,
    parentSendToClient?: (msg: ServerMessage) => void,
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

    // Dispose all children — the parent conversation is going away so nobody
    // will call subagent_read.  Use snapshot since dispose mutates the set.
    for (const childId of [...children]) {
      this.dispose(childId);
    }

    return count;
  }

  // ── Send message to subagent ──────────────────────────────────────────

  async sendMessage(
    subagentId: string,
    content: string,
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

  getByLabel(
    label: string,
    parentConversationId: string,
  ): SubagentState | undefined {
    const key = `${parentConversationId}:${label.toLowerCase().trim()}`;
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

  /** Total number of active (non-terminal) subagents. */
  get activeCount(): number {
    return [...this.subagents.values()].filter(
      (s) => !TERMINAL_STATUSES.has(s.state.status),
    ).length;
  }

  /**
   * Update the parent sender for all active children of a conversation and
   * re-emit each child's current status to it. Called when the parent client
   * reconnects to a new socket, so a reconnecting client resyncs any status it
   * missed while disconnected (e.g. a subagent marked `interrupted` during
   * rehydration after a daemon restart, whose card would otherwise stay stuck
   * on a stale `running`).
   */
  updateParentSender(
    parentConversationId: string,
    newSendToClient: (msg: ServerMessage) => void,
  ): void {
    const children = this.parentToChildren.get(parentConversationId);
    if (!children) {
      return;
    }

    for (const childId of children) {
      const managed = this.subagents.get(childId);
      if (!managed) {
        continue;
      }
      if (!TERMINAL_STATUSES.has(managed.state.status)) {
        managed.parentSendToClient = newSendToClient;
      }
      // Re-emit the current status so the reconnecting client corrects any card
      // it left in a stale state while disconnected.
      newSendToClient({
        type: "subagent_status_changed",
        subagentId: childId,
        status: managed.state.status,
        error: managed.state.error,
        usage: managed.state.usage,
      } as ServerMessage);
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

    // Drop the durable record too — but only during normal operation. On
    // shutdown we keep rows so a subagent that was in flight can rehydrate as
    // `interrupted` on the next boot.
    if (!this.shuttingDown) {
      try {
        deleteSubagentRecord(subagentId);
      } catch (err) {
        log.warn({ subagentId, err }, "Failed to delete subagent record");
      }
    }

    // Remove from label index only if it still maps to this subagent
    // (guards against stale delete when a newer subagent reused the label).
    const label = managed.state.config.label;
    const parentConvId = managed.state.config.parentConversationId;
    const labelKey = `${parentConvId}:${label.toLowerCase().trim()}`;
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
        role: state.config.role ?? "general",
        isFork: state.isFork,
        sendResultToUser: state.config.sendResultToUser ?? null,
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
   * Best-effort and idempotent: a second restart re-reads `interrupted` rows
   * and leaves them unchanged.
   */
  rehydrateFromDb(): { rehydrated: number; interrupted: number } {
    const records = loadAllSubagentRecords();
    let interrupted = 0;
    const now = Date.now();
    for (const rec of records) {
      const wasInFlight = !TERMINAL_STATUSES.has(rec.status as SubagentStatus);
      const status: SubagentStatus = wasInFlight
        ? "interrupted"
        : (rec.status as SubagentStatus);
      if (wasInFlight) {
        interrupted++;
      }

      const state: SubagentState = {
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
        },
        status,
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

      const managed: ManagedSubagent = {
        conversation: null,
        state,
        parentSendToClient: () => {},
        retainedUntil: now + TERMINAL_RETENTION_MS,
      };
      this.subagents.set(rec.id, managed);

      const labelKey = `${rec.parentConversationId}:${rec.label.toLowerCase().trim()}`;
      this.labelIndex.set(labelKey, rec.id);

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
    parentSendToClient: (msg: ServerMessage) => void,
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
    } as ServerMessage);

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
  ): void {
    const { config } = managed.state;
    const isFork = managed.state.isFork;
    // Forks default to internal/silent unless explicitly shared; regular
    // subagents share with the user unless explicitly silenced.
    const silent = isFork
      ? config.sendResultToUser !== true
      : config.sendResultToUser === false;

    const message = buildSubagentTerminalMessage({
      label: config.label,
      subagentId: config.id,
      isFork,
      outcome,
      silent,
      finalText,
      error: managed.state.error,
      // A queued follow-up turn means the snapshot we hold is stale; defer to a
      // read pointer so the parent picks up the queued turn's output instead.
      deferred: managed.hadEnqueuedMessages === true,
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
