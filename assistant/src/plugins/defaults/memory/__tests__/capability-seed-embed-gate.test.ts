/**
 * Capability-node seeding across memory tiers: the graph-node upserts run on
 * every tier (the `list_memory` surface reads capability nodes regardless of
 * tier), but `embed_graph_node` rows target the v1 Qdrant collection and
 * dispatch discards them while concept-page memory is active — so the seeder
 * writes those rows only when v1 is the active tier.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

const tmpWorkspace = mkdtempSync(join(tmpdir(), "capability-seed-embed-gate-"));
const previousWorkspaceEnv = process.env.VELLUM_WORKSPACE_DIR;
process.env.VELLUM_WORKSPACE_DIR = tmpWorkspace;

const { setConfig } =
  await import("../../../../__tests__/helpers/set-config.js");
const { getMemoryDb } =
  await import("../../../../persistence/db-connection.js");
const { initializeDb } = await import("../../../../persistence/db-init.js");
const { memoryGraphNodes, memoryJobs } =
  await import("../../../../persistence/schema/index.js");
const { seedCliGraphNodes } = await import("../graph/capability-seed.js");

function countEmbedGraphNodeJobs(): number {
  return getMemoryDb()!
    .select()
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "embed_graph_node"))
    .all().length;
}

function countCapabilityNodes(): number {
  return getMemoryDb()!
    .select()
    .from(memoryGraphNodes)
    .where(eq(memoryGraphNodes.type, "procedural"))
    .all().length;
}

describe("capability seeding embed_graph_node gate", () => {
  beforeAll(async () => {
    await initializeDb();
  }, 30_000);

  afterAll(() => {
    if (previousWorkspaceEnv === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceEnv;
    }
    rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
    getMemoryDb()!.run("DELETE FROM memory_graph_nodes");
  });

  test("v3-live config: nodes are upserted but no embed_graph_node rows are enqueued", async () => {
    setConfig("memory", { v3: { live: true } });

    await seedCliGraphNodes();

    expect(countCapabilityNodes()).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(0);
  });

  test("v1 config: newly created capability nodes enqueue embed_graph_node rows", async () => {
    setConfig("memory", { v2: { enabled: false }, v3: { live: false } });

    await seedCliGraphNodes();

    const nodes = countCapabilityNodes();
    expect(nodes).toBeGreaterThan(0);
    expect(countEmbedGraphNodeJobs()).toBe(nodes);
  });
});
