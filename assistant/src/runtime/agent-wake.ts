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
 *   - Invokes the agent loop with all conversation tools available.
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
 *     as processing (via {@link WakeTarget.markProcessing}) so a user send
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
  AgentLoop,
  CheckpointDecision,
  CheckpointInfo,
} from "../agent/loop.js";
import type { InterfaceId } from "../channels/types.js";
import { resolveEffectiveContextWindow } from "../config/llm-context-resolution.js";
import { getConfig } from "../config/loader.js";
import { getDiskPressureStatus } from "../daemon/disk-pressure-guard.js";
import {
  classifyDiskPressureTurnPolicy,
  type DiskPressureTurnPolicyDecision,
} from "../daemon/disk-pressure-policy.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { getConversationOverrideProfile } from "../memory/conversation-crud.js";
import { recordRequestLog } from "../memory/llm-request-log-store.js";
import type { TurnContext } from "../plugins/types.js";
import type { Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-wake");

/** Number of messages injected for the wake hint (user + assistant + user). */
const WAKE_HINT_MESSAGE_COUNT = 3;

/** Static preamble user message — no dynamic content, injection-safe. */
const WAKE_PREAMBLE =
  "[system] The following assistant message comes from an external system.";

/** Static postamble user message — ends conversation on a user turn. */
const WAKE_POSTAMBLE =
  "[system] End of message from external system, continue the conversation.";

/**
 * Minimum surface area of a conversation needed to wake it. Defined as an
 * interface rather than importing `Conversation` directly so the wake
 * helper stays decoupled from the heavyweight conversation class and is
 * easy to exercise under unit tests.
 *
 * Translation note: the wake deliberately hands the adapter a raw
 * {@link AgentEvent} via {@link emitAgentEvent} rather than a
 * `ServerMessage`. The normal user-turn path translates `AgentEvent` into
 * the correctly-shaped wire protocol frames (e.g.
 * `text_delta` → `assistant_text_delta` with `conversationId`) via the
 * canonical handler in `conversation-agent-loop-handlers.ts`. Passing raw
 * events means the adapter can reuse that translation rather than the
 * wake helper shipping malformed frames.
 */
export interface WakeTarget {
  readonly conversationId: string;
  readonly agentLoop: Pick<AgentLoop, "run">;
  /**
   * Live LLM-visible history. We read a snapshot, append the internal hint
   * for the run, and then (on non-empty output) append the resulting
   * assistant message(s) to this array so subsequent turns see them.
   */
  getMessages(): Message[];
  pushMessage(message: Message): void;
  /**
   * Forward a raw agent event so the adapter can translate it to the
   * correct `ServerMessage` shape (e.g. stamping `conversationId`,
   * renaming `text_delta` → `assistant_text_delta`) before emission.
   *
   * Only called when the wake produces output worth emitting — silent
   * no-op wakes never flush buffered events.
   */
  emitAgentEvent(event: AgentEvent): void;
  /** True if the conversation is already processing a turn. */
  isProcessing(): boolean;
  /**
   * Toggle the conversation's in-flight processing marker. The wake
   * wraps its `agentLoop.run()` invocation in
   * `markProcessing(true) … markProcessing(false)` so a concurrent user
   * send sees `isProcessing() === true` and queues the message instead
   * of spawning a parallel agent loop.
   */
  markProcessing(on: boolean): void;
  /**
   * Persist a single tail message produced by the wake (assistant
   * outputs and intervening tool_result user messages). The daemon
   * adapter is responsible for building channel/interface metadata and
   * syncing the persisted message to the disk view so wake-produced
   * messages match the canonical user-turn persistence path. Kept as a
   * hook so `runtime/agent-wake.ts` stays decoupled from daemon
   * internals (trust context, turn channel/interface contexts,
   * disk-view layout).
   */
  persistTailMessage(message: Message): Promise<void>;
  /**
   * Drain any messages that arrived (and were queued) while the wake
   * was running. Optional because not every wake target has a queue —
   * unit-test stubs typically omit it.
   *
   * The wake invokes this in its `finally` block AFTER
   * `markProcessing(false)`. Order matters: if drain ran while
   * processing was still true, `enqueueMessage`'s gate
   * (`if (!ctx.processing) return ...`) would still see processing=true
   * and the drain itself would be a no-op against any racy late sends.
   * Running drain after processing is released matches the canonical
   * user-turn finally path in `conversation-agent-loop.ts`.
   */
  drainQueue?(): Promise<void>;
  /**
   * Called after a wake produces visible output (text or tool calls).
   * The daemon adapter uses this to emit a live SSE event so connected
   * clients see the wake indicator immediately. The `surfaceId` matches
   * the `ui_surface` content block already injected into the first
   * assistant tail message — both must share the same ID so the client
   * doesn't render duplicates. Optional because unit-test stubs
   * typically omit it.
   */
  onWakeProducedOutput?(source: string, hint: string, surfaceId: string): void;
  /**
   * Apply a trust context to the underlying conversation before the agent
   * loop runs. Internal background jobs (memory consolidation, update
   * bulletin) use this to declare guardian trust so side-effect tools
   * (file_edit, file_write, bash) clear the approval gate. Inbound message
   * conversations populate trust via `processMessage()` and don't pass
   * `trustContext` through the wake.
   */
  setTrustContext?(ctx: TrustContext): void;
}

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
   * Resolve the wake target for a conversationId.
   * Returns `null` if the conversation doesn't exist, `"archived"` if it
   * exists but is archived, or a `WakeTarget` to proceed with the wake.
   */
  resolveTarget: (
    conversationId: string,
  ) => Promise<WakeTarget | null | "archived">;
  /** Timestamp source (for deterministic tests). */
  now?: () => number;
}

