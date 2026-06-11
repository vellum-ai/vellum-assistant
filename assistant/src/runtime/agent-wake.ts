/**
 * Generic agent-loop wake mechanism for internal opportunities.
 *
 * Provides `wakeAgentForOpportunity()` — a callable used by subsystems
 * (e.g. meet chat-opportunity detector, scheduled tasks, memory-reducer
 * inferences) that want to invoke the agent loop without a user message.
 *
 * Semantics:
 *   - Resolves the conversation context exactly as a normal user turn.
 *   - Appends `hint` as a non-persisted assistant message sandwiched
 *     between two static user messages — never shows up in the transcript
 *     or SSE feed. The assistant role prevents prompt injection (LLMs
 *     don't follow instructions in their own prior output), and the
 *     trailing user message satisfies providers that reject assistant
 *     prefill. The bookend user messages are hardcoded strings with no
 *     dynamic content, so they cannot carry injection payloads.
 *   - Invokes the agent loop with all conversation tools available unless
 *     the caller provides an explicit `allowedTools` scope.
 *   - No tool calls AND no assistant text → silent no-op (nothing persisted,
 *     nothing emitted). Returns `{ invoked: true, producedToolCalls: false }`.
 *   - Tool calls produced → normal tool execution runs (the conversation's
 *     `AgentLoop` has its tool executor already wired). Returns
 *     `{ invoked: true, producedToolCalls: true }`.
 *
 * Concurrency:
 *   - If a user turn (or another wake) is currently in flight on the same
 *     conversation, the wake is queued behind it (single-flight per
 *     `conversationId`).
 *   - While the wake's agent loop is running, the conversation is marked
 *     as processing (via the conversation's processing marker) so a user send
 *     that arrives mid-wake is queued by `enqueueMessage` instead of
 *     launching a concurrent `agentLoop.run()` on the same conversation.
 *
 * Logging:
 *   - Emits one structured log line per wake:
 *     `{ source, conversationId, durationMs, producedToolCalls, toolNamesCalled }`.
 *
 * Skill isolation:
 *   - This file lives in `assistant/src/runtime/` and is intentionally
 *     generic. It does not reference Meet or any specific skill. The Meet
 *     integration is wired up by `MeetSessionManager` (see PR 7).
 */

