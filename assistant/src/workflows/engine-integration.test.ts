/**
 * End-to-end engine integration tests.
 *
 * Unlike `engine.test.ts` — which injects a FAKE leaf runner — this suite wires
 * the REAL pieces together: the real QuickJS sandbox, the real {@link runLeaf}
 * leaf runner, the real {@link AgentLoop}, the real journal store, and a real
 * temp DB. Only the LLM provider is mocked, so leaves complete without a
 * network call. This catches integration bugs the fake-runner tests miss:
 * sandbox↔host JSON marshaling, the leaf runner's real agent-loop path, and
 * journal DB round-trips on resume.
 *
 * Leaves run the REAL **tool path**: the engine forwards `capabilities.tools`
 * to every leaf, the leaf runner spins up an `AgentLoop`, and the mocked
 * provider returns a single `end_turn` message whose text echoes the prompt
 * (so each leaf's `output` is distinguishable and order-checkable). A leaf with
 * an empty toolset would route to the leaf runner's SCHEMA path, which requires
 * an in-process Zod schema and so cannot be driven from a sandboxed script —
 * see the `test.todo` at the end of this file (a known engine↔leaf-runner gap).
 *
 * Covered:
 *  - `map`/`parallel` fan-out: each leaf returns its echoed output, aggregated
 *    in spec-array order through the real sandbox + leaf runner + agent loop.
 *  - In-process resume: re-running the SAME runId against the SAME DB replays
 *    the unchanged prefix from the journal — ZERO duplicate provider calls —
 *    and only the changed/new tail re-runs the provider.
 *  - Cap abort: a low `maxAgentsPerRun` aborts with status `cap_exceeded` and
 *    the partial counters are persisted on the run row.
 *  - Concurrency high-water: the provider mock records in-flight concurrency
 *    and never exceeds `maxConcurrentLeaves`.
 *  - Hash stability: the same script run twice journals identical
 *    `(seq, call_hash)` sequences.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../__tests__/helpers/mock-logger.js";

// ---------------------------------------------------------------------------
// Mocks — defined before importing the module under test.
//
// We mock ONLY the LLM provider (no network) and silence the logger. Every
// other surface — sandbox, leaf runner, agent loop, journal store,
// capabilities, config — is the real implementation.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

interface SendOptions {
  signal?: AbortSignal;
}

/** Live in-flight provider calls, to assert the concurrency high-water mark. */
let inFlight = 0;
let maxInFlight = 0;
/** Total provider sendMessage invocations (the resume duplicate-call check). */
let sendCallCount = 0;
/** Per-call delay (ms) so concurrent fan-out actually overlaps in time. */
let sendDelayMs = 0;

/** Extract the latest user prompt text from a provider message array. */
function lastUserPrompt(
  messages: Array<{
    role: string;
    content: Array<{ type: string; text?: string }>;
  }>,
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    return m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  return "";
}

/**
 * The leaf's real `AgentLoop` calls the provider; we return a single `end_turn`
 * message whose text echoes the prompt, so the loop terminates in one turn and
 * the leaf's `output` is `processed:<prompt>`.
 */
const sendMessage = mock(
  async (
    messages: Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>,
    options: SendOptions,
  ): Promise<{
    content: Array<{ type: string; text: string }>;
    model: string;
    usage: { inputTokens: number; outputTokens: number };
    stopReason: string;
  }> => {
    sendCallCount += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (sendDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sendDelayMs));
      }
      if (options.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return {
        content: [
          { type: "text", text: `processed:${lastUserPrompt(messages)}` },
        ],
        model: "test-model",
        usage: { inputTokens: 7, outputTokens: 3 },
        stopReason: "end_turn",
      };
    } finally {
      inFlight -= 1;
    }
  },
);

const getConfiguredProvider = mock(async () => ({
  name: "test-provider",
  sendMessage,
}));

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider,
  // Re-implement the trivial helpers the leaf runner imports from this module.
  extractToolUse: (response: { content: Array<{ type: string }> }) =>
    response.content.find((b) => b.type === "tool_use"),
}));

