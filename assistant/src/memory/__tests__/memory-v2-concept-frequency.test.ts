import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

let listPagesImpl: (workspaceDir: string) => Promise<string[]> = async () => [];

mock.module("../v2/page-store.js", () => ({
  listPages: (workspaceDir: string) => listPagesImpl(workspaceDir),
}));

import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import {
  type MemoryV2ConceptRowRecord,
  recordMemoryV2ActivationLog,
} from "../memory-v2-activation-log-store.js";
import { getConceptFrequencySummary } from "../memory-v2-concept-frequency.js";
import { memoryV2ActivationLogs } from "../schema.js";
import { sampleConfig } from "./fixtures/memory-v2-activation-fixtures.js";

initializeDb();

const WORKSPACE = "/tmp/memory-v2-concept-frequency-test";

function makeConcept(
  slug: string,
  status: MemoryV2ConceptRowRecord["status"],
): MemoryV2ConceptRowRecord {
  return {
    slug,
    finalActivation: 0.5,
    ownActivation: 0.4,
    priorActivation: 0.1,
    simUser: 0.3,
    simAssistant: 0.2,
    simNow: 0.1,
    simUserRerankBoost: 0,
    simAssistantRerankBoost: 0,
    inRerankPool: false,
    spreadContribution: 0.1,
    source: "ann_top50",
    status,
  };
}

function resetTables(): void {
  getDb().delete(memoryV2ActivationLogs).run();
}

