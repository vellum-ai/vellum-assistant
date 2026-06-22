import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
} from "../../adapter";
import {
  ensureRunArtifacts,
  readRunMetadata,
  readTranscript,
  readUsage,
} from "../../metrics";
import type { Profile } from "../../profile";
import type { Simulator, SimulatorDecision } from "../../simulator/types";
import type { TestDef } from "../../test-def";
import { AgentEventCollector } from "../event-collector";

// `createAgent` lives behind the species switch in `../create-agent`.
// We mock it here so the hatch-failure regression below can hand
// `runEvalOnce` a throwing `BaseAgent` stub without standing up a real
// vellum/hermes container. `nextAgent` is set per-test in `describe`
// blocks that need it; tests above this point don't touch it.
let nextAgent: BaseAgent | null = null;
mock.module("../create-agent", () => ({
  createAgent: (input: AgentHatchInput): BaseAgent => {
    if (!nextAgent) {
      throw new Error(
        `test forgot to set nextAgent before runEvalOnce reached createAgent (runId=${input.runId})`,
      );
    }
    return nextAgent;
  },
}));

// Import-under-test goes AFTER `mock.module` so `run-once.ts`'s
// import-time reference to `createAgent` resolves to the stub above.
import {
  assistantContent,
  collectAndPersistEvents,
  markErrorAsReportedToProgress,
  runEvalOnce,
  wasErrorReportedToProgress,
} from "../run-once";
import type { EvalProgressEvent } from "../progress";

function event(message: AgentEvent["message"]): AgentEvent {
  return { message };
}

/**
 * Each adapter owns the "which events carry assistant transcript text"
 * decision at its own boundary: the Vellum adapter normalizes its live SSE
 * stream via `normalizeVellumEventStream`, while the Hermes adapter
 * synthesizes a single `message_chunk` per single-shot turn. By the time an
 * event reaches `assistantContent`, the adapter has either kept `text`/
 * `chunk` set (transcript) or cleared them (everything else), so this getter
 * is intentionally trivial. The adapter-side behavior is covered in
 * `lib/__tests__/vellum-adapter.test.ts` and
 * `lib/__tests__/hermes-adapter.test.ts`.
 */
describe("assistantContent (trivial getter)", () => {
  test("returns text when set", () => {
    expect(
      assistantContent(event({ type: "assistant_text_delta", text: "hello" })),
    ).toBe("hello");
  });

  test("returns chunk when text is absent", () => {
    expect(
      assistantContent(event({ type: "message_chunk", chunk: "world" })),
    ).toBe("world");
  });

  test("prefers text over chunk when both are set", () => {
    expect(
      assistantContent(
        event({
          type: "message_chunk",
          text: "from-text",
          chunk: "from-chunk",
        }),
      ),
    ).toBe("from-text");
  });

  test("returns undefined when both text and chunk are absent", () => {
    // After adapter-side normalization, non-transcript events arrive
    // here with `text`/`chunk` cleared — even if the underlying event
    // type would otherwise have carried a stringy payload.
    expect(
      assistantContent(event({ type: "user_message_echo" })),
    ).toBeUndefined();
    expect(
      assistantContent(event({ type: "message_complete" })),
    ).toBeUndefined();
  });
});

/**
 * Finite async iterator that yields the given events and then completes.
 * `AgentEventCollector.collectUntilQuiet` breaks immediately on
 * `iterator.next()` returning `{ done: true }`, so each collector created
 * over one of these iterators drains in milliseconds — no 5s `quietMs`
 * wait. This is the test-only analogue of a "turn" worth of events.
 */
function streamIterator(events: AgentEvent[]): AsyncIterator<AgentEvent> {
  async function* generator(): AsyncIterable<AgentEvent> {
    for (const event of events) yield event;
  }
  return generator()[Symbol.asyncIterator]();
}