import type {
  AgentEvent,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { InterfaceId } from "../channels/types.js";
import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import type { Conversation } from "../daemon/conversation.js";
import { getDiskPressureStatus } from "../daemon/disk-pressure-guard.js";
import {
  classifyDiskPressureTurnPolicy,
  type DiskPressureTurnPolicyDecision,
} from "../daemon/disk-pressure-policy.js";
import type { TrustContext } from "../daemon/trust-context.js";
import {
  broadcastWakeSurface,
  emitWakeAgentEvent,
  persistWakeTailMessage,
  scopeWakeAllowedTools,
} from "../daemon/wake-conversation-ops.js";
import {
  recordCompactionEndBestEffort,
  recordCompactionStartBestEffort,
} from "../memory/compaction-log-writer-clickhouse.js";
import { getConversationOverrideProfile } from "../memory/conversation-crud.js";
import {
  buildProviderErrorResponsePayload,
  recordRequestLog,
  setAgentLoopExitReasonOnLatestLog,
} from "../memory/llm-request-log-store.js";
import type { Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-wake");

/** Static preamble user message — no dynamic content, injection-safe. */
const WAKE_PREAMBLE =
  "[system] The following assistant message comes from an external system.";

/** Static postamble user message — ends conversation on a user turn. */
const WAKE_POSTAMBLE =
  "[system] End of message from external system, continue the conversation.";

export interface WakeOptions {
  conversationId: string;
  hint: string;
  source: string;
  /**
   * Optional trust context to apply to the conversation before the agent
   * loop runs. Required for internal background jobs that need elevated
   * trust to invoke side-effect tools — without it the loop falls back to
   * `trustClass: "unknown"` and side-effect tools are blocked. Caller
   * should pass `{ sourceChannel: "vellum", trustClass: "guardian" }` for
   * assistant-self-maintenance jobs.
   */
  trustContext?: TrustContext;
  /**
   * Explicit local-owner metadata for rare direct wakes that are allowed to run
   * in cleanup mode. Omit for background jobs; they are paused under disk
   * pressure even when they otherwise carry internal guardian trust.
   */
  sourceChannel?: TrustContext["sourceChannel"];
  sourceInterface?: InterfaceId | "vellum";
  /**
   * LLM call site to route this wake through. Defaults to `"mainAgent"` so
   * conversation wakes share the user's chat-model selection. Background jobs
   * (e.g. memory consolidation) pass their own call site so operators can
   * tune the model/profile and observability bucket independently.
   */
  callSite?: LLMCallSite;
  /**
   * Role to use for the injected hint message. Defaults to `"assistant"` so
   * the hint is sandwiched between two static user bookends — the canonical
   * anti-injection pattern for hints that may carry text from an external
   * source. Trusted internal callers (e.g. fork-based memory retrospectives)
   * can pass `"user"` to inject a single user-role message containing the
   * hint directly, which reads more naturally as an instruction from the
   * user/system rather than a self-directed assistant note.
   */
  hintRole?: "assistant" | "user";
  /**
   * Documented intent: this wake must not trigger auto-threshold compaction.
   *
   * Today this is automatically satisfied because the wake invokes
   * `conversation.agentLoop.run()` directly, bypassing the daemon orchestrator
   * (`conversation-agent-loop.ts`) where the compaction pipeline lives. The
   * flag is recorded in the wake's structured log line so operators can
   * verify the contract holds across refactors. If compaction is ever moved
   * into `AgentLoop.run` or invoked from the wake path, callers that pass
   * `true` here MUST be updated to suppress it; callers that pass `false`
   * (or omit it) MUST tolerate compaction firing.
   *
   * Used by fork-based memory retrospectives: the wake operates on a
   * freshly-forked conversation that may already be near (or past) the
   * source's auto-threshold, but the goal is to operate on that exact
   * context — running a compaction LLM call before the wake's own first
   * call would waste tokens and defeat prompt-cache reuse.
   */
  suppressAutoCompaction?: boolean;
  /**
   * Skip injection of the hint sandwich entirely. Used when the caller has
   * already persisted the instruction as a real message in the conversation
   * (e.g. fork-based memory retrospectives that append a user message to the
   * forked conversation before waking). When `true`, `hint` is ignored.
   */
  skipHintInjection?: boolean;
  /**
   * Skip injection of the "Conversation Woke" `ui_surface` card into the
   * first assistant tail message and the corresponding live
   * `onWakeProducedOutput` broadcast. Default false (existing behavior).
   * Used by callers whose conversation context already makes it obvious
   * that the agent's output came from a wake (e.g. fork-based memory
   * retrospectives whose conversation title already says "(Retrospective)").
   */
  suppressWakeSurface?: boolean;
  /**
   * Optional exact tool allowlist for this wake. Used by internal maintenance
   * jobs that need the assistant's judgment but must not execute arbitrary
   * side-effect tools.
   */
  allowedTools?: readonly string[];
}

/**
 * Reason a wake returned `invoked: false`. Callers (CLI, update-bulletin
 * job) need to distinguish "conversation doesn't exist" from "conversation
 * exists but stayed busy past the wait-until-idle timeout" — the former is
 * a user-visible error, the latter is an expected transient condition.
 */
export type WakeSkipReason =
  | "not_found"
  | "archived"
  | "timeout"
  | "no_resolver"
  | "disk_pressure";

export interface WakeResult {
  invoked: boolean;
  producedToolCalls: boolean;
  /** Present only when `invoked: false`; identifies why the wake was skipped. */
  reason?: WakeSkipReason;
}

/**
 * Dependencies injected for testing. Production callers can omit this
 * argument entirely and rely on the built-in default resolver.
 */
export interface WakeDeps {
  /**
   * Resolve the live {@link Conversation} for a wake invocation.
   * Returns `null` if the conversation doesn't exist, `"archived"` if it
   * exists but is archived, or the `Conversation` to proceed with the wake.
   *
   * Receives the full {@link WakeOptions} so the default resolver can
   * thread `trustContext` into `getOrCreateConversation`. Without that
   * threading, the conversation hydrates with `trustContext === undefined`
   * and `loadFromDb` fail-closes to `trustClass: "unknown"`, which filters
   * out every guardian-provenance message — fatal for fork-based memory
   * retrospectives.
   */
  resolveTarget: (
    opts: WakeOptions,
  ) => Promise<Conversation | null | "archived">;
  /** Timestamp source (for deterministic tests). */
  now?: () => number;
}

// ── Default resolution ────────────────────────────────────────────────
//
// When `wakeAgentForOpportunity()` is called without explicit `deps`,
// it resolves the live conversation directly via `getConversation` and
// `getOrCreateConversation`.

async function defaultResolveTarget(
  opts: WakeOptions,
): Promise<Conversation | null | "archived"> {
  const { conversationId } = opts;
  // Lazy-import daemon modules to avoid pulling heavyweight transitive
  // deps (conversation store → config/loader → provider catalogs) at
  // module-evaluation time.  Callers that only import agent-wake for
  // the types or for explicit-deps usage (tests, shell tools) never
  // trigger these imports.
  const { getConversation } = await import("../memory/conversation-crud.js");
  const { getOrCreateConversation } =
    await import("../daemon/conversation-store.js");
  try {
    const existing = getConversation(conversationId);
    if (!existing) return null;
    if (existing.archivedAt != null) {
      log.info(
        { conversationId },
        "agent-wake: conversation is archived; rejecting wake",
      );
      return "archived";
    }
    // Thread trustContext through to getOrCreateConversation so the
    // hydration path applies setTrustContext + ensureActorScopedHistory
    // (conversation-store.ts:281-289) BEFORE the agent loop's per-turn
    // snapshot reads. Without this, fork-based memory retrospectives see
    // an empty history because loadFromDb ran with trustClass="unknown"
    // and filtered out every guardian-provenance message.
    const conversation = await getOrCreateConversation(conversationId, {
      trustContext: opts.trustContext,
    });
    return conversation;
  } catch (err) {
    log.warn(
      { err, conversationId },
      "agent-wake: failed to hydrate conversation",
    );
    return null;
  }
}

// ── Per-conversation single-flight lock ───────────────────────────────
//
// Simple promise-chain map. When a wake arrives and another run is in
// flight, we chain onto its tail so the wake runs *after* the current
// work completes. Using the tail promise avoids awaiting every prior
// completion in the chain (only the last one matters) and keeps memory
// bounded — the map entry is cleared once the chain completes.

const wakeChain = new Map<string, Promise<void>>();

async function runSingleFlight<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = wakeChain.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Install our tail *before* awaiting so later callers chain behind us.
  wakeChain.set(conversationId, next);
  try {
    await prior;
    return await fn();
  } finally {
    // Only clear the map entry if nothing chained behind us in the meantime.
    if (wakeChain.get(conversationId) === next) {
      wakeChain.delete(conversationId);
    }
    release();
  }
}

/**
 * Small helper: if a conversation reports `isProcessing()`, poll briefly
 * so we don't try to start a second agent loop concurrently. We rely
 * primarily on the single-flight chain above to serialize *wakes*; this
 * extra check catches the case where a user turn started independently
 * while our wake was queued.
 */
async function waitUntilIdle(
  conversation: Conversation,
  nowFn: () => number,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = nowFn() + timeoutMs;
  while (conversation.isProcessing() && nowFn() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !conversation.isProcessing();
}

function classifyWakeDiskPressurePolicy(opts: WakeOptions): {
  decision: DiskPressureTurnPolicyDecision;
  status: ReturnType<typeof getDiskPressureStatus>;
} {
  const status = getDiskPressureStatus();
  const decision = classifyDiskPressureTurnPolicy(status, {
    conversationSource: opts.source,
    callSite: opts.callSite ?? "mainAgent",
    isDirectWake: true,
    sourceChannel: opts.sourceChannel ?? opts.trustContext?.sourceChannel,
    sourceInterface: opts.sourceInterface,
    trustContext: opts.trustContext
      ? {
          sourceChannel: opts.trustContext.sourceChannel,
          trustClass: opts.trustContext.trustClass,
        }
      : null,
  });
  return { decision, status };
}

/**
 * Trust snapshot the wake hands to the agent loop. A wake has no compaction
 * path (it runs with overflow recovery disabled), so this snapshot is unread
 * except on the disk-pressure cleanup-mode path, whose guardian value scopes
 * the compactor's image manifest if cleanup ever compacts. Other wakes pass an
 * `unknown`-class snapshot so a missing actor cannot grant elevated trust.
 */
function buildWakeTrust(
  opts: WakeOptions,
  decision: DiskPressureTurnPolicyDecision,
): TrustContext {
  if (decision.action !== "allow-cleanup-mode") {
    return {
      sourceChannel: opts.sourceChannel ?? "vellum",
      trustClass: "unknown",
    };
  }
  return (
    opts.trustContext ??
    ({
      sourceChannel: opts.sourceChannel ?? "vellum",
      trustClass: "guardian",
    } satisfies TrustContext)
  );
}

/**
 * Inspect the post-run history slice to decide whether the wake produced
 * output worth persisting/emitting, and collect any tool-use names from
 * the *first* assistant reply (used only for logging).
 */
function inspectWakeOutput(
  baselineLength: number,
  hintMessageCount: number,
  updatedHistory: Message[],
): {
  tailMessages: Message[];
  hasVisibleText: boolean;
  toolUseNames: string[];
} {
  // The agent loop appends messages onto the history it was given. We
  // injected `hintMessageCount` hint messages (0, 1, or 3 depending on
  // hint mode), so anything at index >= baselineLength + hintMessageCount
  // came from the run.
  const firstAssistantIndex = baselineLength + hintMessageCount;
  if (updatedHistory.length <= firstAssistantIndex) {
    return { tailMessages: [], hasVisibleText: false, toolUseNames: [] };
  }
  const tailMessages = updatedHistory.slice(firstAssistantIndex);

  // Scan every tail message for visible text or tool_use blocks. A
  // multi-step run (assistant → tool_result → assistant) still counts as
  // "produced output" when the final assistant message is just a summary
  // — we must persist the entire tail so the DB mirrors in-memory
  // history.
  let hasVisibleText = false;
  const toolUseNames: string[] = [];
  for (const msg of tailMessages) {
    if (msg.role !== "assistant") continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trim().length > 0) {
          hasVisibleText = true;
        }
      } else if (block.type === "tool_use") {
        toolUseNames.push(block.name);
      }
    }
  }
  return { tailMessages, hasVisibleText, toolUseNames };
}

