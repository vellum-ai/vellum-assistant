import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Silence the logger.
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { WorkflowsConfig } from "../config/schemas/workflows.js";
import type { TrustContext } from "../daemon/trust-context.js";
import { getSqlite } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import type { ResolvedCapabilities } from "./capabilities.js";
import { executeWorkflow, extractWorkflowMeta } from "./engine.js";
import * as journalStore from "./journal-store.js";
import type { LeafResult, RunLeafOptions } from "./leaf-runner.js";

initializeDb();

function resetTables(): void {
  getSqlite().exec("DELETE FROM workflow_journal");
  getSqlite().exec("DELETE FROM workflow_runs");
}

/** Poll until `predicate()` is true (or a short deadline elapses). */
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("Timed out waiting for condition");
}

const TRUST: TrustContext = { sourceChannel: "vellum", trustClass: "guardian" };

const CAPABILITIES: ResolvedCapabilities = {
  tools: [],
  hostFunctions: [],
  persona: false,
};

function configWith(overrides: Partial<WorkflowsConfig> = {}): WorkflowsConfig {
  return {
    maxAgentsPerRun: 500,
    maxConcurrentLeaves: 6,
    maxConcurrentRuns: 3,
    journalRetentionDays: 30,
    ...overrides,
  };
}

/**
 * Fake leaf runner. Records every prompt it is called with, tracks the
 * concurrency high-water mark (so a test can assert the cap), and returns a
 * deterministic echo output with fixed token usage. An optional `failOn`
 * predicate makes a leaf throw.
 */
function makeFakeRunner(opts?: {
  delayMs?: number;
  failOn?: (prompt: string) => boolean;
  onCall?: (prompt: string) => void;
}) {
  const prompts: string[] = [];
  const calls: RunLeafOptions[] = [];
  let inFlight = 0;
  let highWater = 0;

  const runner = async (leafOpts: RunLeafOptions): Promise<LeafResult> => {
    prompts.push(leafOpts.prompt);
    calls.push(leafOpts);
    opts?.onCall?.(leafOpts.prompt);
    inFlight += 1;
    highWater = Math.max(highWater, inFlight);
    try {
      if (opts?.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      } else {
        await Promise.resolve();
      }
      if (opts?.failOn?.(leafOpts.prompt)) {
        throw new Error(`leaf failed: ${leafOpts.prompt}`);
      }
      return {
        output: `out:${leafOpts.prompt}`,
        inputTokens: 10,
        outputTokens: 5,
        toolCallCount: 0,
      };
    } finally {
      inFlight -= 1;
    }
  };

  return {
    runner: runner as unknown as typeof import("./leaf-runner.js").runLeaf,
    prompts,
    calls,
    get highWater() {
      return highWater;
    },
    get inFlight() {
      return inFlight;
    },
  };
}

const META = `export const meta = { name: "test-wf", description: "a test workflow" };\n`;

function execute(
  runId: string,
  scriptSource: string,
  runner: typeof import("./leaf-runner.js").runLeaf,
  config: WorkflowsConfig = configWith(),
  args: unknown = null,
  capabilities: ResolvedCapabilities = CAPABILITIES,
  signal?: AbortSignal,
) {
  return executeWorkflow({
    runId,
    scriptSource: META + scriptSource,
    args,
    capabilities,
    config,
    journal: journalStore,
    leafRunner: runner,
    trustContext: TRUST,
    ...(signal ? { signal } : {}),
  });
}

describe("extractWorkflowMeta", () => {
  test("extracts a pure-literal meta", () => {
    expect(
      extractWorkflowMeta(
        `export const meta = { name: "n", description: "d" };`,
      ),
    ).toEqual({ name: "n", description: "d" });
  });

  test("rejects a missing meta", () => {
    expect(() => extractWorkflowMeta(`const x = 1;`)).toThrow();
  });

  test("rejects a non-string name/description", () => {
    expect(() =>
      extractWorkflowMeta(`export const meta = { name: 1, description: "d" };`),
    ).toThrow();
  });

  test("accepts single-quoted and unquoted-key literals", () => {
    expect(
      extractWorkflowMeta(
        `export const meta = { name: 'n', description: 'd', };`,
      ),
    ).toEqual({ name: "n", description: "d" });
  });

  test("rejects a computed meta without executing it (no host eval)", () => {
    // A function call in the literal must NOT run in the host process — it
    // simply fails to JSON-parse and is rejected.
    (globalThis as Record<string, unknown>).__pwned = false;
    expect(() =>
      extractWorkflowMeta(
        `export const meta = { name: (((globalThis).__pwned = true), "n"), description: "d" };`,
      ),
    ).toThrow();
    expect((globalThis as Record<string, unknown>).__pwned).toBe(false);
    delete (globalThis as Record<string, unknown>).__pwned;
  });
});

