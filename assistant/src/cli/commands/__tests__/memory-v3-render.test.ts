import { describe, expect, test } from "bun:test";

import type {
  MemoryV3TreeResult,
  MemoryV3ValidateResult,
} from "../../../runtime/routes/memory-v3-routes.js";
import {
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
