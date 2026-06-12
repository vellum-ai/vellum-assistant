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