async function freshRunId(name: string): Promise<string> {
  const runId = `test-collect-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await ensureRunArtifacts(runId);
  return runId;
}

function usageEvent(usage: Record<string, unknown>): AgentEvent {
  return { message: { type: "usage", usage } };
}

function textEvent(text: string): AgentEvent {
  return { message: { type: "assistant_text_delta", text } };
}

function toolUseEvent(): AgentEvent {
  // Adapter normalization strips text/chunk from non-transcript events;
  // tool-use events therefore reach the collector with neither field set.
  return { message: { type: "tool_use_start" } };
}

function messageCompleteEvent(): AgentEvent {
  return { message: { type: "message_complete" } };
}

/**
 * Shared turn-completion args for `collectAndPersistEvents` calls. The
 * finite `streamIterator` streams used here end on `{done: true}`, so
 * collection returns as soon as the stream drains regardless of whether
 * a `message_complete` event appeared.
 */
function turnCompletionArgs() {
  return {
    isTurnComplete: (event: AgentEvent) =>
      event.message.type === "message_complete",
    maxMs: 1_000,
  };
}

/**
 * Behaviour tests for the cross-turn persistence shape of
 * `collectAndPersistEvents`. These pin the bug fixes from PR #31348
 * review feedback so the regressions cannot return silently:
 *
 *   - Codex bot + Devin bot + Vargas: usage must not be double-counted
 *     across turns. The cumulative `assistantEvents` array is the source
 *     of truth; the write is an overwrite, not a merge with the on-disk
 *     summary.
 *
 *   - Devin bot: a zero-`transcriptTurnCount` window is NOT a hard error
 *     on its own. Tool-use-only responses produce events without text
 *     deltas and must continue to drive the run. Only `eventCount === 0`
 *     (the stream delivered nothing within the run budget) is a real
 *     pipeline failure — and that's enforced one layer up in
 *     `runEvalOnce`, by reading the `eventCount` field this function
 *     returns.
 */
describe("collectAndPersistEvents", () => {
  test("rewrites usage with the cumulative summary across turns (no double-count)", async () => {
    const runId = await freshRunId("usage-no-double");
    const assistantEvents: AgentEvent[] = [];

    // Turn 1: assistant emits one usage record (100 input / 50 output).
    const turn1 = new AgentEventCollector(
      streamIterator([
        usageEvent({
          provider: "anthropic",
          model: "claude-haiku-4-5",
          input_tokens: 100,
          output_tokens: 50,
        }),
      ]),
    );
    const turn1Result = await collectAndPersistEvents({
      runId,
      collector: turn1,
      assistantEvents,
      includeInTranscript: true,
      ...turnCompletionArgs(),
    });
    const afterTurn1 = await readUsage(runId);

    expect(turn1Result.eventCount).toBe(1);
    expect(afterTurn1.requests).toHaveLength(1);
    expect(afterTurn1.totalInputTokens).toBe(100);
    expect(afterTurn1.totalOutputTokens).toBe(50);

    // Turn 2: assistant emits a second usage record (200 input / 100 output).
    // Under the broken `mergeUsageSummaries(existingUsage, eventUsage)`
    // call the merged value would be turn-1 + (turn-1 + turn-2) = the
    // turn-1 row counted twice. The fix overwrites with the cumulative
    // summary, so the persisted state is just turn-1 + turn-2.
    const turn2 = new AgentEventCollector(
      streamIterator([
        usageEvent({
          provider: "anthropic",
          model: "claude-haiku-4-5",
          input_tokens: 200,
          output_tokens: 100,
        }),
      ]),
    );
    const turn2Result = await collectAndPersistEvents({
      runId,
      collector: turn2,
      assistantEvents,
      includeInTranscript: true,
      ...turnCompletionArgs(),
    });
    const afterTurn2 = await readUsage(runId);

    expect(turn2Result.eventCount).toBe(1);
    expect(afterTurn2.requests).toHaveLength(2);
    expect(afterTurn2.totalInputTokens).toBe(300);
    expect(afterTurn2.totalOutputTokens).toBe(150);

    // Turn 3: third record. Same invariant — totals reflect the sum of
    // all three rows, no row counted twice.
    const turn3 = new AgentEventCollector(
      streamIterator([
        usageEvent({
          provider: "anthropic",
          model: "claude-haiku-4-5",
          input_tokens: 400,
          output_tokens: 200,
        }),
      ]),
    );
    await collectAndPersistEvents({
      runId,
      collector: turn3,
      assistantEvents,
      includeInTranscript: true,
      ...turnCompletionArgs(),
    });
    const afterTurn3 = await readUsage(runId);

    expect(afterTurn3.requests).toHaveLength(3);
    expect(afterTurn3.totalInputTokens).toBe(700);
    expect(afterTurn3.totalOutputTokens).toBe(350);
  });

  test("returns eventCount and transcriptTurnCount for a text-only response", async () => {
    const runId = await freshRunId("text-only");
    const assistantEvents: AgentEvent[] = [];
    const collector = new AgentEventCollector(
      streamIterator([textEvent("hello"), textEvent("world")]),
    );

    const result = await collectAndPersistEvents({
      runId,
      collector,
      assistantEvents,
      includeInTranscript: true,
      ...turnCompletionArgs(),
    });

    expect(result.eventCount).toBe(2);
    expect(result.transcriptTurnCount).toBe(2);
    const transcript = await readTranscript(runId);
    expect(transcript.map((t) => t.content)).toEqual(["hello", "world"]);
  });

  test("returns transcriptTurnCount: 0 for tool-use-only events without throwing", async () => {
    // Regression for the over-strict throw added in PR #31348: a turn
    // whose events are all tool-use (no text/chunk after adapter
    // normalization) is a legitimate response. The function must report
    // `eventCount > 0` and `transcriptTurnCount === 0`; the caller can
    // then decide not to throw.
    const runId = await freshRunId("tool-use-only");
    const assistantEvents: AgentEvent[] = [];
    const collector = new AgentEventCollector(
      streamIterator([toolUseEvent(), toolUseEvent(), toolUseEvent()]),
    );

    const result = await collectAndPersistEvents({
      runId,
      collector,
      assistantEvents,
      includeInTranscript: true,
      ...turnCompletionArgs(),
    });

    expect(result.eventCount).toBe(3);
    expect(result.transcriptTurnCount).toBe(0);
    expect(await readTranscript(runId)).toEqual([]);
  });

  test("returns eventCount: 0 when the stream produces no events", async () => {
    // The caller-side throw in `runEvalOnce` keys off `eventCount === 0`.
    // A genuinely empty window means the assistant event pipeline went
    // silent — distinct from the tool-use-only case above.
    const runId = await freshRunId("empty");
    const assistantEvents: AgentEvent[] = [];
    const collector = new AgentEventCollector(streamIterator([]));

    const result = await collectAndPersistEvents({
      runId,
      collector,
      assistantEvents,
      includeInTranscript: true,
      ...turnCompletionArgs(),
    });

    expect(result.eventCount).toBe(0);
    expect(result.turnCompleted).toBe(false);
    expect(result.transcriptTurnCount).toBe(0);
  });

  test("reports turnCompleted and persists events trailing the completion signal", async () => {
    // GIVEN a stream where the turn-completion event is followed by a
    // trailing usage record (the daemon emits usage after
    // message_complete)
    const runId = await freshRunId("turn-complete");
    const assistantEvents: AgentEvent[] = [];
    const collector = new AgentEventCollector(
      streamIterator([
        textEvent("done!"),
        messageCompleteEvent(),
        usageEvent({
          provider: "anthropic",
          model: "claude-haiku-4-5",
          input_tokens: 10,
          output_tokens: 5,
        }),
      ]),
    );

    // WHEN the turn is collected
    const result = await collectAndPersistEvents({
      runId,
      collector,
      assistantEvents,
      includeInTranscript: true,
      ...turnCompletionArgs(),
    });

    // THEN the completion signal is reported AND the trailing usage
    // event is still captured and summarized
    expect(result.turnCompleted).toBe(true);
    expect(result.eventCount).toBe(3);
    const usage = await readUsage(runId);
    expect(usage.totalInputTokens).toBe(10);
    expect(usage.totalOutputTokens).toBe(5);
  });

  test("invokes onEvent for every collected event", async () => {
    // GIVEN a stream with a confirmation_request before the completion
    // signal (the hook is how the runner routes tool confirmations to
    // the simulator in a headless hatch)
    const runId = await freshRunId("on-event");
    const assistantEvents: AgentEvent[] = [];
    const collector = new AgentEventCollector(
      streamIterator([
        { message: { type: "confirmation_request", requestId: "req-1" } },
        messageCompleteEvent(),
      ]),
    );
    const seen: string[] = [];

    // WHEN the turn is collected with an onEvent hook
    await collectAndPersistEvents({
      runId,
      collector,
      assistantEvents,
      includeInTranscript: true,
      ...turnCompletionArgs(),
      onEvent: (event) => {
        seen.push(event.message.type);
      },
    });

    // THEN the hook observed every event in stream order
    expect(seen).toEqual(["confirmation_request", "message_complete"]);
  });

  test("skips transcript writes when includeInTranscript is false", async () => {
    const runId = await freshRunId("no-transcript");
    const assistantEvents: AgentEvent[] = [];
    const collector = new AgentEventCollector(
      streamIterator([textEvent("would-not-appear")]),
    );

    const result = await collectAndPersistEvents({
      runId,
      collector,
      assistantEvents,
      includeInTranscript: false,
      ...turnCompletionArgs(),
    });

    expect(result.eventCount).toBe(1);
    expect(result.transcriptTurnCount).toBe(0);
    expect(await readTranscript(runId)).toEqual([]);
  });
});

/**
 * Minimal `BaseAgent` stub that throws on `hatch()` and tracks whether
 * `shutdown()` was invoked. Used by the regression test below to verify
 * that the catch + finally blocks in `runEvalOnce` see the throw — pre-
 * fix, `agent.hatch()` lived outside the try, so neither block ran.
 */
function throwingHatchAgent(input: AgentHatchInput): {
  agent: BaseAgent;
  shutdownCalls: number[];
} {
  const tracker = { count: 0 };
  const agent: BaseAgent = {
    id: input.runId ?? "throwing-agent",
    conversationKey: `evals:test:${input.runId ?? "throwing-agent"}`,
    async hatch(): Promise<void> {
      throw new Error("simulated post-hatch failure (e.g. jail apply)");
    },
    async send(_message: AgentMessage): Promise<void> {
      throw new Error("unreachable: hatch already threw");
    },
    async runSetupCommand(): Promise<void> {
      throw new Error("unreachable: hatch already threw");
    },
    events(): AsyncIterable<AgentEvent> {
      throw new Error("unreachable: hatch already threw");
    },
    isTurnComplete(): boolean {
      throw new Error("unreachable: hatch already threw");
    },
    async shutdown(): Promise<void> {
      tracker.count += 1;
    },
  };
  return {
    agent,
    get shutdownCalls() {
      return [tracker.count];
    },
  };
}

function fakeProfile(id: string): Profile {
  return {
    id,
    manifest: { species: "vellum", description: `desc for ${id}` },
    workspaceDir: `/tmp/${id}`,
  };
}

function fakeTestDef(id: string): TestDef {
  return {
    id,
    specPath: `/tmp/${id}/SPEC.md`,
    setupPath: `/tmp/${id}/setup.ts`,
    setupCommands: [],
    metricsDir: `/tmp/${id}/metrics`,
    metricPaths: [],
  };
}

/**
 * Regression: pre-fix, `await agent.hatch()` sat OUTSIDE the try/catch/
 * finally in `runEvalOnce`, between `writeRunMetadata({status:"running"})`
 * and the try block. Any throw from inside `agent.hatch()` (jail-apply
 * failure, setup-command failure inside `VellumAgent.hatch`) bypassed:
 *
 *   - The catch that writes `status: "failed"` + the error message.
 *   - The finally that clears the heartbeat interval AND runs the
 *     `status === "running"` safety-net write.
 *
 * The on-disk run was therefore left `status: "running"` with a fresh
 * heartbeat, and the scavenger in the *next* `evals run` invocation
 * surfaced it as `Process exited without completing (last heartbeat: …)`
 * — opaque to the operator. Vargas's 2026-05-25 timeline-recall report
 * was exactly this shape.
 */
describe("runEvalOnce — hatch failure metadata", () => {
  // Stand-in `Simulator` that satisfies the constructor inside
  // `runEvalOnce` without reaching for `ANTHROPIC_API_KEY` (the real
  // `UserSimulator` ctor requires it and would mask the bug under test
  // with an unrelated throw). The decide() method is unreachable
  // because hatch throws first.
  const inertSimulator: Simulator = {
    async decide(): Promise<SimulatorDecision> {
      return { action: "end", reason: "unreachable in hatch-throw test" };
    },
  };

  afterEach(() => {
    nextAgent = null;
  });

  test("writes status:'failed' (not 'running') when agent.hatch() throws", async () => {
    const runId = `test-hatch-throw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const harness = throwingHatchAgent({
      profile: fakeProfile("p-fake"),
      testId: "t-fake",
      runId,
    });
    nextAgent = harness.agent;

    await expect(
      runEvalOnce({
        profile: fakeProfile("p-fake"),
        test: fakeTestDef("t-fake"),
        runId,
        simulator: inertSimulator,
      }),
    ).rejects.toThrow("simulated post-hatch failure");

    const metadata = await readRunMetadata(runId);
    expect(metadata).toBeDefined();
    // The exact-value assertion is the regression: pre-fix this would
    // be `"running"` because the catch never ran.
    expect(metadata?.status).toBe("failed");
    expect(metadata?.completedAt).toBeDefined();
    expect(metadata?.error ?? "").toContain("simulated post-hatch failure");
    // The manifest snapshot is known at run start, so a run that fails
    // must still carry it — the profile page and exported bundles render
    // species/description/setup even when every run of a profile failed.
    expect(metadata?.profileManifest).toEqual({
      species: "vellum",
      description: "desc for p-fake",
    });

    // Finally block ran → shutdown was called even on the throw path.
    // This is the second leg of the bug fix: without it, hatch failures
    // would leak any partial container state to the next run.
    expect(harness.shutdownCalls[0]).toBe(1);
  });
});

