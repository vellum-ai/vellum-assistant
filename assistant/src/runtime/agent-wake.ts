/**
 * Generic agent-loop wake mechanism for internal opportunities.
 *
 * Provides `wakeAgentForOpportunity()` — a callable used by subsystems
 * (e.g. meet chat-opportunity detector, scheduled tasks, memory-reducer
 * inferences) that want to invoke the agent loop without a user message.
 *
 * Semantics:
 *   - Resolves the conversation context exactly as a normal user turn.
 *   - Appends `hint` as a non-persisted internal user message visible to
 *     the LLM only — never shows up in the transcript or SSE feed.
 *     Format: `"[opportunity:${source}] ${hint}"`.
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

import type { AgentEvent, AgentLoop } from "../agent/loop.js";
import type { Message } from "../providers/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-wake");

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
}

export interface WakeOptions {
  conversationId: string;
  hint: string;
  source: string;
}

/**
 * Reason a wake returned `invoked: false`. Callers (CLI, update-bulletin
 * job) need to distinguish "conversation doesn't exist" from "conversation
 * exists but stayed busy past the wait-until-idle timeout" — the former is
 * a user-visible error, the latter is an expected transient condition.
 */
export type WakeSkipReason = "not_found" | "timeout" | "no_resolver";

export interface WakeResult {
  invoked: boolean;
  producedToolCalls: boolean;
  /** Present only when `invoked: false`; identifies why the wake was skipped. */
  reason?: WakeSkipReason;
}

/**
 * Dependencies injected for testing. Production callers can omit this
 * argument entirely and rely on a process-wide default resolver registered
 * at daemon startup via {@link registerDefaultWakeResolver}.
 */
export interface WakeDeps {
  /** Resolve the wake target for a conversationId. Returns `null` if not found. */
  resolveTarget: (conversationId: string) => Promise<WakeTarget | null>;
  /** Timestamp source (for deterministic tests). */
  now?: () => number;
}

// ── Process-wide default resolver ────────────────────────────────────
//
// PR 6 shipped `wakeAgentForOpportunity` with a required `deps` argument
// carrying an explicit `resolveTarget`. PR 7 needs to call the helper
// from code paths (e.g. `MeetSessionManager.join`) that don't know how
// to build a `WakeTarget` — the adapter that wraps a live `Conversation`
// lives in the daemon, not the skill. To avoid importing daemon code
// into `runtime/agent-wake.ts` (and the skill bundle that wires
// proactive-chat into the manager), we expose a module-level default
// resolver that the daemon installs once at startup. Callers that don't
// pass explicit `deps` fall back to it. Tests that pass explicit deps
// are unaffected — the default is never consulted when deps are
// supplied.

let _defaultResolver:
  | ((conversationId: string) => Promise<WakeTarget | null>)
  | null = null;

/**
 * Install the process-wide default resolver. Called once at daemon
 * startup (see `DaemonServer.start()`) with an adapter that looks up a
 * live {@link Conversation} and wraps it as a {@link WakeTarget}.
 *
 * Calling this more than once replaces the prior resolver — the daemon
 * startup path should call it exactly once, but tests that want to
 * exercise the default path can register a mock and reset via
 * {@link resetDefaultWakeResolverForTests}.
 */
export function registerDefaultWakeResolver(
  resolver: (conversationId: string) => Promise<WakeTarget | null>,
): void {
  _defaultResolver = resolver;
}

/**
 * Reset the process-wide default resolver. Test-only.
 *
 * @internal
 */