describe("executeWorkflow — fan-out & aggregation", () => {
  beforeEach(resetTables);

  test("map/parallel aggregates results and respects the concurrency cap", async () => {
    const fake = makeFakeRunner({ delayMs: 8 });
    const items = Array.from({ length: 20 }, (_, i) => `item-${i}`);

    const res = await execute(
      "wf-map",
      `const results = map(args.items, (it) => leaf("task:" + it));
       return results;`,
      fake.runner,
      configWith({ maxConcurrentLeaves: 4 }),
      { items },
    );

    expect(res.status).toBe("completed");
    expect(res.result).toEqual(items.map((it) => `out:task:${it}`));
    expect(res.agentsSpawned).toBe(20);
    expect(res.inputTokens).toBe(200);
    expect(res.outputTokens).toBe(100);
    // Concurrency high-water never exceeds the cap.
    expect(fake.highWater).toBeLessThanOrEqual(4);
    expect(fake.highWater).toBeGreaterThan(1);
  });

  test("parallel results stay in spec-array order despite completion order", async () => {
    // Earlier items take longer, so completion order is reversed.
    const fake = makeFakeRunner();
    const res = await execute(
      "wf-order",
      `return parallel([leaf("a"), leaf("b"), leaf("c")]);`,
      fake.runner,
    );
    expect(res.result).toEqual(["out:a", "out:b", "out:c"]);
  });

  test("a failed leaf inside parallel yields null (never throws)", async () => {
    const fake = makeFakeRunner({ failOn: (p) => p === "boom" });
    const res = await execute(
      "wf-fail",
      `return parallel([leaf("ok1"), leaf("boom"), leaf("ok2")]);`,
      fake.runner,
    );
    expect(res.status).toBe("completed");
    expect(res.result).toEqual(["out:ok1", null, "out:ok2"]);
  });

  test("agent() runs one sequential leaf and returns its output", async () => {
    const fake = makeFakeRunner();
    const res = await execute(
      "wf-agent",
      `const a = agent("first");
       const b = agent("second");
       return [a, b];`,
      fake.runner,
    );
    expect(res.result).toEqual(["out:first", "out:second"]);
    expect(fake.prompts).toEqual(["first", "second"]);
  });

  test("usage() reflects accumulated agents/tokens mid-script", async () => {
    const fake = makeFakeRunner();
    const res = await execute(
      "wf-usage",
      `agent("one");
       const u = usage();
       return u;`,
      fake.runner,
    );
    expect(res.result).toEqual({
      agentsSpawned: 1,
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});

describe("executeWorkflow — script return value becomes the run result", () => {
  beforeEach(resetTables);

  test("a top-level `return <value>` surfaces as the run result (not a bare expression)", async () => {
    const fake = makeFakeRunner();
    const res = await execute(
      "wf-return",
      `const summary = agent("summarize");
       return { final: summary, kind: "report" };`,
      fake.runner,
    );
    expect(res.status).toBe("completed");
    expect(res.result).toEqual({ final: "out:summarize", kind: "report" });
  });

  test("a script with NO top-level return completes with no result (undefined)", async () => {
    // The authoring contract requires `return <result>;`. A bare trailing
    // expression is discarded by the function-body wrapper, so the run
    // completes with NO result. This documents WHY the contract mandates an
    // explicit return: the leaf ran, but its value never reached the caller.
    const fake = makeFakeRunner();
    const res = await execute(
      "wf-no-return",
      `const summary = agent("summarize");
       summary;`,
      fake.runner,
    );
    expect(res.status).toBe("completed");
    expect(res.result).toBeUndefined();
    // The leaf DID run — the value was simply discarded by the missing return.
    expect(fake.prompts).toEqual(["summarize"]);
  });
});

describe("executeWorkflow — abort handling (leaf abort = run abort)", () => {
  beforeEach(resetTables);

  /**
   * A runner that signals (via `onStart`) when a leaf is in flight and blocks on
   * `gate` until the test resolves it. When the run's signal aborts mid-flight,
   * a real provider/agent-loop call rejects with an abort error; this fake
   * mirrors that by rejecting with an `AbortError` once released after abort.
   */
  function makeBlockingRunner(signal: AbortSignal, onStart: () => void) {
    const runner = async (): Promise<import("./leaf-runner.js").LeafResult> => {
      onStart();
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      // The signal fired while we were awaiting — reject the way a cancelled
      // provider call does.
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    };
    return runner as unknown as typeof import("./leaf-runner.js").runLeaf;
  }

  test("aborting mid-leaf in agent() ends the run as `aborted` (not `failed`)", async () => {
    const controller = new AbortController();
    let started = false;
    const runner = makeBlockingRunner(controller.signal, () => {
      started = true;
    });

    const runPromise = execute(
      "wf-abort-agent",
      `const a = agent("long-running");
       return a;`,
      runner,
      configWith(),
      null,
      CAPABILITIES,
      controller.signal,
    );

    // Wait until the leaf is in flight, then abort.
    await waitUntil(() => started);
    controller.abort();

    const res = await runPromise;
    expect(res.status).toBe("aborted");
    expect(res.result).toBeNull();

    // The cancelled leaf is NOT journaled as a failed entry.
    const journal = journalStore.getJournal("wf-abort-agent");
    expect(journal.every((e) => e.status !== "failed")).toBe(true);
  });

  test("aborting mid-leaf in parallel() ends the run as `aborted` and does not null-coalesce", async () => {
    const controller = new AbortController();
    let startedCount = 0;
    const runner = makeBlockingRunner(controller.signal, () => {
      startedCount += 1;
    });

    const runPromise = execute(
      "wf-abort-parallel",
      `const r = parallel([leaf("a"), leaf("b"), leaf("c")]);
       return r;`,
      runner,
      configWith({ maxConcurrentLeaves: 3 }),
      null,
      CAPABILITIES,
      controller.signal,
    );

    await waitUntil(() => startedCount >= 1);
    controller.abort();

    const res = await runPromise;
    // The run terminates as aborted rather than completing with [null,...].
    expect(res.status).toBe("aborted");
    expect(res.result).toBeNull();
    const journal = journalStore.getJournal("wf-abort-parallel");
    expect(journal.every((e) => e.status !== "failed")).toBe(true);
  });

  test("an abort raised at the leaf gate BEFORE the call also yields `aborted`", async () => {
    // Pre-aborted signal: the engine's top-of-leaf `signal?.aborted` guard fires
    // before the runner is invoked.
    const controller = new AbortController();
    controller.abort();
    const fake = makeFakeRunner();

    const res = await execute(
      "wf-abort-pre",
      `return agent("never-runs");`,
      fake.runner,
      configWith(),
      null,
      CAPABILITIES,
      controller.signal,
    );
    expect(res.status).toBe("aborted");
    expect(fake.prompts).toEqual([]);
  });
});

describe("executeWorkflow — pipeline", () => {
  beforeEach(resetTables);

  test("pipeline advances across stages with a per-stage barrier", async () => {
    const order: string[] = [];
    const fake = makeFakeRunner({ onCall: (p) => order.push(p) });

    const res = await execute(
      "wf-pipeline",
      `return pipeline(
         args.items,
         (it) => leaf("s1:" + it),
         (prev) => leaf("s2:" + prev),
       );`,
      fake.runner,
      configWith(),
      { items: ["x", "y"] },
    );

    // Stage 1 output feeds stage 2's input.
    expect(res.result).toEqual(["out:s2:out:s1:x", "out:s2:out:s1:y"]);
    // Per-stage barrier: BOTH stage-1 calls precede ANY stage-2 call.
    const firstStage2 = order.findIndex((p) => p.startsWith("s2:"));
    const stage1AfterStage2 = order
      .slice(firstStage2)
      .some((p) => p.startsWith("s1:"));
    expect(stage1AfterStage2).toBe(false);
  });
});

describe("executeWorkflow — resume", () => {
  beforeEach(resetTables);

  test("re-running the same runId replays the unchanged prefix (zero duplicate calls)", async () => {
    const script = `const a = agent("alpha");
       const b = agent("beta");
       return [a, b];`;

    const first = makeFakeRunner();
    const res1 = await execute("wf-resume", script, first.runner);
    expect(res1.result).toEqual(["out:alpha", "out:beta"]);
    expect(first.prompts).toEqual(["alpha", "beta"]);

    // Re-run with the SAME runId against the SAME DB. The journal replays both
    // cached calls — the runner must NOT be invoked at all.
    const second = makeFakeRunner();
    const res2 = await execute("wf-resume", script, second.runner);
    expect(res2.result).toEqual(["out:alpha", "out:beta"]);
    expect(second.prompts).toEqual([]);
  });

  test("resume carries agentsSpawned/tokens forward from the persisted run row (not reset to 0)", async () => {
    // First run journals 2 leaves → persisted agents_spawned = 2.
    const first = makeFakeRunner();
    await execute(
      "wf-resume-count",
      `agent("a"); return agent("b");`,
      first.runner,
    );
    const afterFirst = journalStore.getRun("wf-resume-count");
    expect(afterFirst?.agentsSpawned).toBe(2);
    expect(afterFirst?.inputTokens).toBe(20);

    // Resume with one ADDED leaf: a/b replay (no re-count), the new leaf spawns.
    const second = makeFakeRunner();
    const res = await execute(
      "wf-resume-count",
      `agent("a"); agent("b"); return agent("c");`,
      second.runner,
    );
    expect(res.status).toBe("completed");
    expect(second.prompts).toEqual(["c"]);
    // Carried forward: persisted 2 + 1 newly spawned = 3 (NOT reset to 1).
    expect(res.agentsSpawned).toBe(3);
    expect(res.inputTokens).toBe(30);

    // The persisted agents_spawned is not regressed downward by the resume.
    const afterSecond = journalStore.getRun("wf-resume-count");
    expect(afterSecond?.agentsSpawned).toBe(3);
    expect(afterSecond!.agentsSpawned).toBeGreaterThanOrEqual(
      afterFirst!.agentsSpawned,
    );
  });

  test("resume enforces the agent cap against the carried-over total (no fresh budget)", async () => {
    // First run spawns 3 leaves under a generous cap → persisted at 3.
    const first = makeFakeRunner();
    await execute(
      "wf-resume-cap",
      `agent("a"); agent("b"); return agent("c");`,
      first.runner,
      configWith({ maxAgentsPerRun: 500 }),
    );
    expect(journalStore.getRun("wf-resume-cap")?.agentsSpawned).toBe(3);

    // Resume with cap=3 and one NEW leaf. Were the counter reset to 0, the new
    // leaf would fit a fresh budget; seeded from the persisted 3, the cap is
    // already met, so the new leaf trips it.
    const second = makeFakeRunner();
    const res = await execute(
      "wf-resume-cap",
      `agent("a"); agent("b"); agent("c"); return agent("d");`,
      second.runner,
      configWith({ maxAgentsPerRun: 3 }),
    );

    expect(res.status).toBe("cap_exceeded");
    // The new leaf never ran; the carried total stays at the cap.
    expect(second.prompts).toEqual([]);
    expect(res.agentsSpawned).toBe(3);
    expect(journalStore.getRun("wf-resume-cap")?.agentsSpawned).toBe(3);
  });

  test("a changed call breaks the replay prefix and re-runs from there", async () => {
    const first = makeFakeRunner();
    await execute(
      "wf-resume2",
      `agent("alpha"); return agent("beta");`,
      first.runner,
    );
    expect(first.prompts).toEqual(["alpha", "beta"]);

    // Second run: seq 0 ("alpha") is unchanged → replayed; seq 1 changes
    // ("beta" → "gamma") → hash mismatch → re-run.
    const second = makeFakeRunner();
    const res = await execute(
      "wf-resume2",
      `agent("alpha"); return agent("gamma");`,
      second.runner,
    );
    expect(res.result).toBe("out:gamma");
    expect(second.prompts).toEqual(["gamma"]);
  });

  test("deterministic seq + call_hash are stable across two runs", async () => {
    const script = `return parallel([leaf("p0"), leaf("p1"), leaf("p2")]);`;

    const first = makeFakeRunner();
    await execute("wf-hash", script, first.runner);
    const journalA = journalStore.getJournal("wf-hash");

    resetTables();

    const second = makeFakeRunner();
    await execute("wf-hash", script, second.runner);
    const journalB = journalStore.getJournal("wf-hash");

    expect(journalA.map((e) => [e.seq, e.callHash])).toEqual(
      journalB.map((e) => [e.seq, e.callHash]),
    );
    expect(journalA.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("executeWorkflow — schema vs tool leaf tool forwarding", () => {
  beforeEach(resetTables);

  // A non-empty capability set, mirroring a real run (which always carries the
  // read-only baseline). The engine must forward these tools ONLY to tool leaves.
  const toolsCapabilities: ResolvedCapabilities = {
    tools: [{ name: "file_read" } as ResolvedCapabilities["tools"][number]],
    hostFunctions: [],
    persona: false,
  };

  test("a schema leaf is called with NO tools; a plain tool leaf gets capabilities.tools", async () => {
    const fake = makeFakeRunner();
    // The schema crosses the (here-bypassed) sandbox as a plain JSON Schema
    // object; the engine forwards it verbatim. The plain leaf has no schema.
    const res = await execute(
      "wf-tool-forward",
      `const schemaLeaf = agent("structured", { schema: { type: "object" } });
       const toolLeaf = agent("freeform");
       return [schemaLeaf, toolLeaf];`,
      fake.runner,
      configWith(),
      null,
      toolsCapabilities,
    );

    expect(res.status).toBe("completed");
    expect(fake.prompts).toEqual(["structured", "freeform"]);

    const [schemaCall, toolCall] = fake.calls;
    // Schema leaf: schema present, NO tools forwarded.
    expect(schemaCall!.schema).toEqual({ type: "object" });
    expect(schemaCall!.tools ?? []).toEqual([]);
    // Tool leaf: no schema, capabilities.tools forwarded.
    expect(toolCall!.schema).toBeUndefined();
    expect(toolCall!.tools).toBe(toolsCapabilities.tools);
  });
});

describe("executeWorkflow — persona gating", () => {
  beforeEach(resetTables);

  const personaCapabilities: ResolvedCapabilities = {
    tools: [],
    hostFunctions: [],
    persona: true,
  };

  test("a persona leaf forwards persona:true to the runner when the run declared persona", async () => {
    const fake = makeFakeRunner();
    const res = await execute(
      "wf-persona-ok",
      `return agent("draft a reply", { persona: true });`,
      fake.runner,
      configWith(),
      null,
      personaCapabilities,
    );

    expect(res.status).toBe("completed");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.persona).toBe(true);
  });

  test("a non-persona leaf does NOT forward persona", async () => {
    const fake = makeFakeRunner();
    await execute(
      "wf-persona-anon",
      `return agent("plain task");`,
      fake.runner,
      configWith(),
      null,
      personaCapabilities,
    );
    expect(fake.calls[0]!.persona).toBeUndefined();
  });

  test("a persona leaf in a run WITHOUT declared persona fails the run (loud, never silent)", async () => {
    const fake = makeFakeRunner();
    // Default CAPABILITIES has persona:false.
    const res = await execute(
      "wf-persona-denied",
      `return agent("draft a reply", { persona: true });`,
      fake.runner,
    );

    expect(res.status).toBe("failed");
    // The leaf runner is never invoked — the gate trips before the spawn.
    expect(fake.calls).toHaveLength(0);
    expect(res.agentsSpawned).toBe(0);
  });
});

describe("executeWorkflow — agent cap", () => {
  beforeEach(resetTables);

  test("exceeding maxAgentsPerRun aborts with cap_exceeded and persists partials", async () => {
    const fake = makeFakeRunner();
    const items = Array.from({ length: 10 }, (_, i) => `i${i}`);

    const res = await execute(
      "wf-cap",
      `const a = map(args.items, (it) => leaf(it));
       return a;`,
      fake.runner,
      configWith({ maxAgentsPerRun: 3, maxConcurrentLeaves: 1 }),
      { items },
    );

    expect(res.status).toBe("cap_exceeded");
    // Exactly the cap's worth of leaves ran before the run aborted.
    expect(res.agentsSpawned).toBe(3);
    expect(fake.prompts.length).toBe(3);

    // Partials are persisted: the run row reflects cap_exceeded + 3 agents, and
    // 3 journal entries exist.
    const run = journalStore.getRun("wf-cap");
    expect(run?.status).toBe("cap_exceeded");
    expect(run?.agentsSpawned).toBe(3);
    expect(journalStore.getJournal("wf-cap").length).toBe(3);
  });

  test("the cap counts only NEW leaves; replayed leaves do not consume it", async () => {
    // First run journals 2 leaves with a generous cap.
    const first = makeFakeRunner();
    await execute(
      "wf-cap-replay",
      `agent("a"); agent("b"); return agent("c");`,
      first.runner,
      configWith({ maxAgentsPerRun: 500 }),
    );
    expect(first.prompts).toEqual(["a", "b", "c"]);

    // Re-run with cap=1: a/b/c all replay from the journal (hash match), so the
    // cap (which only counts NEW spawns) is never tripped.
    const second = makeFakeRunner();
    const res = await execute(
      "wf-cap-replay",
      `agent("a"); agent("b"); return agent("c");`,
      second.runner,
      configWith({ maxAgentsPerRun: 1 }),
    );
    expect(res.status).toBe("completed");
    expect(res.result).toBe("out:c");
    expect(second.prompts).toEqual([]);
  });
});

describe("executeWorkflow — fan-out unwind (no orphaned leaves)", () => {
  beforeEach(resetTables);

  test("a cap tripped mid-fan-out drains in-flight leaves before finishing (no post-finalization writes)", async () => {
    // maxAgentsPerRun=1 + maxConcurrentLeaves=2: leaf "a" spawns and goes in
    // flight (slow), then leaf "b" trips the cap and throws. The fan-out must
    // NOT resolve while "a" is still running — otherwise the run is reported
    // `cap_exceeded` and `finishRun` lands while "a" later appends a journal
    // entry. This fake IGNORES the abort signal, so it proves the DRAIN: the
    // engine waits for the orphan to settle rather than relying on cancellation.
    const fake = makeFakeRunner({ delayMs: 80 });
    const res = await execute(
      "wf-unwind-drain",
      `return parallel([leaf("a"), leaf("b")]);`,
      fake.runner,
      configWith({ maxAgentsPerRun: 1, maxConcurrentLeaves: 2 }),
    );

    expect(res.status).toBe("cap_exceeded");
    expect(res.agentsSpawned).toBe(1);
    // The run did not finish while a leaf was still in flight.
    expect(fake.inFlight).toBe(0);

    // No journal entry lands AFTER the run is finalized: snapshot now, wait past
    // the leaf delay, and assert the count is unchanged (leaf "a" journaled
    // DURING the drain, before finishRun — not after it).
    const lenAtResolve = journalStore.getJournal("wf-unwind-drain").length;
    await new Promise((r) => setTimeout(r, 150));
    expect(journalStore.getJournal("wf-unwind-drain").length).toBe(
      lenAtResolve,
    );
  });

  test("a cap tripped mid-fan-out CANCELS the in-flight leaf (not just awaits it)", async () => {
    // Same shape, but a signal-aware runner: when the fan-out's internal
    // controller aborts (because the cap tripped), the in-flight leaf "a" is
    // cancelled — it rejects like a real cancelled provider call. The run still
    // ends `cap_exceeded` (the cap sentinel is the FIRST error), a cancelled
    // leaf is NOT journaled, and the run waits for it to settle.
    let inFlight = 0;
    let abortedCount = 0;
    const runner = (async (leafOpts: RunLeafOptions): Promise<LeafResult> => {
      inFlight += 1;
      const sig = leafOpts.signal;
      try {
        await new Promise<void>((resolve, reject) => {
          const fail = (): void => {
            abortedCount += 1;
            const err = new Error("The operation was aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (sig?.aborted) return fail();
          // No timer: if never aborted the leaf stays pending (matches the
          // existing blocking-runner pattern — no leaked timers).
          sig?.addEventListener("abort", fail, { once: true });
        });
        return {
          output: `out:${leafOpts.prompt}`,
          inputTokens: 10,
          outputTokens: 5,
          toolCallCount: 0,
        };
      } finally {
        inFlight -= 1;
      }
    }) as unknown as typeof import("./leaf-runner.js").runLeaf;

    const res = await execute(
      "wf-unwind-cancel",
      `return parallel([leaf("a"), leaf("b")]);`,
      runner,
      configWith({ maxAgentsPerRun: 1, maxConcurrentLeaves: 2 }),
    );

    expect(res.status).toBe("cap_exceeded");
    // The in-flight leaf was cancelled by the fan-out controller and drained.
    expect(abortedCount).toBe(1);
    expect(inFlight).toBe(0);
    // A cancelled leaf is never journaled (neither completed nor failed); the
    // cap leaf throws before journaling — so the journal is empty.
    expect(journalStore.getJournal("wf-unwind-cancel")).toHaveLength(0);
  });
});

describe("executeWorkflow — nested workflow()", () => {
  // Saved workflows live at `<workspace>/workflows/*.workflow.ts`; point the
  // workspace at a temp dir so `workflow(name)` resolves a fixture we control.
  let workspaceDir: string;
  let prevOverride: string | undefined;

  beforeEach(() => {
    resetTables();
    workspaceDir = mkdtempSync(join(tmpdir(), "wf-nest-"));
    prevOverride = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  });

  afterEach(() => {
    if (prevOverride === undefined) delete process.env.VELLUM_WORKSPACE_DIR;
    else process.env.VELLUM_WORKSPACE_DIR = prevOverride;
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeSaved(file: string, source: string): void {
    const dir = join(workspaceDir, "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), source, "utf8");
  }

  test("workflow() runs a saved child inline and returns its result", async () => {
    writeSaved(
      "child.workflow.ts",
      `export const meta = { name: "child", description: "c" };
       return agent("child-task");`,
    );

    const fake = makeFakeRunner();
    const res = await execute(
      "wf-nest-basic",
      `const c = workflow("child", {});
       const p = agent("parent-task");
       return [c, p];`,
      fake.runner,
    );

    expect(res.status).toBe("completed");
    // The child's agent() result threads back into the parent script.
    expect(res.result).toEqual(["out:child-task", "out:parent-task"]);
    // Child leaf ran before the parent's own leaf (inline, same run).
    expect(fake.prompts).toEqual(["child-task", "parent-task"]);
  });

  test("nested leaves draw seq from the SAME run-scoped counter", async () => {
    writeSaved(
      "child.workflow.ts",
      `export const meta = { name: "child", description: "c" };
       return parallel([leaf("c0"), leaf("c1")]);`,
    );

    const fake = makeFakeRunner();
    await execute(
      "wf-nest-seq",
      `agent("p0");
       workflow("child", {});
       return agent("p2");`,
      fake.runner,
    );

    // One contiguous seq sequence across the parent + child boundary.
    const journal = journalStore.getJournal("wf-nest-seq");
    expect(journal.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    // Child leaf labels are attributed to the child workflow.
    const childEntries = journal.filter((e) =>
      ["c0", "c1"].includes((e.request as { prompt: string }).prompt),
    );
    expect(
      childEntries.map(
        (e) => (e.request as { opts: { label?: string } }).opts.label,
      ),
    ).toEqual(["child", "child"]);
  });

  test("parent + child spawns share the agent cap (counted together)", async () => {
    // Child spawns 2 leaves; parent spawns 2 before + would spawn more after.
    // With cap=3, the run trips while running the child's second leaf.
    writeSaved(
      "child.workflow.ts",
      `export const meta = { name: "child", description: "c" };
       return parallel([leaf("c0"), leaf("c1")]);`,
    );

    const fake = makeFakeRunner();
    const res = await execute(
      "wf-nest-cap",
      `agent("p0");
       agent("p1");
       workflow("child", {});
       return agent("never");`,
      fake.runner,
      configWith({ maxAgentsPerRun: 3, maxConcurrentLeaves: 1 }),
    );

    expect(res.status).toBe("cap_exceeded");
    // Exactly the cap's worth ran across BOTH levels: p0, p1, then the child's
    // first leaf — the child's second leaf trips the shared cap.
    expect(res.agentsSpawned).toBe(3);
    expect(fake.prompts).toEqual(["p0", "p1", "c0"]);
  });

  test("calling workflow() from inside a child throws (depth-1 only)", async () => {
    writeSaved(
      "grandchild.workflow.ts",
      `export const meta = { name: "grandchild", description: "g" };
       return agent("gc");`,
    );
    // The child illegally nests another workflow() — depth would be 2.
    writeSaved(
      "child.workflow.ts",
      `export const meta = { name: "child", description: "c" };
       return workflow("grandchild", {});`,
    );

    const fake = makeFakeRunner();
    const res = await execute(
      "wf-nest-depth",
      `return workflow("child", {});`,
      fake.runner,
    );

    // The depth guard fires inside the child; uncaught, it fails the run.
    expect(res.status).toBe("failed");
    // The grandchild never ran.
    expect(fake.prompts).toEqual([]);
  });

  test("workflow() with an unknown name fails the run", async () => {
    const fake = makeFakeRunner();
    const res = await execute(
      "wf-nest-missing",
      `return workflow("ghost", {});`,
      fake.runner,
    );
    expect(res.status).toBe("failed");
    expect(fake.prompts).toEqual([]);
  });
});