/**
 * Diagnostic-gap regression: pre-fix, `createAgent(...)` and
 * `new UserSimulator(...)` were constructed BEFORE the try block in
 * `runEvalOnce`. A throw from either (most common: ANTHROPIC_API_KEY
 * unset → `new UserSimulator()` throws synchronously) propagated up
 * to the CLI's per-test `catch {}` in `commands/run.ts`, which
 * trusted that run-once had already emitted a structured progress
 * event with the diagnostic detail. It hadn't — there was nothing
 * inside that try yet — so the CLI exited 1 with literally no
 * stdout/stderr explanation.
 *
 * Post-fix:
 *   - Construction lives inside `runEvalOnce`'s try, so the catch
 *     emits a `status:"error"` progress event with the throw's
 *     message.
 *   - The error gets marked via `markErrorAsReportedToProgress` so
 *     the outer CLI catch can tell "structured event already on the
 *     wire" from "throw bypassed everything; emit a fallback line".
 *   - The finally guards `agent?.shutdown()` so a construction-time
 *     throw doesn't NPE during cleanup.
 */
describe("runEvalOnce — construction failure diagnostic gap", () => {
  const inertSimulator: Simulator = {
    async decide(): Promise<SimulatorDecision> {
      return {
        action: "end",
        reason: "unreachable in construction-throw test",
      };
    },
  };

  afterEach(() => {
    nextAgent = null;
  });

  test("emits a status:'error' progress event when createAgent throws", async () => {
    // `nextAgent` left null → the test seam in `mock.module` above
    // throws "test forgot to set nextAgent ...". This simulates any
    // construction-time throw (missing API key, profile species the
    // adapter switch rejects, etc.) — the shape of the gap is what
    // matters, not the exact message.
    const runId = `test-ctor-throw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const events: EvalProgressEvent[] = [];

    let captured: unknown;
    try {
      await runEvalOnce({
        profile: fakeProfile("p-fake"),
        test: fakeTestDef("t-fake"),
        runId,
        simulator: inertSimulator,
        progress: (event) => events.push(event),
      });
    } catch (err) {
      captured = err;
    }

    // The throw still propagates so callers can flip exit codes.
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain(
      "test forgot to set nextAgent",
    );

    // The diagnostic gap: a structured `status:"error"` event MUST
    // reach the reporter. Pre-fix this list would be empty.
    const errorEvents = events.filter((e) => e.status === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(errorEvents[0].message).toContain("test forgot to set nextAgent");

    // And the error must be marked so the outer CLI catch stays quiet
    // instead of double-emitting.
    expect(wasErrorReportedToProgress(captured)).toBe(true);

    // No metadata write happened — `ensureRunArtifacts` never ran, so
    // there's no run directory to write into. The catch correctly
    // skips the write rather than NPE'ing on `runDir`.
    const metadata = await readRunMetadata(runId);
    expect(metadata).toBeUndefined();
  });
});

/**
 * Unit tests for the WeakSet-backed marker mechanism itself. Kept
 * separate from the integration test above so a future refactor of
 * the marker storage (Symbol-on-error, dedicated subclass, etc.)
 * doesn't have to retouch the runEvalOnce regression.
 */
describe("error-reported-to-progress marker", () => {
  test("an unmarked error is reported as not-yet-emitted", () => {
    expect(wasErrorReportedToProgress(new Error("fresh"))).toBe(false);
  });

  test("marking flips the read", () => {
    const err = new Error("ergonomic");
    expect(wasErrorReportedToProgress(err)).toBe(false);
    markErrorAsReportedToProgress(err);
    expect(wasErrorReportedToProgress(err)).toBe(true);
  });

  test("marking is tolerant of primitives and null", () => {
    // WeakSet can't hold primitives; the helpers silently no-op. This
    // matters because the catch in run-once.ts receives `unknown`, and
    // a `throw "bare string"` from a third-party module shouldn't
    // crash the catch trying to mark it.
    expect(() => markErrorAsReportedToProgress("string")).not.toThrow();
    expect(() => markErrorAsReportedToProgress(null)).not.toThrow();
    expect(() => markErrorAsReportedToProgress(undefined)).not.toThrow();
    expect(() => markErrorAsReportedToProgress(42)).not.toThrow();

    // ... and reads return false (the "emit fallback" signal) for
    // primitives, which is the correct conservative default.
    expect(wasErrorReportedToProgress("string")).toBe(false);
    expect(wasErrorReportedToProgress(null)).toBe(false);
    expect(wasErrorReportedToProgress(undefined)).toBe(false);
    expect(wasErrorReportedToProgress(42)).toBe(false);
  });
});