export function resetDefaultWakeResolverForTests(): void {
  _defaultResolver = null;
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
  // The agent loop appends assistant messages (and tool_result user
  // messages) onto the history it was given. We gave it baseline +
  // internal hint, so anything at index >= baselineLength + 1 came from
  // the run.
  const firstAssistantIndex = baselineLength + 1;
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
 * process-wide resolver registered by
 * {@link registerDefaultWakeResolver} is used. Tests that want tight
 * control over resolution continue to pass explicit deps.
 */
export async function wakeAgentForOpportunity(
  opts: WakeOptions,
  deps?: WakeDeps,
): Promise<WakeResult> {
  const { conversationId, hint, source } = opts;
  const resolveTarget = deps?.resolveTarget ?? _defaultResolver;
  if (!resolveTarget) {
    log.warn(
      { conversationId, source },
      "agent-wake: no resolver available (default resolver not registered and no deps passed); skipping",
    );
    return { invoked: false, producedToolCalls: false, reason: "no_resolver" };
  }
  const nowFn = deps?.now ?? Date.now;
  const startedAt = nowFn();

  return runSingleFlight(conversationId, async () => {
    const target = await resolveTarget(conversationId);
    if (!target) {
      log.warn(
        { conversationId, source },
        "agent-wake: conversation not found; skipping",
      );
      return { invoked: false, producedToolCalls: false, reason: "not_found" };
    }

    const idle = await waitUntilIdle(target, nowFn);
    if (!idle) {
      log.warn(
        { conversationId, source },
        "agent-wake: conversation still processing after timeout; skipping",
      );
      return { invoked: false, producedToolCalls: false, reason: "timeout" };
    }

    const baseline = target.getMessages();
    const hintContent = `[opportunity:${source}] ${hint}`;
    const hintMessage: Message = {
      role: "user",
      content: [{ type: "text", text: hintContent }],
    };
    const runInput: Message[] = [...baseline, hintMessage];

    // Buffer events during the run. If the agent produces no visible
    // output and no tool calls, we drop everything silently. If it does,
    // we flush the buffered events via the target's translation-aware
    // emitter so clients receive correctly-shaped wire frames (e.g.
    // `assistant_text_delta` with `conversationId`, not the raw
    // `text_delta` variant of `AgentEvent`).
    const buffered: AgentEvent[] = [];
    const onEvent = (event: AgentEvent): void => {
      buffered.push(event);
    };

    // Mark processing for the duration of the run so a concurrent user
    // send is queued by `enqueueMessage()` rather than spawning a second
    // concurrent agent loop on the same conversation (which would
    // interleave writes to `conversation.messages`).
    target.markProcessing(true);

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
        );
      } catch (err) {
        // Capture the error for post-finally logging, then short-circuit
        // the rest of the try body — no tail to push/persist when the
        // run threw mid-flight. The outer finally still runs to release
        // `processing` and drain the queue.
        runError = err instanceof Error ? err : new Error(String(err));
        return { invoked: true, producedToolCalls: false };
      }

      // Run completed cleanly. Inspect the tail and, if there was real
      // output, push to in-memory history + persist + flush buffered
      // events BEFORE the finally hands control to drainQueue. The
      // canonical user-turn pattern (conversation-agent-loop.ts:1860,
      // 2106-2126) updates `ctx.messages` first, then resets
      // `ctx.processing = false`, then calls `ctx.drainQueue(...)`. We
      // mirror that order here so a message queued during the wake is
      // dequeued against an already-updated history — otherwise
      // `drainSingleMessage` reads `ctx.messages` mid-tail and writes a
      // DB row that lands out of chronological order (queued user msg
      // before the wake's just-produced assistant outputs).
      const {
        tailMessages,
        hasVisibleText,
        toolUseNames: names,
      } = inspectWakeOutput(baseline.length, updatedHistory);
      toolUseNames = names;
      producedToolCalls = names.length > 0;
      const producedOutput = producedToolCalls || hasVisibleText;

      if (!producedOutput || tailMessages.length === 0) {
        // Silent no-op: drop buffered events, push nothing, persist
        // nothing, emit nothing. The finally still runs drainQueue so a
        // racy queued message isn't stranded.
        return { invoked: true, producedToolCalls: false };
      }

      tailMessageCount = tailMessages.length;

      // Output produced: flush buffered client events through the
      // target's translator. The internal hint is NOT emitted.
      for (const event of buffered) {
        try {
          target.emitAgentEvent(event);
        } catch (err) {
          log.warn(
            { conversationId, source, err },
            "agent-wake: client emitter threw; continuing",
          );
        }
      }

      // Append every tail message to live in-memory history. Without
      // this, the next turn would rebuild from DB and lose the live
      // references. Done BEFORE persist so a synchronous reader of
      // `getMessages()` sees the full conversation immediately.
      for (const msg of tailMessages) {
        target.pushMessage(msg);
      }

      // Persist every tail message (assistant outputs + tool_result
      // user messages from the loop's own tool execution). If we only
      // persisted the first assistant message, a rehydration from DB
      // would have a `tool_use` with no matching `tool_result`, which
      // the provider would reject on the next turn. Persistence is
      // delegated to the target so the daemon adapter can build
      // channel/interface metadata (`provenanceFromTrustContext` + turn
      // channel/interface contexts) and sync to the disk view, matching
      // the canonical user-turn path.
      for (const msg of tailMessages) {
        try {
          await target.persistTailMessage(msg);
        } catch (err) {
          log.warn(
            { conversationId, source, err, role: msg.role },
            "agent-wake: failed to persist wake-tail message",
          );
        }
      }

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