// ── Default resolution ────────────────────────────────────────────────
//
// When `wakeAgentForOpportunity()` is called without explicit `deps`,
// it resolves the target directly by importing `getConversation`,
// `getOrCreateConversation`, and `conversationToWakeTarget`.

async function defaultResolveTarget(
  conversationId: string,
): Promise<WakeTarget | null | "archived"> {
  // Lazy-import daemon modules to avoid pulling heavyweight transitive
  // deps (conversation store → config/loader → provider catalogs) at
  // module-evaluation time.  Callers that only import agent-wake for
  // the types or for explicit-deps usage (tests, shell tools) never
  // trigger these imports.
  const { getConversation } = await import("../memory/conversation-crud.js");
  const { getOrCreateConversation } =
    await import("../daemon/conversation-store.js");
  const { conversationToWakeTarget } =
    await import("../daemon/wake-target-adapter.js");
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
    const conversation = await getOrCreateConversation(conversationId);
    return conversationToWakeTarget(conversation);
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
  target: WakeTarget,
  nowFn: () => number,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = nowFn() + timeoutMs;
  while (target.isProcessing() && nowFn() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !target.isProcessing();
}

function classifyWakeDiskPressurePolicy(opts: WakeOptions): {
  decision: DiskPressureTurnPolicyDecision;
  status: ReturnType<typeof getDiskPressureStatus>;
} {
  const status = getDiskPressureStatus();
  const decision = classifyDiskPressureTurnPolicy(status, {
    conversationSource: opts.source,
    callSite: "mainAgent",
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

function buildWakeTurnContext(
  opts: WakeOptions,
  decision: DiskPressureTurnPolicyDecision,
): TurnContext | undefined {
  if (decision.action !== "allow-cleanup-mode") return undefined;
  return {
    requestId: `wake:${opts.source}`,
    conversationId: opts.conversationId,
    turnIndex: 0,
    trust:
      opts.trustContext ??
      ({
        sourceChannel: opts.sourceChannel ?? "vellum",
        trustClass: "guardian",
      } satisfies TrustContext),
    injectionInputs: {
      diskPressureContext: { cleanupModeActive: true },
    },
  };
}

/**
 * Inspect the post-run history slice to decide whether the wake produced
 * output worth persisting/emitting, and collect any tool-use names from
 * the *first* assistant reply (used only for logging).
 */
function inspectWakeOutput(
  baselineLength: number,
  updatedHistory: Message[],
): {
  tailMessages: Message[];
  hasVisibleText: boolean;
  toolUseNames: string[];
} {
  // The agent loop appends messages onto the history it was given. We
  // injected 3 hint messages (user preamble + assistant hint + user
  // postamble), so anything at index >= baselineLength + 3 came from
  // the run.
  const firstAssistantIndex = baselineLength + WAKE_HINT_MESSAGE_COUNT;
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
 * default resolver imports `getConversation`, `getOrCreateConversation`,
 * and `conversationToWakeTarget` directly. Tests that want tight
 * control over resolution continue to pass explicit deps.
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
    const resolved = await resolveTarget(conversationId);
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
    const target = resolved;

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

    const idle = await waitUntilIdle(target, nowFn);
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
    if (opts.trustContext && target.setTrustContext) {
      target.setTrustContext(opts.trustContext);
    }

    const baseline = target.getMessages();
    // Snapshot the baseline length BEFORE the run starts. Incremental
    // persistence calls `target.pushMessage` mid-run, which grows the
    // live history array `baseline` aliases. Reading `baseline.length`
    // post-run would therefore include the tail we just pushed and the
    // tail-slice math would skip every message.
    const baselineLength = baseline.length;
    const wakeTurnContext = buildWakeTurnContext(opts, diskPressureDecision);
    const hintContent = `[opportunity:${source}] ${hint}`;
    // Sandwich the hint as an assistant message between two hardcoded
    // user messages. The assistant role prevents prompt injection — LLMs
    // don't follow instructions in their own prior output. The trailing
    // user message satisfies providers that reject assistant prefill
    // (conversation must end on a user turn). Both user messages are
    // static strings with no dynamic content so they cannot carry
    // injection payloads.
    const wakeMessages: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: WAKE_PREAMBLE }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: hintContent }],
      },
      {
        role: "user",
        content: [{ type: "text", text: WAKE_POSTAMBLE }],
      },
    ];
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
    const safeEmit = (event: AgentEvent): void => {
      try {
        target.emitAgentEvent(event);
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: client emitter threw; continuing",
        );
      }
    };
    const onEvent = (event: AgentEvent): void => {
      // Replicates the recordRequestLog side-effect in `handleUsage` because
      // wakes own their own onEvent and never reach `dispatchAgentEvent`.
      if (event.type === "usage" && event.rawRequest && event.rawResponse) {
        try {
          recordRequestLog(
            conversationId,
            JSON.stringify(event.rawRequest),
            JSON.stringify(event.rawResponse),
            undefined,
            event.actualProvider,
          );
        } catch (err) {
          log.warn(
            { err, conversationId, source },
            "agent-wake: failed to persist LLM request log (non-fatal)",
          );
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
    // ui_surface event, then drains the buffered events through the
    // target's translator. The translator is what stamps `conversationId`
    // and renames `text_delta` → `assistant_text_delta`; bypassing it
    // would ship malformed wire frames.
    const goLive = (currentHistory: Message[]): void => {
      if (mode === "live") return;
      if (!surfaceInjected) {
        const tailStart = baselineLength + WAKE_HINT_MESSAGE_COUNT;
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
        surfaceInjected = true;
      }
      if (target.onWakeProducedOutput) {
        try {
          target.onWakeProducedOutput(source, hint, wakeSurfaceId);
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: onWakeProducedOutput threw; continuing",
          );
        }
      }
      for (const event of buffered) {
        safeEmit(event);
      }
      buffered.length = 0;
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
      const start =
        baselineLength + WAKE_HINT_MESSAGE_COUNT + persistedTailIndex;
      if (start >= currentHistory.length) return;
      const newMessages = currentHistory.slice(start);
      for (const msg of newMessages) {
        target.pushMessage(msg);
      }
      for (const msg of newMessages) {
        try {
          await target.persistTailMessage(msg);
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
    // `markProcessing(true)` so a thrown DB/config read can't strand the
    // processing flag.
    const overrideProfile = getConversationOverrideProfile(conversationId);
    const config = getConfig();
    const effectiveContextWindow = resolveEffectiveContextWindow({
      llm: config.llm,
      callSite: "mainAgent",
      overrideProfile,
    });

    // Mark processing for the duration of the run so a concurrent user
    // send is queued by `enqueueMessage()` rather than spawning a second
    // concurrent agent loop on the same conversation (which would
    // interleave writes to `conversation.messages`).
    target.markProcessing(true);

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
      let updatedHistory: Message[];
      try {
        updatedHistory = await target.agentLoop.run(
          runInput,
          onEvent,
          undefined, // no external abort signal
          `wake:${source}`,
          onCheckpoint,
          // Route through `mainAgent` — same as a normal user turn on this
          // conversation. Without an explicit callSite, the resolver in
          // `RetryProvider` and the routing in `CallSiteRoutingProvider`
          // short-circuit and silently drop both `llm.callSites.mainAgent`
          // config and the pinned `overrideProfile` below.
          "mainAgent",
          wakeTurnContext,
          overrideProfile,
          effectiveContextWindow.maxInputTokens,
        );
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
      // `ctx.messages` first, then resets `ctx.processing = false`, then
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
      } = inspectWakeOutput(baselineLength, updatedHistory);
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
      // history. markProcessing(false) must come first (the queue only
      // accepts entries while processing === true, and drain expects
      // processing to already be false). The finally block handles the
      // error/early-return paths where no tail was produced.
      try {
        target.markProcessing(false);
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: markProcessing(false) threw; continuing",
        );
      }
      if (target.drainQueue) {
        try {
          await target.drainQueue();
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: drainQueue threw; continuing",
          );
        }
      }
      drainedInTry = true;

      return { invoked: true, producedToolCalls };
    } finally {
      // The success path (above) already called markProcessing(false)
      // + drainQueue after tail persist. This catch-all handles the
      // error and early-return paths where no tail was produced — those
      // exit the try body before reaching the drain block, so
      // `drainedInTry` is still false.
      if (!drainedInTry) {
        try {
          target.markProcessing(false);
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: markProcessing(false) threw; continuing",
          );
        }
        if (target.drainQueue) {
          try {
            await target.drainQueue();
          } catch (err) {
            log.warn(
              { conversationId, source, err },
              "agent-wake: drainQueue threw; continuing",
            );
          }
        }
      }

      const durationMs = nowFn() - startedAt;
      if (runError) {
        log.error(
          { conversationId, source, durationMs, err: runError },
          "agent-wake: agent loop threw; treating as no-op",
        );
      } else if (tailMessageCount === 0) {
        log.info(
          {
            source,
            conversationId,
            durationMs,
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
