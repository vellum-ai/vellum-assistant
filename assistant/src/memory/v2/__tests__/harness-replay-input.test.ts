import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../../../config/loader.js", () => ({
  getConfig: () => ({ memory: { enabled: false } }),
}));

import type { AssistantConfig } from "../../../config/types.js";
import { getDb } from "../../db-connection.js";
import { initializeDb } from "../../db-init.js";
import type { MemoryV2ConceptRowRecord } from "../../memory-v2-activation-log-store.js";
import {
  conversations,
  memoryV2ActivationLogs,
  messages,
} from "../../schema.js";
import type { OracleTurn } from "../harness/oracle.js";
import { reconstructInput } from "../harness/replay-input.js";

initializeDb();

// loadNowText reads workspace files; a nonexistent dir yields "".
const WORKSPACE = "/tmp/harness-replay-nonexistent-workspace";

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

function ensureConversation(id: string): void {
  getDb()
    .insert(conversations)
    .values({ id, createdAt: 0, updatedAt: 0 })
    .onConflictDoNothing()
    .run();
}

function config(historicalPairs: number): AssistantConfig {
  return {
    memory: { v2: { router: { historical_pairs: historicalPairs } } },
  } as unknown as AssistantConfig;
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

function turnFor(
  conversationId: string,
  turn: number,
  anchorMessageId: string,
  anchorCreatedAt: number,
): OracleTurn {
  return {
    conversationId,
    turn,
    anchorMessageId,
    anchorCreatedAt,
    groundTruthSlugs: ["x"],
    loggedConfig: ZERO_CONFIG,
    createdAt: anchorCreatedAt,
  };
}

function reset(): void {
  const db = getDb();
  db.delete(memoryV2ActivationLogs).run();
  db.delete(messages).run();
}

describe("harness/replay-input reconstructInput", () => {
  beforeEach(reset);

  test("reconstructs the last (assistant,user) pair before the anchor reply", async () => {
    insertMessage("u1", "c1", "user", "first user", 10);
    insertMessage("a1", "c1", "assistant", "first reply", 20);
    insertMessage("u2", "c1", "user", "second user", 30);
    insertMessage("a2", "c1", "assistant", "second reply", 40); // anchor

    const r = await reconstructInput(
      getDb(),
      turnFor("c1", 2, "a2", 40),
      config(1),
      WORKSPACE,
    );
    expect(r).not.toBeNull();
    expect(r?.input.recentTurnPairs).toEqual([
      { assistantMessage: "first reply", userMessage: "second user" },
    ]);
    expect(r?.meta.pairsReconstructed).toBe(1);
    expect(r?.input.nowText).toBe("");
  });

  test("historical_pairs=2 returns the last two pairs", async () => {
    insertMessage("u1", "c1", "user", "u-one", 10);
    insertMessage("a1", "c1", "assistant", "a-one", 20);
    insertMessage("u2", "c1", "user", "u-two", 30);
    insertMessage("a2", "c1", "assistant", "a-two", 40);
    insertMessage("u3", "c1", "user", "u-three", 50);
    insertMessage("a3", "c1", "assistant", "a-three", 60); // anchor

    const r = await reconstructInput(
      getDb(),
      turnFor("c1", 3, "a3", 60),
      config(2),
      WORKSPACE,
    );
    expect(r?.input.recentTurnPairs).toEqual([
      { assistantMessage: "a-one", userMessage: "u-two" },
      { assistantMessage: "a-two", userMessage: "u-three" },
    ]);
  });

  test("returns null when the anchor message is not found", async () => {
    insertMessage("u1", "c1", "user", "hi", 10);
    const r = await reconstructInput(
      getDb(),
      turnFor("c1", 1, "missing-anchor", 999),
      config(1),
      WORKSPACE,
    );
    expect(r).toBeNull();
  });

  test("priorEverInjected mirrors production everInjected retention from earlier router turns", async () => {
    insertMessage("u1", "c1", "user", "u1", 10);
    insertMessage("a1", "c1", "assistant", "a1", 20);
    insertMessage("u2", "c1", "user", "u2", 30);
    insertMessage("a2", "c1", "assistant", "a2", 40); // anchor for turn 2
    insertRouterLog(
      "c1",
      "a1",
      1,
      [
        makeConcept("p1", "injected"),
        makeConcept("p2", "in_context"),
        // page_missing / corrupt concept pages are retained in production's
        // everInjected (so they aren't re-attempted every turn), so the replay
        // must include them too.
        makeConcept("p3", "page_missing"),
        makeConcept("p4", "corrupt"),
        makeConcept("p5", "not_injected"),
      ],
      20,
    );

    const r = await reconstructInput(
      getDb(),
      turnFor("c1", 2, "a2", 40),
      config(1),
      WORKSPACE,
    );
    const slugs = (r?.input.priorEverInjected ?? []).map((e) => e.slug).sort();
    expect(slugs).toEqual(["p1", "p2", "p3", "p4"]);
    expect(r?.meta.priorEverInjectedCount).toBe(4);
  });
});
