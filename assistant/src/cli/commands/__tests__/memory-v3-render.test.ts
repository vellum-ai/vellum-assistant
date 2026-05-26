import { describe, expect, test } from "bun:test";

import type {
  LlmCallRecord,
  MemoryV3SimulateResult,
  MemoryV3TreeResult,
  MemoryV3ValidateResult,
} from "../../../runtime/routes/memory-v3-routes.js";
import {
  renderLlmCalls,
  renderSimulation,
  renderTree,
  renderValidationReport,
  reportHasDefects,
} from "../memory-v3-render.js";

function cleanReport(): MemoryV3ValidateResult {
  return {
    danglingChildRefs: [],
    danglingChildRefCount: 0,
    orphanPages: [],
    orphanPageCount: 0,
    cycles: [],
    cycleCount: 0,
    staleIndex: [],
    staleIndexCount: 0,
    unknownEdgeTargets: [],
    unknownEdgeTargetCount: 0,
  };
}

describe("memory v3 — renderValidationReport", () => {
  test("renders 'none' for every empty category", () => {
    const out = renderValidationReport(cleanReport());
    expect(out).toContain("Memory v3 Tree Validation");
    expect(out).toContain("Dangling child refs: none");
    expect(out).toContain("Orphan pages: none");
    expect(out).toContain("Cycles: none");
    expect(out).toContain("Stale index: none");
    expect(out).toContain("Unknown edge targets: none");
  });

  test("renders counts and offending ids for each defect category", () => {
    const report: MemoryV3ValidateResult = {
      danglingChildRefs: [{ node: "people", ref: "ghost", kind: "node" }],
      danglingChildRefCount: 1,
      orphanPages: ["stray-page"],
      orphanPageCount: 1,
      cycles: [{ from: "a", to: "b" }],
      cycleCount: 1,
      staleIndex: [
        { node: "root", child: "people", nodeMtimeMs: 1, childMtimeMs: 2 },
      ],
      staleIndexCount: 1,
      unknownEdgeTargets: [{ from: "p1", to: "missing" }],
      unknownEdgeTargetCount: 1,
    };
    const out = renderValidationReport(report);
    expect(out).toContain("Dangling child refs: 1");
    expect(out).toContain("people → node:ghost");
    expect(out).toContain("Orphan pages: 1");
    expect(out).toContain("- stray-page");
    expect(out).toContain("Cycles: 1");
    expect(out).toContain("a → b");
    expect(out).toContain("Stale index: 1");
    expect(out).toContain("root (older than child people)");
    expect(out).toContain("Unknown edge targets: 1");
    expect(out).toContain("p1 → missing");
  });
});

describe("memory v3 — reportHasDefects", () => {
  test("false for a clean report", () => {
    expect(reportHasDefects(cleanReport())).toBe(false);
  });

  test("true when any single category is non-empty", () => {
    const report = cleanReport();
    report.orphanPageCount = 1;
    report.orphanPages = ["x"];
    expect(reportHasDefects(report)).toBe(true);
  });
});

describe("memory v3 — renderTree", () => {
  test("renders an indented tree descending node and page children", () => {
    const view: MemoryV3TreeResult = {
      root: "_root",
      nodes: [
        {
          id: "_root",
          children: [
            { kind: "node", ref: "people" },
            { kind: "page", ref: "overview" },
          ],
        },
        {
          id: "people",
          children: [{ kind: "page", ref: "alice" }],
        },
      ],
    };
    const out = renderTree(view);
    expect(out).toBe(
      ["node:_root", "  node:people", "    page:alice", "  page:overview"].join(
        "\n",
      ),
    );
  });

  test("marks a shared DAG sub-node as a re-entry rather than re-expanding", () => {
    const view: MemoryV3TreeResult = {
      root: "_root",
      nodes: [
        {
          id: "_root",
          children: [
            { kind: "node", ref: "a" },
            { kind: "node", ref: "b" },
          ],
        },
        { id: "a", children: [{ kind: "node", ref: "shared" }] },
        { id: "b", children: [{ kind: "node", ref: "shared" }] },
        { id: "shared", children: [{ kind: "page", ref: "leaf" }] },
      ],
    };
    const out = renderTree(view);
    // First reach under `a` expands; second reach under `b` is a marked re-entry.
    expect(out).toContain("  node:a\n    node:shared\n      page:leaf");
    expect(out).toContain("node:shared (↑ already shown)");
    // The leaf page is expanded exactly once.
    expect(out.match(/page:leaf/g)?.length).toBe(1);
  });

  test("bounds output on a cycle instead of looping forever", () => {
    const view: MemoryV3TreeResult = {
      root: "_root",
      nodes: [
        { id: "_root", children: [{ kind: "node", ref: "a" }] },
        { id: "a", children: [{ kind: "node", ref: "_root" }] },
      ],
    };
    const out = renderTree(view);
    expect(out).toContain("node:_root (↑ already shown)");
  });

  test("flags a child ref whose target node is missing", () => {
    const view: MemoryV3TreeResult = {
      root: "_root",
      nodes: [{ id: "_root", children: [{ kind: "node", ref: "ghost" }] }],
    };
    const out = renderTree(view);
    expect(out).toContain("node:ghost (missing)");
  });

  test("lists nodes unreachable from the root", () => {
    const view: MemoryV3TreeResult = {
      root: "_root",
      nodes: [
        { id: "_root", children: [] },
        { id: "floating", children: [] },
      ],
    };
    const out = renderTree(view);
    expect(out).toContain("Unreachable nodes (1):");
    expect(out).toContain("- node:floating");
  });
});

