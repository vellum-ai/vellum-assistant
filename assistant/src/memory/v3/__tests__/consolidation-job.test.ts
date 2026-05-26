/**
 * Tests for the memory v3 consolidation surface (PR 19):
 *   - `memoryV3ConsolidateJob` (`../consolidation-job.ts`) — drains the SHARED
 *     `memory/buffer.md` into shared concept pages + the v3 tree, mirroring v2.
 *   - the scheduler retarget in `maybeEnqueueGraphMaintenanceJobs`
 *     (`../../jobs-worker.ts`) — enqueues `memory_v3_consolidate` INSTEAD of
 *     `memory_v2_consolidate` when `memory.v3.write.enabled`, and v2 when off.
 *   - `runIndexMaintenance` / `wouldIntroduceCycle` (`../maintenance.ts`) — the
 *     mechanical no-LLM upkeep: report stale indices, refuse cycle edits.
 *
 * The background-agent handoff (`runBackgroundJob`) is mocked so no real LLM
 * runs — the agent's actual page/tree writes are exercised by the v3 store/
 * validate unit tests; here we drive the same fixture writes deterministically
 * to prove the maintenance + cycle-check semantics. The DB is real (a temp
 * workspace pinned via `VELLUM_WORKSPACE_DIR`) so the scheduler's checkpoint /
 * enqueue path runs end-to-end. Sample content uses generic placeholders
 * (Alice/Bob).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

import { createMockLoggerModule } from "../../../__tests__/helpers/mock-logger.js";

mock.module("../../../util/logger.js", () => createMockLoggerModule());

// ── runBackgroundJob mock ───────────────────────────────────────────
//
// The consolidation handler delegates bootstrap + processMessage + timeout +
// classification to runBackgroundJob. We stub it so no LLM runs and assert the
// surface (prompt, callSite, source, suppression) it was called with.
let runnerCalls = 0;
let runnerLastArgs: Record<string, unknown> | null = null;
let runnerImpl: () => Promise<{
  conversationId: string;
  ok: boolean;
  error?: Error;
  errorKind?: string;
}> = async () => ({ conversationId: "conv-1", ok: true });

mock.module("../../../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: Record<string, unknown>) => {
    runnerCalls += 1;
    runnerLastArgs = opts;
    return runnerImpl();
  },
}));

// ── Workspace pin (precedes the DB import) ──────────────────────────
let tmpWorkspace: string;
let previousWorkspaceEnv: string | undefined;

beforeAll(() => {
  tmpWorkspace = mkdtempSync(join(tmpdir(), "memory-v3-consolidate-test-"));
  previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;
});

afterAll(() => {
  if (previousWorkspaceEnv === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
  }
  rmSync(tmpWorkspace, { recursive: true, force: true });
});

const { getDb } = await import("../../db-connection.js");
const { initializeDb } = await import("../../db-init.js");
const { resetTestTables } = await import("../../raw-query.js");
const { memoryJobs } = await import("../../schema.js");
const { applyNestedDefaults } = await import("../../../config/loader.js");
const { setMemoryCheckpoint, deleteMemoryCheckpoint } =
  await import("../../checkpoints.js");
const { maybeEnqueueGraphMaintenanceJobs } =
  await import("../../jobs-worker.js");
const { memoryV3ConsolidateJob } = await import("../consolidation-job.js");
const { CUTOFF_PLACEHOLDER, CONSOLIDATION_PROMPT } =
  await import("../prompts/consolidation.js");
const { runIndexMaintenance, wouldIntroduceCycle } =
  await import("../maintenance.js");
const { writePage } = await import("../../v2/page-store.js");
const { invalidatePageIndex } = await import("../../v2/page-index.js");
const { invalidateEdgeIndex } = await import("../../v2/edge-index.js");
const { getTreeIndex, invalidateTreeIndex } = await import("../tree-index.js");
const { writeNode, getTreeDir, ROOT_NODE_ID } =
  await import("../tree-store.js");

const V2_CHECKPOINT = "memory_v2_consolidate_last_run";
const V3_CHECKPOINT = "memory_v3_consolidate_last_run";

// The job handler reads only `config.memory.v3.write.enabled` and the shared
// `config.memory.v2.consolidation_prompt_path`; a minimal stand-in covers both
// call sites without materializing the full default config.
type JobConfig = Parameters<typeof memoryV3ConsolidateJob>[1];
const CONFIG_V3_ON = {
  memory: {
    v2: { consolidation_prompt_path: null },
    v3: { write: { enabled: true } },
  },
} as JobConfig;
const CONFIG_V3_OFF = {
  memory: {
    v2: { consolidation_prompt_path: null },
    v3: { write: { enabled: false } },
  },
} as JobConfig;

function makeJob(): Parameters<typeof memoryV3ConsolidateJob>[0] {
  return {
    id: "consolidate-1",
    type: "memory_v3_consolidate",
    payload: {},
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const memoryDir = () => join(tmpWorkspace, "memory");
const lockPath = () =>
  join(tmpWorkspace, "memory", ".v3-state", "consolidation.lock");
const bufferPath = () => join(tmpWorkspace, "memory", "buffer.md");

function countPendingJobs(type: string): number {
  return getDb()
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, type))
    .all().length;
}

function buildSchedulerConfig(v3WriteEnabled: boolean) {
  const cfg = applyNestedDefaults({});
  cfg.memory.v2.enabled = true;
  cfg.memory.v2.consolidation_interval_hours = 1;
  cfg.memory.v2.consolidation_max_buffer_lines = null;
  cfg.memory.v3.write.enabled = v3WriteEnabled;
  cfg.memory.v3.write.consolidateIntervalMs = 60 * 60 * 1000;
  return cfg;
}

function resetCaches(): void {
  invalidateTreeIndex();
  invalidatePageIndex();
  invalidateEdgeIndex();
}

initializeDb();

beforeEach(() => {
  rmSync(memoryDir(), { recursive: true, force: true });
  mkdirSync(join(memoryDir(), ".v3-state"), { recursive: true });
  mkdirSync(join(memoryDir(), "concepts"), { recursive: true });
  resetTestTables("memory_jobs", "memory_checkpoints");
  resetCaches();

  runnerCalls = 0;
  runnerLastArgs = null;
  runnerImpl = async () => ({ conversationId: "conv-1", ok: true });
});

// ---------------------------------------------------------------------------
// memoryV3ConsolidateJob
// ---------------------------------------------------------------------------

describe("memoryV3ConsolidateJob — flag off (v3 write disabled)", () => {
  test("returns disabled without invoking the runner or touching the lock", async () => {
    writeFileSync(bufferPath(), "- [Apr 27, 9:00 AM] Alice prefers VS Code.\n");

    const result = await memoryV3ConsolidateJob(makeJob(), CONFIG_V3_OFF);

    expect(result).toEqual({ kind: "disabled" });
    expect(runnerCalls).toBe(0);
    expect(existsSync(lockPath())).toBe(false);
    expect(countPendingJobs("memory_v3_index_maintenance")).toBe(0);
    expect(countPendingJobs("memory_v2_reembed")).toBe(0);
  });
});

describe("memoryV3ConsolidateJob — empty shared buffer", () => {
  test("returns empty_buffer when the shared buffer.md is missing", async () => {
    expect(existsSync(bufferPath())).toBe(false);

    const result = await memoryV3ConsolidateJob(makeJob(), CONFIG_V3_ON);

    expect(result).toEqual({ kind: "empty_buffer" });
    expect(runnerCalls).toBe(0);
    expect(existsSync(lockPath())).toBe(false);
  });
});

describe("memoryV3ConsolidateJob — non-empty shared buffer", () => {
  beforeEach(() => {
    writeFileSync(
      bufferPath(),
      "- [Apr 27, 9:00 AM] Alice prefers VS Code over Vim.\n" +
        "- [Apr 27, 9:05 AM] Bob ships at end of day.\n",
    );
  });

  test("invokes runBackgroundJob with the v3 tree-authoring prompt and suppression", async () => {
    const result = await memoryV3ConsolidateJob(makeJob(), CONFIG_V3_ON);

    expect(result.kind).toBe("invoked");
    expect(runnerCalls).toBe(1);
    expect(runnerLastArgs?.callSite).toBe("mainAgent");
    expect(runnerLastArgs?.origin).toBe("memory_consolidation");
    // Shared consolidation conversation source (recognized by the route layer).
    expect(runnerLastArgs?.source).toBe("memory_v2_consolidation");
    expect(runnerLastArgs?.suppressFailureNotifications).toBe(true);
    expect(runnerLastArgs?.trustContext).toEqual({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });

    const prompt = runnerLastArgs?.prompt as string;
    // Cutoff substituted (placeholder gone), buffer-format timestamp present.
    expect(prompt).not.toContain(CUTOFF_PLACEHOLDER);
    expect(prompt).toMatch(/\b[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)\b/);
    // v3-distinctive: the prompt routes into the v3 tree, not just flat pages.
    expect(prompt).toContain("memory/tree/");
    // Standing-context files preserved exactly as v2 (shared).
    expect(prompt).toContain("memory/buffer.md");
    expect(prompt).toContain("memory/recent.md");
    expect(prompt).toContain("memory/essentials.md");
    expect(prompt).toContain("memory/threads.md");
  });

  test("enqueues index-maintenance + page-reembed follow-ups on success", async () => {
    const result = await memoryV3ConsolidateJob(makeJob(), CONFIG_V3_ON);

    expect(result.kind).toBe("invoked");
    if (result.kind === "invoked") {
      expect(result.followUpJobIds).toHaveLength(2);
    }
    expect(countPendingJobs("memory_v3_index_maintenance")).toBe(1);
    expect(countPendingJobs("memory_v2_reembed")).toBe(1);
  });

  test("releases the lock after a successful invocation", async () => {
    const result = await memoryV3ConsolidateJob(makeJob(), CONFIG_V3_ON);
    expect(result.kind).toBe("invoked");
    expect(existsSync(lockPath())).toBe(false);
  });

  test("returns run_failed and skips follow-ups when the runner reports failure", async () => {
    runnerImpl = async () => ({
      conversationId: "conv-1",
      ok: false,
      error: new Error("simulated runner failure"),
      errorKind: "exception",
    });

    const result = await memoryV3ConsolidateJob(makeJob(), CONFIG_V3_ON);

    expect(result.kind).toBe("run_failed");
    if (result.kind === "run_failed") {
      expect(result.reason).toBe("simulated runner failure");
    }
    expect(countPendingJobs("memory_v3_index_maintenance")).toBe(0);
    expect(countPendingJobs("memory_v2_reembed")).toBe(0);
    expect(existsSync(lockPath())).toBe(false);
  });

  test("a live lock holder blocks a second concurrent invocation", async () => {
    writeFileSync(lockPath(), `${process.pid} 1700000000000\n`);

    const result = await memoryV3ConsolidateJob(makeJob(), CONFIG_V3_ON);

    expect(result.kind).toBe("locked");
    expect(runnerCalls).toBe(0);
    expect(existsSync(lockPath())).toBe(true);
  });
});

describe("CONSOLIDATION_PROMPT (v3)", () => {
  test("keeps the standing-context outputs identical to v2", () => {
    expect(CONSOLIDATION_PROMPT).toContain(CUTOFF_PLACEHOLDER);
    expect(CONSOLIDATION_PROMPT).toContain("memory/essentials.md");
    expect(CONSOLIDATION_PROMPT).toContain("memory/threads.md");
    expect(CONSOLIDATION_PROMPT).toContain("memory/recent.md");
    expect(CONSOLIDATION_PROMPT).toContain("memory/buffer.md");
    expect(CONSOLIDATION_PROMPT).toContain("≤2000 chars");
  });

  test("adds the v3 tree-authoring routing the shared concept pages get indexed into", () => {
    expect(CONSOLIDATION_PROMPT).toContain("memory/tree/");
    expect(CONSOLIDATION_PROMPT).toContain("children");
    // The DAG cycle / reachability discipline must be in the prompt.
    expect(CONSOLIDATION_PROMPT.toLowerCase()).toContain("cycle");
    expect(CONSOLIDATION_PROMPT).toContain(ROOT_NODE_ID);
  });
});

// ---------------------------------------------------------------------------
// Scheduler retarget — shared buffer drained by exactly one consolidator.
// ---------------------------------------------------------------------------

describe("maybeEnqueueGraphMaintenanceJobs — v2/v3 consolidator retarget", () => {
  test("enqueues v3 (not v2) when memory.v3.write.enabled is on", () => {
    const config = buildSchedulerConfig(true);
    deleteMemoryCheckpoint(V3_CHECKPOINT);
    deleteMemoryCheckpoint(V2_CHECKPOINT);

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_v3_consolidate")).toBe(1);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
    // v1 entries stay suppressed (v2 active).
    expect(countPendingJobs("graph_decay")).toBe(0);
  });

  test("enqueues v2 (not v3) when memory.v3.write.enabled is off — v2 path unchanged", () => {
    const config = buildSchedulerConfig(false);
    deleteMemoryCheckpoint(V3_CHECKPOINT);
    deleteMemoryCheckpoint(V2_CHECKPOINT);

    maybeEnqueueGraphMaintenanceJobs(config, Date.now());

    expect(countPendingJobs("memory_v2_consolidate")).toBe(1);
    expect(countPendingJobs("memory_v3_consolidate")).toBe(0);
  });

  test("v3 size trigger drains the shared buffer when the line count is crossed", () => {
    const config = buildSchedulerConfig(true);
    config.memory.v2.consolidation_max_buffer_lines = 5;

    const now = Date.now();
    // Recent checkpoint so the time-based trigger does not fire — only size.
    setMemoryCheckpoint(V3_CHECKPOINT, String(now - 60_000));
    const entries = Array.from(
      { length: 10 },
      (_, i) => `- [Jan 15, 2:${String(i).padStart(2, "0")} PM] note ${i}`,
    );
    writeFileSync(bufferPath(), entries.join("\n") + "\n");

    maybeEnqueueGraphMaintenanceJobs(config, now);

    expect(countPendingJobs("memory_v3_consolidate")).toBe(1);
    expect(countPendingJobs("memory_v2_consolidate")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Maintenance — cycle refusal + stale-index reporting (mechanical, no LLM).
// ---------------------------------------------------------------------------

describe("wouldIntroduceCycle", () => {
  test("refuses an edge that would close a loop (child already reaches parent)", async () => {
    // _root → node:a → node:b. Adding b → a would close a → b → a.
    await writeNode(tmpWorkspace, {
      id: ROOT_NODE_ID,
      frontmatter: { children: ["node:a"] },
      body: "root",
    });
    await writeNode(tmpWorkspace, {
      id: "a",
      frontmatter: { children: ["node:b"] },
      body: "a",
    });
    await writeNode(tmpWorkspace, {
      id: "b",
      frontmatter: { children: [] },
      body: "b",
    });
    resetCaches();
    const tree = await getTreeIndex(tmpWorkspace);

    // b → a would create a cycle; a → b already exists (DAG-safe re-add).
    expect(wouldIntroduceCycle(tree, "b", "a")).toBe(true);
    // A self-edge is trivially a cycle.
    expect(wouldIntroduceCycle(tree, "a", "a")).toBe(true);
    // A fresh leaf edge does not introduce a cycle.
    expect(wouldIntroduceCycle(tree, "b", "c")).toBe(false);
    // Adding a second parent for b (DAG, not cycle) is allowed.
    expect(wouldIntroduceCycle(tree, ROOT_NODE_ID, "b")).toBe(false);
  });
});

describe("runIndexMaintenance", () => {
  test("reports a stale composed index (parent mtime predates a child)", async () => {
    // _root → node:people → page:alice. Make `people` (the parent) older than
    // _root so the parent's composed index is stale relative to a child node.
    await writeNode(tmpWorkspace, {
      id: ROOT_NODE_ID,
      frontmatter: { children: ["node:people"] },
      body: "root",
    });
    await writeNode(tmpWorkspace, {
      id: "people",
      frontmatter: { children: ["page:alice"] },
      body: "people",
    });
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "alice",
    });

    // Pin mtimes: _root newer than its child `people` so _root is flagged.
    const treeDir = getTreeDir(tmpWorkspace);
    const old = new Date(1_000_000_000_000);
    const fresh = new Date(2_000_000_000_000);
    await utimes(join(treeDir, "people.md"), fresh, fresh);
    await utimes(join(treeDir, `${ROOT_NODE_ID}.md`), old, old);
    resetCaches();

    const result = await runIndexMaintenance(tmpWorkspace);

    expect(result.staleIndexCount).toBeGreaterThanOrEqual(1);
    expect(
      result.report.staleIndex.some(
        (s) => s.node === ROOT_NODE_ID && s.child === "people",
      ),
    ).toBe(true);
    // Clean tree otherwise: alice is reachable, refs resolve, no cycles.
    expect(result.cycleCount).toBe(0);
    expect(result.danglingChildRefCount).toBe(0);
    expect(result.orphanPageCount).toBe(0);
  });

  test("returns a clean report for a well-formed tree", async () => {
    await writeNode(tmpWorkspace, {
      id: ROOT_NODE_ID,
      frontmatter: { children: ["page:alice"] },
      body: "root",
    });
    await writePage(tmpWorkspace, {
      slug: "alice",
      frontmatter: { edges: [], ref_files: [], ref_urls: [] },
      body: "alice",
    });
    resetCaches();

    const result = await runIndexMaintenance(tmpWorkspace);

    expect(result.cycleCount).toBe(0);
    expect(result.danglingChildRefCount).toBe(0);
    expect(result.orphanPageCount).toBe(0);
    expect(result.unknownEdgeTargetCount).toBe(0);
  });
});
