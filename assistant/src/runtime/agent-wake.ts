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
import { addMessage } from "../memory/conversation-crud.js";
import type { Message } from "../providers/types.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("agent-wake");

/**
 * Minimum surface area of a conversation needed to wake it. Defined as an
 * interface rather than importing `Conversation` directly so the wake
 * helper stays decoupled from the heavyweight conversation class and is
 * easy to exercise under unit tests.
 */
export interface WakeTarget {
  readonly conversationId: string;
  readonly agentLoop: Pick<AgentLoop, "run">;
  /**
   * Live LLM-visible history. We read a snapshot, append the internal hint
   * for the run, and then (on non-empty output) append the resulting
   * assistant message to this array so subsequent turns see it.
   */
  getMessages(): Message[];
  pushMessage(message: Message): void;
  /** Client emitter — e.g. SSE. We only call this when the wake produces output. */
  emitToClient(msg: ServerMessage): void;
  /** True if the conversation is already processing a turn. */
  isProcessing(): boolean;
}

export interface WakeOptions {
  conversationId: string;
  hint: string;
  source: string;
}

export interface WakeResult {
  invoked: boolean;
  producedToolCalls: boolean;
}

/**
 * Dependencies injected for testing. Production callers use the defaults
 * (which resolve the conversation from the daemon's registry).
 */
export interface WakeDeps {
  /** Resolve the wake target for a conversationId. Returns `null` if not found. */
  resolveTarget: (conversationId: string) => Promise<WakeTarget | null>;
  /** Timestamp source (for deterministic tests). */
  now?: () => number;
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
): Promise<void> {
  const deadline = nowFn() + timeoutMs;
  // 50ms backoff is fine — wakes are not latency-critical and a user turn
  // typically completes on the order of seconds.
  while (target.isProcessing() && nowFn() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Inspect the final assistant message of the post-run history to decide
 * whether the wake produced output worth persisting/emitting.
 */
function inspectAssistantOutput(
  baselineLength: number,
  updatedHistory: Message[],
): {
  assistantMessage: Message | null;
  hasVisibleText: boolean;
  toolUseNames: string[];
} {
  // The agent loop appends assistant messages (and tool_result user
  // messages) onto the history it was given. We gave it baseline +
  // internal hint, so anything at index >= baselineLength + 1 came from
  // the run. The *first* message past the hint is the assistant reply.
  const firstAssistantIndex = baselineLength + 1;
  if (updatedHistory.length <= firstAssistantIndex) {
    return { assistantMessage: null, hasVisibleText: false, toolUseNames: [] };
  }
  const assistantMessage = updatedHistory[firstAssistantIndex];
  if (!assistantMessage || assistantMessage.role !== "assistant") {
    return { assistantMessage: null, hasVisibleText: false, toolUseNames: [] };
  }
  const blocks = Array.isArray(assistantMessage.content)
    ? assistantMessage.content
    : [];
  let hasVisibleText = false;
  const toolUseNames: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim().length > 0) {
        hasVisibleText = true;
      }
    } else if (block.type === "tool_use") {
      toolUseNames.push(block.name);
    }
  }
  return { assistantMessage, hasVisibleText, toolUseNames };
}

/**
 * Wake the agent loop on a conversation without a user message.
 *
 * See module-level doc for semantics. Safe to call concurrently; wakes
 * are serialized per `conversationId`.
 */
export async function wakeAgentForOpportunity(
  opts: WakeOptions,
  deps: WakeDeps,
): Promise<WakeResult> {
  const { conversationId, hint, source } = opts;
  const nowFn = deps.now ?? Date.now;
  const startedAt = nowFn();

  return runSingleFlight(conversationId, async () => {
    const target = await deps.resolveTarget(conversationId);
    if (!target) {
      log.warn(
        { conversationId, source },
        "agent-wake: conversation not found; skipping",
      );
      return { invoked: false, producedToolCalls: false };
    }

    await waitUntilIdle(target, nowFn);

    const baseline = target.getMessages();
    const hintContent = `[opportunity:${source}] ${hint}`;
    const hintMessage: Message = {
      role: "user",
      content: [{ type: "text", text: hintContent }],
    };
    const runInput: Message[] = [...baseline, hintMessage];

    // Buffer events during the run. If the agent produces no visible
    // output and no tool calls, we drop everything silently. If it does,
    // we flush the buffer to the client so the client sees normal
    // streaming events (deltas, tool_use, tool_result, etc.).
    const buffered: ServerMessage[] = [];
    const onEvent = (event: AgentEvent): void => {
      // AgentEvent and ServerMessage share several variants by shape.
      // The conversation's runtime normally translates AgentEvent into
      // client events via a richer handler; for wake, we buffer the raw
      // event types and forward only those that are directly
      // client-safe. Unknown types are dropped (they produce no UI).
      const ev = event as unknown as ServerMessage;
      buffered.push(ev);
    };

    let updatedHistory: Message[];
    let runError: Error | null = null;
    try {
      updatedHistory = await target.agentLoop.run(
        runInput,
        onEvent,
        undefined, // no external abort signal
        `wake:${source}`,
      );
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
      updatedHistory = runInput;
    }

    const durationMs = nowFn() - startedAt;
    if (runError) {
      log.error(
        { conversationId, source, durationMs, err: runError },
        "agent-wake: agent loop threw; treating as no-op",
      );
      return { invoked: true, producedToolCalls: false };
    }

    const { assistantMessage, hasVisibleText, toolUseNames } =
      inspectAssistantOutput(baseline.length, updatedHistory);

    const producedToolCalls = toolUseNames.length > 0;
    const producedOutput = producedToolCalls || hasVisibleText;

    if (!producedOutput || !assistantMessage) {
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
      return { invoked: true, producedToolCalls: false };
    }

    // Output produced: flush buffered client events and persist the
    // assistant message so the transcript stays consistent. The internal
    // hint is NOT persisted and NOT emitted — only the assistant reply
    // (and any downstream tool-result user messages) is.
    for (const event of buffered) {
      try {
        target.emitToClient(event);
      } catch (err) {
        log.warn(
          { conversationId, source, err },
          "agent-wake: client emitter threw; continuing",
        );
      }
    }

    // Append assistant message and any subsequent tool_result user
    // messages to live history. The hint itself stays out of history.
    for (let i = baseline.length + 1; i < updatedHistory.length; i++) {
      const msg = updatedHistory[i];
      if (msg) target.pushMessage(msg);
    }

    try {
      await addMessage(
        conversationId,
        assistantMessage.role,
        JSON.stringify(assistantMessage.content),
      );
    } catch (err) {
      log.warn(
        { conversationId, source, err },
        "agent-wake: failed to persist assistant message",
      );
    }

    log.info(
      {
        source,
        conversationId,
        durationMs,
        producedToolCalls,
        toolNamesCalled: toolUseNames,
      },
      "agent-wake: produced output",
    );

    return { invoked: true, producedToolCalls };
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