describe("memory-v2-concept-frequency", () => {
  beforeEach(() => {
    resetTables();
    listPagesImpl = async () => [];
  });

  test("aggregates per-status counts across multiple turns", async () => {
    const conv = "conv-1";
    recordMemoryV2ActivationLog({
      conversationId: conv,
      turn: 1,
      mode: "context-load",
      concepts: [
        makeConcept("alice", "injected"),
        makeConcept("bob", "not_injected"),
      ],
      config: sampleConfig,
    });
    recordMemoryV2ActivationLog({
      conversationId: conv,
      turn: 2,
      mode: "per-turn",
      concepts: [
        makeConcept("alice", "in_context"),
        makeConcept("bob", "injected"),
      ],
      config: sampleConfig,
    });
    recordMemoryV2ActivationLog({
      conversationId: conv,
      turn: 3,
      mode: "per-turn",
      concepts: [
        makeConcept("alice", "injected"),
        makeConcept("charlie", "page_missing"),
      ],
      config: sampleConfig,
    });

    listPagesImpl = async () => ["alice", "bob", "delta"];

    const result = await getConceptFrequencySummary(WORKSPACE, {});

    expect(result.totals.logCount).toBe(3);
    expect(result.totals.conceptOccurrences).toBe(6);
    expect(result.filters).toEqual({ conversationId: null, sinceMs: null });

    const bySlug = new Map(result.concepts.map((c) => [c.slug, c]));

    expect(bySlug.get("alice")!.counts).toEqual({
      injected: 2,
      in_context: 1,
      not_injected: 0,
      page_missing: 0,
    });
    expect(bySlug.get("alice")!.totalEvaluations).toBe(3);
    expect(bySlug.get("alice")!.onDisk).toBe(true);
    expect(bySlug.get("alice")!.lastInjectedAt).not.toBeNull();

    expect(bySlug.get("bob")!.counts).toEqual({
      injected: 1,
      in_context: 0,
      not_injected: 1,
      page_missing: 0,
    });
    expect(bySlug.get("bob")!.totalEvaluations).toBe(2);
    expect(bySlug.get("bob")!.onDisk).toBe(true);

    expect(bySlug.get("charlie")!.counts).toEqual({
      injected: 0,
      in_context: 0,
      not_injected: 0,
      page_missing: 1,
    });
    expect(bySlug.get("charlie")!.onDisk).toBe(false);
    expect(bySlug.get("charlie")!.lastInjectedAt).toBeNull();

    // Sorted by totalEvaluations desc — alice (3) before bob (2) before charlie (1).
    expect(result.concepts.map((c) => c.slug)).toEqual([
      "alice",
      "bob",
      "charlie",
    ]);

    // delta is on disk but never appeared in any log row.
    expect(result.neverEvaluatedSlugs).toEqual(["delta"]);
  });

  test("conversationId filter narrows aggregation", async () => {
    recordMemoryV2ActivationLog({
      conversationId: "conv-a",
      turn: 1,
      mode: "per-turn",
      concepts: [makeConcept("alice", "injected")],
      config: sampleConfig,
    });
    recordMemoryV2ActivationLog({
      conversationId: "conv-b",
      turn: 1,
      mode: "per-turn",
      concepts: [
        makeConcept("alice", "injected"),
        makeConcept("alice", "injected"),
      ],
      config: sampleConfig,
    });

    listPagesImpl = async () => ["alice"];

    const all = await getConceptFrequencySummary(WORKSPACE, {});
    expect(all.totals.logCount).toBe(2);
    expect(all.concepts[0]!.counts.injected).toBe(3);
    expect(all.filters.conversationId).toBeNull();

    const onlyA = await getConceptFrequencySummary(WORKSPACE, {
      conversationId: "conv-a",
    });
    expect(onlyA.totals.logCount).toBe(1);
    expect(onlyA.concepts[0]!.counts.injected).toBe(1);
    expect(onlyA.filters.conversationId).toBe("conv-a");

    const onlyB = await getConceptFrequencySummary(WORKSPACE, {
      conversationId: "conv-b",
    });
    expect(onlyB.totals.logCount).toBe(1);
    expect(onlyB.concepts[0]!.counts.injected).toBe(2);
  });

  test("sinceMs filter excludes older log rows", async () => {
    recordMemoryV2ActivationLog({
      conversationId: "conv-1",
      turn: 1,
      mode: "per-turn",
      concepts: [makeConcept("alice", "injected")],
      config: sampleConfig,
    });
    // Backdate the just-written row — recordMemoryV2ActivationLog uses Date.now().
    getDb().update(memoryV2ActivationLogs).set({ createdAt: 1_000 }).run();

    recordMemoryV2ActivationLog({
      conversationId: "conv-1",
      turn: 2,
      mode: "per-turn",
      concepts: [makeConcept("alice", "injected")],
      config: sampleConfig,
    });

    listPagesImpl = async () => ["alice"];

    const all = await getConceptFrequencySummary(WORKSPACE, {});
    expect(all.totals.logCount).toBe(2);
    expect(all.concepts[0]!.counts.injected).toBe(2);

    const recent = await getConceptFrequencySummary(WORKSPACE, {
      sinceMs: 10_000,
    });
    expect(recent.totals.logCount).toBe(1);
    expect(recent.concepts[0]!.counts.injected).toBe(1);
    expect(recent.filters.sinceMs).toBe(10_000);
  });

  test("never-evaluated list excludes slugs that appeared in any status", async () => {
    recordMemoryV2ActivationLog({
      conversationId: "conv-1",
      turn: 1,
      mode: "per-turn",
      concepts: [
        makeConcept("alice", "injected"),
        makeConcept("bob", "not_injected"),
        makeConcept("charlie", "page_missing"),
      ],
      config: sampleConfig,
    });

    listPagesImpl = async () => ["alice", "bob", "delta", "echo"];

    const result = await getConceptFrequencySummary(WORKSPACE, {});
    // bob was scored but rejected — still excluded from neverEvaluated.
    expect(result.neverEvaluatedSlugs).toEqual(["delta", "echo"]);
  });

  test("returns empty result when no logs exist", async () => {
    listPagesImpl = async () => ["alice", "bob"];

    const result = await getConceptFrequencySummary(WORKSPACE, {});
    expect(result.totals).toEqual({ logCount: 0, conceptOccurrences: 0 });
    expect(result.concepts).toEqual([]);
    expect(result.neverEvaluatedSlugs).toEqual(["alice", "bob"]);
  });

  test("flags slugs that appear in logs but no longer have a page on disk", async () => {
    recordMemoryV2ActivationLog({
      conversationId: "conv-1",
      turn: 1,
      mode: "per-turn",
      concepts: [makeConcept("ghost", "injected")],
      config: sampleConfig,
    });

    listPagesImpl = async () => ["alice"];

    const result = await getConceptFrequencySummary(WORKSPACE, {});
    const ghost = result.concepts.find((c) => c.slug === "ghost")!;
    expect(ghost.onDisk).toBe(false);
    expect(ghost.counts.injected).toBe(1);
  });
});