function simResult(): MemoryV3SimulateResult {
  return {
    query: "what should we ship next",
    selectedSlugs: ["page-tree", "page-hot", "page-edge"],
    sourceBySlug: {
      "page-hot": "hot",
      "page-tree": "tree",
      "page-edge": "edge",
    },
    trace: {
      passes: [
        {
          passNumber: 1,
          scouts: [
            { lane: "hot", slugs: ["page-hot"] },
            { lane: "sparse", slugs: [] },
            { lane: "dense", slugs: ["d1", "d2"] },
          ],
          treeLevels: [
            {
              node: "",
              considered: ["people", "frames", "objects"],
              descended: ["people", "frames"],
              skipped: ["objects"],
              reasoning: "query is about planning",
            },
          ],
          edgeExpansions: [{ from: "page-tree", pulled: ["page-edge"] }],
          gate: { decision: "more", questions: ["narrow to roadmap?"] },
        },
        {
          passNumber: 2,
          scouts: [{ lane: "hot", slugs: [] }],
          gate: { decision: "ready" },
        },
      ],
    },
    cost: { ms: 1234 },
    failureReason: null,
    llmCalls: [],
    effectiveConfig: {
      passCap: 3,
      lanes: { hot: true, sparse: true, dense: true, tree: true, edges: false },
    },
  };
}

describe("memory v3 — renderSimulation", () => {
  test("renders query, effective config, per-pass trace, and grouped selection", () => {
    const out = renderSimulation(simResult());
    expect(out).toContain("Memory v3 Retrieval Simulation");
    expect(out).toContain('Query: "what should we ship next"');
    expect(out).toContain("passCap: 3");
    // A disabled lane is surfaced in an `(off: …)` suffix.
    expect(out).toContain("lanes: hot, sparse, dense, tree  (off: edges)");

    expect(out).toContain("Passes: 2");
    expect(out).toContain("Pass 1");
    expect(out).toContain("scouts: hot=1  sparse=0  dense=2");
    // The root tree level ("" node) prints as [root] with branch counts.
    expect(out).toContain("[root]: considered 3, descended 2, skipped 1");
    expect(out).toContain("→ people, frames");
    expect(out).toContain("reason: query is about planning");
    expect(out).toContain("edges: 1 seed(s) expanded, 1 pulled");
    expect(out).toContain("gate: more");
    expect(out).toContain("? narrow to roadmap?");
    expect(out).toContain("gate: ready");

    expect(out).toContain("Selected: 3 page(s)");
    expect(out).toContain("Cost: 1234 ms");
  });

  test("groups selected slugs by provenance lane in fanout order", () => {
    const out = renderSimulation(simResult());
    const hotAt = out.indexOf("hot (1)");
    const treeAt = out.indexOf("tree (1)");
    const edgeAt = out.indexOf("edge (1)");
    expect(hotAt).toBeGreaterThan(-1);
    expect(treeAt).toBeGreaterThan(-1);
    expect(edgeAt).toBeGreaterThan(-1);
    // hot precedes tree precedes edge in SIMULATE_LANE_ORDER.
    expect(hotAt).toBeLessThan(treeAt);
    expect(treeAt).toBeLessThan(edgeAt);
  });

  test("renders all lanes inline when none are disabled", () => {
    const result = simResult();
    result.effectiveConfig.lanes.edges = true;
    const out = renderSimulation(result);
    expect(out).toContain("lanes: hot, sparse, dense, tree, edges");
    expect(out).not.toContain("(off:");
  });

  test("surfaces a failure reason when the loop degraded", () => {
    const result = simResult();
    result.failureReason = "dense filter failed open";
    const out = renderSimulation(result);
    expect(out).toContain("Failure: dense filter failed open");
  });
});

function llmCall(over: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    pass: 1,
    lane: "gate",
    callSite: "memoryV3Gate",
    request: {
      systemPrompt: "SYS-PROMPT",
      messages: [
        { role: "user", content: [{ type: "text", text: "USER-MSG" }] },
      ],
      tools: [
        {
          name: "decide_selection",
          description: "decide",
          input_schema: { type: "object", properties: {} },
        },
      ],
    },
    response: {
      model: "stub-model",
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "decide_selection",
          input: { decision: "ready", selected_slugs: ["a"] },
        },
      ],
    },
    ms: 42,
    ...over,
  };
}

describe("memory v3 — renderLlmCalls", () => {
  test("compact: one line per call with lane, node, and tool summary", () => {
    const out = renderLlmCalls(
      [
        llmCall(),
        llmCall({
          lane: "descent",
          callSite: "memoryV3Descent",
          node: "people",
        }),
      ],
      { full: false },
    );
    expect(out).toContain("LLM calls (2):");
    expect(out).toContain("pass1 · gate");
    expect(out).toContain("pass1 · descent · node=people");
    expect(out).toContain("decide_selection");
    expect(out).toContain("42ms");
    // Compact mode must not dump the full system prompt.
    expect(out).not.toContain("SYS-PROMPT");
  });

  test("full: includes system prompt, messages, tools, and tool_use input", () => {
    const out = renderLlmCalls([llmCall()], { full: true });
    expect(out).toContain("SYS-PROMPT");
    expect(out).toContain("USER-MSG");
    expect(out).toContain("decide_selection");
    expect(out).toContain('"decision"');
  });

  test("renders 'none' when there are no calls", () => {
    expect(renderLlmCalls([], { full: false })).toBe("LLM calls: none");
  });
});