/**
 * Wake the agent loop on a conversation without a user message.
 *
 * See module-level doc for semantics. Safe to call concurrently; wakes
 * are serialized per `conversationId`.
 *
 * The `deps` argument is optional in production — when omitted, the
 * default resolver imports `getConversation` and
 * `getOrCreateConversation` directly to return the live conversation.
 * Tests that want tight control over resolution continue to pass
 * explicit deps.
 */
export async function wakeAgentForOpportunity(
  opts: WakeOptions,
  deps?: WakeDeps,
): Promise<WakeResult> {
  const { conversationId, hint, source } = opts;
  const resolveTarget = deps?.resolveTarget ?? defaultResolveTarget;
  const nowFn = deps?.now ?? Date.now;
  const startedAt = nowFn();

  return runSingleFlight(conversationId, async () => {
    const resolved = await resolveTarget(opts);
    if (resolved === "archived") {
      log.info(
        { conversationId, source },
        "agent-wake: conversation is archived; skipping",
      );
      return {
        invoked: false,
        producedToolCalls: false,
        reason: "archived" as const,
      };
    }
    if (!resolved) {
      log.warn(
        { conversationId, source },
        "agent-wake: conversation not found; skipping",
      );
      return { invoked: false, producedToolCalls: false, reason: "not_found" };
    }
    const conversation = resolved;

    const { decision: diskPressureDecision, status: diskPressureStatus } =
      classifyWakeDiskPressurePolicy(opts);
    if (diskPressureDecision.action === "block") {
      log.warn(
        {
          conversationId,
          source,
          reason: "disk_pressure",
          diskPressureReason: diskPressureDecision.reason,
          thresholdPercent: diskPressureStatus.thresholdPercent,
          usagePercent: diskPressureStatus.usagePercent,
          blockedCapability: "background-work",
          lockId: diskPressureStatus.lockId,
          path: diskPressureStatus.path,
        },
        "agent-wake: blocked by disk pressure cleanup mode",
      );
      return {
        invoked: false,
        producedToolCalls: false,
        reason: "disk_pressure" as const,
      };
    }

    const idle = await waitUntilIdle(conversation, nowFn);
    if (!idle) {
      log.warn(
        { conversationId, source },
        "agent-wake: conversation still processing after timeout; skipping",
      );
      return { invoked: false, producedToolCalls: false, reason: "timeout" };
    }

    // Apply caller-supplied trust before the agent loop reads its per-turn
    // snapshot. Background jobs without an inbound message use this to
    // declare guardian trust so side-effect tools clear the approval gate.
    if (opts.trustContext) {
      conversation.setTrustContext(opts.trustContext);
    }

    const baseline = conversation.getMessages();
    // Snapshot the baseline length BEFORE the run starts. Incremental
    // persistence pushes onto `conversation.messages` mid-run, which grows the
    // live history array `baseline` aliases. Reading `baseline.length`
    // post-run would therefore include the tail we just pushed and the
    // tail-slice math would skip every message.
    const baselineLength = baseline.length;
    const wakeTrust = buildWakeTrust(opts, diskPressureDecision);
    // Build the hint injection. Three modes:
    //   - `skipHintInjection`: caller has already persisted an instruction
    //     message into the conversation history (typical for fork-based
    //     memory retrospectives that append a user message before waking).
    //   - `hintRole === "user"`: single user-role message containing the
    //     hint directly. Used by trusted internal callers where the hint
    //     reads naturally as an instruction.
    //   - default (`hintRole === "assistant"`): sandwich the hint as an
    //     assistant message between two hardcoded user bookends. The
    //     assistant role defangs prompt injection (LLMs don't follow
    //     instructions in their own prior output) and the trailing user
    //     message satisfies providers that reject assistant prefill.
    const hintRole = opts.hintRole ?? "assistant";
    const wakeMessages: Message[] = opts.skipHintInjection
      ? []
      : hintRole === "user"
        ? [
            {
              role: "user",
              content: [{ type: "text", text: hint }],
            },
          ]
        : [
            {
              role: "user",
              content: [{ type: "text", text: WAKE_PREAMBLE }],
            },
            {
              role: "assistant",
              content: [
                { type: "text", text: `[opportunity:${source}] ${hint}` },
              ],
            },
            {
              role: "user",
              content: [{ type: "text", text: WAKE_POSTAMBLE }],
            },
          ];
    const wakeHintMessageCount = wakeMessages.length;
    const runInput: Message[] = [...baseline, ...wakeMessages];

    // Event handling runs in two modes. While `mode === "buffering"`,
    // events accumulate in `buffered` so that a wake which ultimately
    // produces nothing leaves no trace. As soon as we have evidence the
    // wake is producing output (first `onCheckpoint` after a tool turn,
    // or — for tool-free wakes — post-run inspection finds visible text),
    // we transition to `"live"`: flush the buffer, inject the ui_surface
    // card, and from that point forward emit each event directly so a
    // long-running wake (e.g. memory consolidation, often 5-30 minutes
    // and many turns) is observable in real time instead of materializing
    // only after `agentLoop.run()` returns.
    let mode: "buffering" | "live" = "buffering";
    const buffered: AgentEvent[] = [];
    // LLM request logs accumulated while buffering. Persisted only if the
    // wake transitions to live (i.e. produced output). A silent no-op wake
    // drops them — otherwise the next user-turn's `backfillMessageIdOnLogs`
    // sweep would misattach these NULL-messageId rows to an unrelated
    // future assistant message, contaminating inspector context.
    type PendingLog = {
      rawRequest: unknown;
      rawResponse: unknown;
      provider?: string;
    };
    const pendingLogs: PendingLog[] = [];
    // Exit reason deferred alongside pendingLogs. Same drop-on-silent-
    // wake guarantee: if the wake never goes live, this stays null and
    // no DB row is touched. Applied after pendingLogs flush in goLive
    // so the latest-row lookup in `setAgentLoopExitReasonOnLatestLog`
    // can see the freshly-persisted final usage row.
    let pendingExitReason: string | null = null;
    const persistLog = (record: PendingLog): void => {
      try {
        recordRequestLog(
          conversationId,
          JSON.stringify(record.rawRequest),
          JSON.stringify(record.rawResponse),
          undefined,
          record.provider,
          "mainAgent",
        );
      } catch (err) {
        log.warn(
          { err, conversationId, source },
          "agent-wake: failed to persist LLM request log (non-fatal)",
        );
      }
    };
    const persistExitReason = (reason: string): void => {
      try {
        setAgentLoopExitReasonOnLatestLog(conversationId, reason);
      } catch (err) {
        log.warn(
          { err, conversationId, source, reason },
          "agent-wake: failed to persist agent_loop_exit_reason (non-fatal)",
        );
      }
    };
    const safeEmit = (event: AgentEvent): void => {
      try {
        emitWakeAgentEvent(conversation, event);
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: client emitter threw; continuing",
        );
      }
    };
    const onEvent = (event: AgentEvent): void => {
      // Compaction logging is observability, not turn state, so it writes
      // immediately even while buffering — a compaction during a silent
      // (never-goes-live) wake still happened and should be recorded.
      if (event.type === "context_compacting") {
        recordCompactionStartBestEffort(conversationId, event);
      }
      if (event.type === "compaction_completed") {
        recordCompactionEndBestEffort(conversationId, event);
      }
      // Replicates the recordRequestLog side-effect in `handleUsage` because
      // wakes own their own onEvent and never reach `dispatchAgentEvent`.
      // Defer persistence while buffering — see `pendingLogs` above.
      if (event.type === "usage" && event.rawRequest && event.rawResponse) {
        const record = {
          rawRequest: event.rawRequest,
          rawResponse: event.rawResponse,
          provider: event.actualProvider,
        };
        if (mode === "buffering") {
          pendingLogs.push(record);
        } else {
          persistLog(record);
        }
      }
      // Mirror the same recording side-effect for provider-rejected calls.
      // `handleProviderError` in the daemon dispatcher persists these on the
      // normal turn path; the wake path owns its own onEvent and bypasses
      // that dispatcher entirely, so we replicate here. Buffering rules
      // match the success path: if the wake never goes live (silent no-op),
      // the rows are dropped so a stale `messageId IS NULL` row doesn't get
      // mis-backfilled onto an unrelated future assistant message.
      if (event.type === "provider_error") {
        const record: PendingLog = {
          rawRequest: event.rawRequest,
          rawResponse: buildProviderErrorResponsePayload(event.error),
          provider: event.actualProvider,
        };
        if (mode === "buffering") {
          pendingLogs.push(record);
        } else {
          persistLog(record);
        }
      }
      // Replicates the setAgentLoopExitReasonOnLatestLog side-effect that
      // `dispatchAgentEvent` does for the normal path. In live mode the
      // final usage event of the run has already landed its row, so the
      // latest-row lookup hits the right target. In buffering mode the
      // reason is stashed and applied in `goLive` after pendingLogs are
      // persisted, preserving the same ordering guarantee.
      if (event.type === "agent_loop_exit") {
        if (mode === "buffering") {
          pendingExitReason = event.reason;
        } else {
          persistExitReason(event.reason);
        }
      }
      if (mode === "buffering") {
        buffered.push(event);
        return;
      }
      safeEmit(event);
    };

    const wakeSurfaceId = `wake-${conversationId}-${nowFn()}`;
    let surfaceInjected = false;
    let persistedTailIndex = 0;

    // Transition from buffered to live emission. Idempotent — only the
    // first call has an effect. Mutates the first assistant message in
    // the tail to prepend the ui_surface block, emits the live
    // ui_surface event, then drains the buffered events through
    // `emitWakeAgentEvent`. The translator is what stamps `conversationId`
    // and renames `text_delta` → `assistant_text_delta`; bypassing it
    // would ship malformed wire frames.
    const goLive = (currentHistory: Message[]): void => {
      if (mode === "live") return;
      if (!surfaceInjected) {
        if (!opts.suppressWakeSurface) {
          const tailStart = baselineLength + wakeHintMessageCount;
          const tail = currentHistory.slice(tailStart);
          const firstAssistant = tail.find((m) => m.role === "assistant");
          if (firstAssistant && Array.isArray(firstAssistant.content)) {
            firstAssistant.content.unshift({
              type: "ui_surface",
              surfaceId: wakeSurfaceId,
              surfaceType: "card",
              title: "Conversation Woke",
              data: {
                title: "Conversation Woke",
                body: hint,
                metadata: [{ label: "Source", value: source }],
              },
              display: "inline",
            } as never);
          }
        }
        surfaceInjected = true;
      }
      if (!opts.suppressWakeSurface) {
        try {
          broadcastWakeSurface(conversation, source, hint, wakeSurfaceId);
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: broadcastWakeSurface threw; continuing",
          );
        }
      }
      for (const event of buffered) {
        safeEmit(event);
      }
      buffered.length = 0;
      for (const record of pendingLogs) {
        persistLog(record);
      }
      pendingLogs.length = 0;
      // Apply the deferred exit reason after pendingLogs are persisted —
      // the latest-row lookup in `setAgentLoopExitReasonOnLatestLog`
      // needs the final usage row to already exist. Cleared after use so
      // an extremely unlikely double-goLive can't double-stamp.
      if (pendingExitReason !== null) {
        persistExitReason(pendingExitReason);
        pendingExitReason = null;
      }
      mode = "live";
    };

    // Push + persist any tail messages produced since the last call.
    // Pushes precede persists across the whole batch (matching the
    // canonical post-run ordering) so a queued user message draining
    // mid-flush still sees a consistent in-memory history before any DB
    // row lands. The persist guard mirrors the original post-run loop —
    // a single message persistence failure logs and continues so we
    // don't strand the rest of the tail.
    const flushPendingTail = async (
      currentHistory: Message[],
    ): Promise<void> => {
      const start = baselineLength + wakeHintMessageCount + persistedTailIndex;
      if (start >= currentHistory.length) return;
      const newMessages = currentHistory.slice(start);
      for (const msg of newMessages) {
        conversation.messages.push(msg);
      }
      for (const msg of newMessages) {
        try {
          await persistWakeTailMessage(conversation, msg);
        } catch (err) {
          log.warn(
            { conversationId, source, err, role: msg.role },
            "agent-wake: failed to persist wake-tail message",
          );
        }
      }
      persistedTailIndex += newMessages.length;
    };

    // Honor the conversation's pinned inference-profile override (if any).
    // Without this, scheduled-task wakes and other opportunity wakes bypass
    // `runAgentLoopImpl` entirely and execute under workspace defaults,
    // silently violating the user's pinned preference. Resolve the effective
    // context budget here as well because wakes bypass the normal user-turn
    // path that computes it for tool-result truncation. Read before
    // `setProcessing(true)` so a thrown DB/config read can't strand the
    // processing flag.
    const overrideProfile = getConversationOverrideProfile(conversationId);
    const callSite = opts.callSite ?? "mainAgent";
    const config = getConfig();
    const effectiveContextWindow = resolveEffectiveContextWindow({
      llm: config.llm,
      callSite,
      overrideProfile,
    });

    let wakeToolScopeRestored = false;
    let restoreWakeToolScope: (() => void) | null = null;
    const restoreWakeAllowedTools = (): void => {
      if (wakeToolScopeRestored) return;
      wakeToolScopeRestored = true;
      if (!restoreWakeToolScope) return;
      try {
        restoreWakeToolScope();
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: failed to restore tool allowlist; continuing",
        );
      }
    };
    const applyWakeAllowedTools = (): boolean => {
      if (!opts.allowedTools) return true;
      try {
        restoreWakeToolScope = scopeWakeAllowedTools(
          conversation,
          new Set(opts.allowedTools),
        );
        return true;
      } catch (err) {
        log.warn(
          { conversationId, source, allowedTools: opts.allowedTools, err },
          "agent-wake: failed to apply requested tool allowlist; skipping",
        );
        return false;
      }
    };

    // Mark processing for the duration of the run so a concurrent user
    // send is queued by `enqueueMessage()` rather than spawning a second
    // concurrent agent loop on the same conversation (which would
    // interleave writes to `conversation.messages`). This happens before
    // applying a wake-scoped tool allowlist so a concurrent user turn cannot
    // start under the wake's restricted tool set.
    conversation.setProcessing(true);

    // Fires after each tool-execution turn finalizes (assistant message
    // + matching tool_result user message both in history). A single
    // tool turn is unambiguous evidence of output — promote to live
    // mode and persist what's been produced so far so a client opening
    // the conversation mid-run can fetchHistory and see real content
    // instead of the empty-state welcome view.
    const onCheckpoint = async (
      checkpoint: CheckpointInfo,
    ): Promise<CheckpointDecision> => {
      goLive(checkpoint.history);
      await flushPendingTail(checkpoint.history);
      return "continue";
    };

    let runError: Error | null = null;
    let producedToolCalls = false;
    let toolUseNames: string[] = [];
    let tailMessageCount = 0;
    let drainedInTry = false;
    try {
      if (!applyWakeAllowedTools()) {
        return {
          invoked: false,
          producedToolCalls: false,
          reason: "no_resolver" as const,
        };
      }

      let updatedHistory: Message[];
      try {
        ({ history: updatedHistory } = await conversation.agentLoop.run({
          messages: runInput,
          onEvent,
          requestId: `wake:${source}`,
          onCheckpoint,
          // Route through the caller-supplied call site (defaults to
          // `mainAgent` so a normal user-turn wake shares the user's chat
          // selection). Without an explicit callSite, the resolver in
          // `RetryProvider` and the routing in `CallSiteRoutingProvider`
          // short-circuit and silently drop both per-callsite config and the
          // pinned `overrideProfile` below.
          callSite,
          trust: wakeTrust,
          overrideProfile,
          // Wake runs have no orchestrator-side mid-loop compaction path,
          // so the budget gate stays disabled (`overflowRecovery.enabled =
          // false`); `maxInputTokens` is still supplied for tool-result
          // truncation.
          resolveContextWindow: () => ({
            maxInputTokens: effectiveContextWindow.maxInputTokens,
            overflowRecovery: { enabled: false, safetyMarginRatio: 0 },
          }),
        }));
      } catch (err) {
        // Capture the error for post-finally logging, then short-circuit
        // the rest of the try body — no tail to push/persist when the
        // run threw mid-flight. The outer finally still runs to release
        // `processing` and drain the queue.
        runError = err instanceof Error ? err : new Error(String(err));
        return { invoked: true, producedToolCalls: false };
      }

      // Run completed cleanly. The canonical user-turn pattern
      // (conversation-agent-loop.ts:1860, 2106-2126) updates
      // `ctx.messages` first, then clears the flag via `ctx.setProcessing(false)`, then
      // calls `ctx.drainQueue(...)`. We mirror that order so a message
      // queued during the wake dequeues against an already-updated
      // history — otherwise `drainSingleMessage` reads `ctx.messages`
      // mid-tail and writes a DB row that lands out of chronological
      // order (queued user msg before the wake's just-produced assistant
      // outputs).
      const {
        tailMessages,
        hasVisibleText,
        toolUseNames: names,
      } = inspectWakeOutput(
        baselineLength,
        wakeHintMessageCount,
        updatedHistory,
      );
      toolUseNames = names;
      producedToolCalls = names.length > 0;
      const producedOutput = producedToolCalls || hasVisibleText;

      if (!producedOutput || tailMessages.length === 0) {
        // Silent no-op: drop buffered events, push nothing, persist
        // nothing, emit nothing. (No checkpoint fired during the run
        // since checkpoints only fire after tool turns and there were
        // none.) The finally still runs drainQueue so a racy queued
        // message isn't stranded.
        return { invoked: true, producedToolCalls: false };
      }

      tailMessageCount = tailMessages.length;

      // Tool-free wakes (assistant text only, no tool calls) don't fire
      // any checkpoint, so we still need a one-shot transition here.
      // For checkpoint-driven wakes, goLive() / flushPendingTail() are
      // both idempotent — the post-run call picks up only the final
      // assistant message that came after the last checkpoint.
      goLive(updatedHistory);
      await flushPendingTail(updatedHistory);

      // Drain queued messages AFTER tail is pushed + persisted so the
      // next dequeued user message sees the complete, up-to-date
      // history. setProcessing(false) must come first (the queue only
      // accepts entries while processing === true, and drain expects
      // processing to already be false). The finally block handles the
      // error/early-return paths where no tail was produced.
      restoreWakeAllowedTools();
      try {
        conversation.setProcessing(false);
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: setProcessing(false) threw; continuing",
        );
      }
      try {
        await conversation.drainQueue();
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: drainQueue threw; continuing",
        );
      }
      drainedInTry = true;

      return { invoked: true, producedToolCalls };
    } finally {
      // The success path (above) already called setProcessing(false)
      // + drainQueue after tail persist. This catch-all handles the
      // error and early-return paths where no tail was produced — those
      // exit the try body before reaching the drain block, so
      // `drainedInTry` is still false.
      if (!drainedInTry) {
        restoreWakeAllowedTools();
        try {
          conversation.setProcessing(false);
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: setProcessing(false) threw; continuing",
          );
        }
        try {
          await conversation.drainQueue();
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: drainQueue threw; continuing",
          );
        }
      }

      const durationMs = nowFn() - startedAt;
      const suppressAutoCompaction = opts.suppressAutoCompaction === true;
      const suppressWakeSurface = opts.suppressWakeSurface === true;
      if (runError) {
        log.error(
          {
            conversationId,
            source,
            durationMs,
            suppressAutoCompaction,
            suppressWakeSurface,
            hintRole,
            err: runError,
          },
          "agent-wake: agent loop threw; treating as no-op",
        );
      } else if (tailMessageCount === 0) {
        log.info(
          {
            source,
            conversationId,
            durationMs,
            suppressAutoCompaction,
            suppressWakeSurface,
            hintRole,
            producedToolCalls: false,
            toolNamesCalled: [],
          },
          "agent-wake: no output; silent no-op",
        );
      } else {
        log.info(
          {
            source,
            conversationId,
            durationMs,
            suppressAutoCompaction,
            suppressWakeSurface,
            hintRole,
            producedToolCalls,
            toolNamesCalled: toolUseNames,
            tailMessageCount,
          },
          "agent-wake: produced output",
        );
      }
    }
  });
}

// ── Test-only helpers ────────────────────────────────────────────────

/**
 * Reset the internal single-flight map. Exported for tests that want a
 * clean slate between cases. Not part of the public API — do not call
 * from production code.
 *
 * @internal
 */
export function __resetWakeChainForTests(): void {
  wakeChain.clear();
}