// ---------------------------------------------------------------------------
// Module under test (after mocks).
// ---------------------------------------------------------------------------

import { WorkflowsConfigSchema } from "../config/schemas/workflows.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { registerTool } from "../tools/registry.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";
import { resolveCapabilities } from "./capabilities.js";
import { executeWorkflow } from "./engine.js";
import * as journalStore from "./journal-store.js";
import { getJournal, getRun } from "./journal-store.js";
import { runLeaf } from "./leaf-runner.js";

initializeDb();

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const trustContext: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

/**
 * A real, no-op registry tool the manifest declares so leaves take the leaf
 * runner's REAL tool path (an `AgentLoop` over the provider). The model never
 * calls it — the provider mock returns final text on the first turn — but its
 * presence in `capabilities.tools` is what routes the leaf to the agent loop.
 */
const ECHO_TOOL_NAME = "wf_integration_echo";
registerTool({
  name: ECHO_TOOL_NAME,
  description: "Integration-test no-op tool.",
  category: "test",
  defaultRiskLevel: "low" as never,
  executionTarget: "sandbox",
  input_schema: { type: "object", properties: {}, required: [] },
  async execute(
    _input: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    return { content: "noop", isError: false };
  },
});

const capabilities = resolveCapabilities({
  tools: [ECHO_TOOL_NAME],
  hostFunctions: [],
  persona: false,
});

/** Build a `WorkflowsConfig` from schema defaults with optional overrides. */
function makeConfig(
  overrides: Partial<{
    maxAgentsPerRun: number;
    maxConcurrentLeaves: number;
  }> = {},
) {
  return WorkflowsConfigSchema.parse(overrides);
}

/**
 * Base options shared by every `executeWorkflow` call: the REAL journal store,
 * the REAL leaf runner, real capabilities, real trust context.
 */
function baseOptions(runId: string, scriptSource: string) {
  return {
    runId,
    scriptSource,
    args: {},
    capabilities,
    journal: journalStore,
    leafRunner: runLeaf,
    trustContext,
  };
}

function resetTables(): void {
  getSqlite().exec("DELETE FROM workflow_journal");
  getSqlite().exec("DELETE FROM workflow_runs");
}

beforeEach(() => {
  resetTables();
  sendMessage.mockClear();
  getConfiguredProvider.mockClear();
  inFlight = 0;
  maxInFlight = 0;
  sendCallCount = 0;
  sendDelayMs = 0;
});

