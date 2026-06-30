import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../../../../../config/loader.js", () => ({
  getConfig: () => ({ memory: { enabled: false } }),
}));

import type { AssistantConfig } from "../../../../../config/types.js";
import { getDb } from "../../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../../persistence/db-init.js";
import {
  conversations,
  memoryV2ActivationLogs,
  messages,
} from "../../../../../persistence/schema/index.js";
import type { MemoryV2ConceptRowRecord } from "../../memory-v2-activation-log-store.js";
import { runComparisonOverHistory } from "../harness/compare.js";
import type { RetrievalOutput, Retriever } from "../harness/retriever.js";

await initializeDb();

// loadNowText reads workspace files; a nonexistent dir yields "".
const WORKSPACE = "/tmp/harness-compare-nonexistent-workspace";

const ZERO_CONFIG = {
  d: 0,
  c_user: 0,
  c_assistant: 0,
  c_now: 0,
  k: 0,
  hops: 0,
  top_k: 0,
  epsilon: 0,
};

let seq = 0;

function config(historicalPairs: number): AssistantConfig {
  return {
    memory: { v2: { router: { historical_pairs: historicalPairs } } },
  } as unknown as AssistantConfig;
}

function ensureConversation(id: string): void {
  getDb()
    .insert(conversations)
    .values({ id, createdAt: 0, updatedAt: 0 })
    .onConflictDoNothing()
    .run();
}

function insertMessage(
  id: string,
  conversationId: string,
  role: string,
  text: string,
  createdAt: number,
): void {
  ensureConversation(conversationId);
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId,
      role,
      content: JSON.stringify([{ type: "text", text }]),
      createdAt,
    })
    .run();
}

function makeConcept(
  slug: string,
  status: MemoryV2ConceptRowRecord["status"],
): MemoryV2ConceptRowRecord {
  return {
    slug,
    finalActivation: 0,
    ownActivation: 0,
    priorActivation: 0,
    simUser: 0,
    simAssistant: 0,
    simNow: 0,
    simUserRerankBoost: 0,
    simAssistantRerankBoost: 0,
    inRerankPool: false,
    spreadContribution: 0,
    source: "router",
    status,
  };
}

function insertRouterLog(
  conversationId: string,
  messageId: string,
  turn: number,
  concepts: MemoryV2ConceptRowRecord[],
  createdAt: number,
): void {
  ensureConversation(conversationId);
  getDb()
    .insert(memoryV2ActivationLogs)
    .values({
      id: `log-${seq++}`,
      conversationId,
      messageId,
      turn,
      mode: "router",
      conceptsJson: JSON.stringify(concepts),
      skillsJson: "[]",
      configJson: JSON.stringify(ZERO_CONFIG),
      createdAt,
    })
    .run();
}

function stubRetriever(name: string, selected: string[]): Retriever {
  return {
    name,
    retrieve: async (): Promise<RetrievalOutput> => ({
      selectedSlugs: selected,
      sourceBySlug: new Map(selected.map((s): [string, string] => [s, name])),
    }),
  };
}

function reset(): void {
  const db = getDb();
  db.delete(memoryV2ActivationLogs).run();
  db.delete(messages).run();
}

/** Seed one router turn: user msg, assistant anchor, and the logged picks. */
function seedTurn(groundTruth: string[]): void {
  insertMessage("u1", "c1", "user", "hello", 10);
  insertMessage("a1", "c1", "assistant", "hi", 20); // anchor for turn 1
  insertRouterLog(
    "c1",
    "a1",
    1,
    groundTruth.map((slug) => makeConcept(slug, "injected")),
    20,
  );
}

describe("harness/compare runComparisonOverHistory", () => {
  beforeEach(reset);

  test("scores a stub retriever against the logged ground truth", async () => {
    seedTurn(["p1", "p2"]);

    const report = await runComparisonOverHistory({
      db: getDb(),
      workspaceDir: WORKSPACE,
      config: config(1),
      retrievers: [stubRetriever("stub", ["p1", "z"])],
      ks: [5],
    });

    expect(report.turnsConsidered).toBe(1);
    expect(report.turnsScored).toBe(1);
    expect(report.turnsSkipped).toBe(0);
    // hit p1, miss p2 → recall@5 = 1/2
    expect(report.retrievers[0]?.aggregate.meanRecallAtK[5]).toBeCloseTo(0.5);
  });

  test("pageExists narrows the ground truth set", async () => {
    seedTurn(["p1", "p2"]);

    const report = await runComparisonOverHistory({
      db: getDb(),
      workspaceDir: WORKSPACE,
      config: config(1),
      retrievers: [stubRetriever("stub", ["p1", "z"])],
      ks: [5],
      pageExists: (slug) => slug === "p1", // p2 no longer exists
    });

    // ground truth is just {p1}; stub selected p1 → recall 1.0
    expect(report.retrievers[0]?.aggregate.meanRecallAtK[5]).toBeCloseTo(1);
  });
});