afterAll(() => {
  resetTables();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflow engine integration (real sandbox + leaf runner + agent loop + journal)", () => {
  test("map/parallel fan-out: each leaf returns its echoed output, in order", async () => {
    // The script is SYNCHRONOUS from its own view (asyncify) — no `await`.
    const scriptSource = `
export const meta = { name: "fanout", description: "map over items" };
const items = args.items;
const results = map(items, (it) => leaf("item-" + it, { label: "leaf-" + it }));
return results;
`;
    const result = await executeWorkflow({
      ...baseOptions("wf-fanout", scriptSource),
      args: { items: ["a", "b", "c"] },
      config: makeConfig(),
    });

    expect(result.status).toBe("completed");
    // Each leaf's output is its echoed final text, in spec-array order.
    expect(result.result).toEqual([
      "processed:item-a",
      "processed:item-b",
      "processed:item-c",
    ]);
    expect(result.agentsSpawned).toBe(3);
    // Real provider mock was hit once per leaf through the real agent loop.
    expect(sendCallCount).toBe(3);
    // Usage flowed back from the provider through the leaf runner and engine.
    expect(result.inputTokens).toBe(21);
    expect(result.outputTokens).toBe(9);

    // The journal persisted one completed agent entry per leaf, in seq order.
    const journal = getJournal("wf-fanout");
    expect(journal.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(journal.every((e) => e.status === "completed")).toBe(true);
    expect(journal.map((e) => e.result)).toEqual([
      "processed:item-a",
      "processed:item-b",
      "processed:item-c",
    ]);
  });

  test("in-process resume: unchanged prefix replays from journal with ZERO duplicate provider calls", async () => {
    // A script that journals N sequential agent() calls. `args.tail` is the
    // text of the FINAL call; changing it between runs leaves the prefix
    // unchanged (same prompt → same call_hash) and changes only the last seq.
    const scriptSource = `
export const meta = { name: "resume", description: "sequential agents" };
const a = agent("step-1");
const b = agent("step-2");
const c = agent(args.tail);
return [a, b, c];
`;
    // First run: 3 fresh leaves → 3 provider calls.
    const first = await executeWorkflow({
      ...baseOptions("wf-resume", scriptSource),
      args: { tail: "step-3" },
      config: makeConfig(),
    });
    expect(first.status).toBe("completed");
    expect(sendCallCount).toBe(3);
    const firstJournal = getJournal("wf-resume");
    expect(firstJournal.map((e) => e.seq)).toEqual([0, 1, 2]);

    // Reset the in-test provider counter so we count ONLY the resume's calls.
    sendCallCount = 0;
    sendMessage.mockClear();

    // Second run: SAME runId, SAME DB, but the last call's prompt changes.
    // seq 0 and 1 are unchanged (hash match) and MUST replay from the journal
    // without touching the provider; seq 2's hash changes and re-runs.
    const second = await executeWorkflow({
      ...baseOptions("wf-resume", scriptSource),
      args: { tail: "step-3-CHANGED" },
      config: makeConfig(),
    });

    expect(second.status).toBe("completed");
    // THE HEADLINE ACCEPTANCE CRITERION: exactly ONE provider call — only the
    // changed tail. Zero duplicate provider calls for the unchanged prefix,
    // verified THROUGH the real sandbox + leaf runner + agent loop + journal
    // stack (not a fake runner).
    expect(sendCallCount).toBe(1);
    // The engine returns the correct values: the prefix replayed from the
    // journal, the changed tail re-ran and produced its new output.
    expect(second.result).toEqual([
      "processed:step-1",
      "processed:step-2",
      "processed:step-3-CHANGED",
    ]);

    // The prefix journal entries are untouched (same call_hash as the first
    // run) and there is still exactly one entry per seq.
    const secondJournal = getJournal("wf-resume");
    expect(secondJournal.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(secondJournal[0]!.callHash).toBe(firstJournal[0]!.callHash);
    expect(secondJournal[1]!.callHash).toBe(firstJournal[1]!.callHash);
    // NOTE: seq 2's journal row is NOT rewritten on resume — see the
    // `resume rewrites a changed leaf's journal entry` test.todo below for the
    // known `INSERT OR IGNORE` staleness bug. The engine's returned value
    // (asserted above) is correct; only the persisted journal row is stale.
  });

  test("cap abort: a low maxAgentsPerRun yields cap_exceeded with partials persisted", async () => {
    const scriptSource = `
export const meta = { name: "cap", description: "more leaves than the cap" };
const a = agent("c-1");
const b = agent("c-2");
const c = agent("c-3");
return [a, b, c];
`;
    const result = await executeWorkflow({
      ...baseOptions("wf-cap", scriptSource),
      // Cap at 2 — the third sequential agent() trips the cap before launching.
      config: makeConfig({ maxAgentsPerRun: 2 }),
    });

    expect(result.status).toBe("cap_exceeded");
    expect(result.result).toBeNull();
    // Exactly 2 leaves ran before the cap tripped on the 3rd.
    expect(result.agentsSpawned).toBe(2);
    expect(sendCallCount).toBe(2);

    // Partial counters and terminal status are persisted on the run row.
    const run = getRun("wf-cap");
    expect(run?.status).toBe("cap_exceeded");
    expect(run?.agentsSpawned).toBe(2);
    expect(run?.error).toContain("Agent cap of 2 exceeded");
    // Two completed journal entries were persisted before the abort.
    expect(getJournal("wf-cap").length).toBe(2);
  });

  test("concurrency high-water: never exceeds maxConcurrentLeaves", async () => {
    // Delay each provider call so a wide fan-out genuinely overlaps; the mock
    // tracks the live in-flight count.
    sendDelayMs = 15;
    const scriptSource = `
export const meta = { name: "concurrency", description: "wide parallel fan-out" };
const items = args.items;
const results = parallel(items.map((it) => leaf("p-" + it)));
return results;
`;
    const items = Array.from({ length: 12 }, (_, i) => i);
    const result = await executeWorkflow({
      ...baseOptions("wf-conc", scriptSource),
      args: { items },
      config: makeConfig({ maxConcurrentLeaves: 3 }),
    });

    expect(result.status).toBe("completed");
    expect(result.agentsSpawned).toBe(12);
    expect(sendCallCount).toBe(12);
    // The engine's worker pool capped live concurrency at the configured limit.
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  test("hash stability: the same script run twice journals identical (seq, call_hash) sequences", async () => {
    const scriptSource = `
export const meta = { name: "stable", description: "deterministic hashes" };
const items = args.items;
const results = map(items, (it) => leaf("h-" + it));
const tail = agent("final");
return { results, tail };
`;
    const args = { items: ["x", "y", "z"] };

    await executeWorkflow({
      ...baseOptions("wf-hash-1", scriptSource),
      args,
      config: makeConfig(),
    });
    await executeWorkflow({
      ...baseOptions("wf-hash-2", scriptSource),
      args,
      config: makeConfig(),
    });

    const seqHashes = (runId: string) =>
      getJournal(runId).map((e) => [e.seq, e.callHash] as const);

    const a = seqHashes("wf-hash-1");
    const b = seqHashes("wf-hash-2");
    expect(a.length).toBe(4);
    expect(a).toEqual(b);
  });

  // ---------------------------------------------------------------------------
  // KNOWN ENGINE↔LEAF-RUNNER GAP (flagged for a follow-up product fix).
  //
  // A workflow script can declare a per-leaf output `schema` via
  // `leaf(prompt, { schema })`, but that schema crosses the QuickJS sandbox
  // boundary as a JSON-marshaled plain object. The leaf runner's schema path
  // (`runSchemaLeaf`) requires an in-process Zod schema — it calls
  // `z.toJSONSchema(schema)` and `schema.safeParse(...)` — so a marshaled
  // schema throws `undefined is not an object (evaluating 'schema._zod.def')`
  // and the leaf fails. The engine needs to reconstruct a Zod schema (e.g. via
  // `z.fromJSONSchema`) from the marshaled JSON Schema before invoking the leaf
  // runner. Converted to `test()` once the engine bridges the schema path.
  // ---------------------------------------------------------------------------
  test.todo(
    "schema-path leaves: script-provided JSON Schema is reconstructed to Zod before runLeaf",
    () => {},
  );

  // ---------------------------------------------------------------------------
  // KNOWN RESUME JOURNAL-STALENESS GAP (flagged for a follow-up product fix).
  //
  // On resume, a leaf whose input CHANGED (new `call_hash`) correctly re-runs
  // and the engine returns the new value. But its journal row is never
  // rewritten: `journalStore.appendJournalEntry` uses `INSERT OR IGNORE` keyed
  // on `(run_id, seq)`, so the stale first-run row (old hash, old result)
  // survives and the persisted journal disagrees with the value the engine
  // actually returned. The crash-idempotency the `INSERT OR IGNORE` was meant
  // to provide should be narrowed to genuine duplicate (same-hash) re-appends;
  // a changed-hash re-run at the same seq must overwrite (e.g. upsert keyed on
  // `(run_id, seq)`). Converted to `test()` once the journal upserts a changed
  // seq on resume.
  // ---------------------------------------------------------------------------
  test.todo(
    "resume rewrites a changed leaf's journal entry (hash + result) instead of keeping the stale row",
    () => {},
  );
});
