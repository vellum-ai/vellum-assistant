import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../../persistence/db-init.js";
import {
  conversations,
  memoryV2ActivationLogs,
  messages,
} from "../../../../../persistence/schema/index.js";
import type { MemoryV2ConceptRowRecord } from "../../memory-v2-activation-log-store.js";
import { extractOracleTurns } from "../harness/oracle.js";

await initializeDb();

const CONFIG_JSON = JSON.stringify({
  d: 0,
  c_user: 0,
  c_assistant: 0,
  c_now: 0,
  k: 0,
  hops: 0,
  top_k: 0,
  epsilon: 0,
});

let seq = 0;

function ensureConversation(id: string): void {
  getDb()
    .insert(conversations)
    .values({ id, createdAt: 0, updatedAt: 0 })
    .onConflictDoNothing()
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

function insertLog(opts: {
  conversationId: string;
  messageId: string | null;
  turn: number;
  mode: string;
  concepts: MemoryV2ConceptRowRecord[];
  createdAt: number;
}): void {
  ensureConversation(opts.conversationId);
  getDb()
    .insert(memoryV2ActivationLogs)
    .values({
      id: `log-${seq++}`,
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      turn: opts.turn,
      mode: opts.mode,
      conceptsJson: JSON.stringify(opts.concepts),
      skillsJson: "[]",
      configJson: CONFIG_JSON,
      createdAt: opts.createdAt,
    })
    .run();
}

function insertMessage(
  id: string,
  conversationId: string,
  createdAt: number,
): void {
  ensureConversation(conversationId);
  getDb()
    .insert(messages)
    .values({
      id,
      conversationId,
      role: "assistant",
      content: JSON.stringify([{ type: "text", text: "reply" }]),
      createdAt,
    })
    .run();
}

function reset(): void {
  const db = getDb();
  db.delete(memoryV2ActivationLogs).run();
  db.delete(messages).run();
}

describe("harness/oracle extractOracleTurns", () => {
  beforeEach(reset);

  test("returns only mode='router' rows with a resolvable messageId", () => {
    insertMessage("m1", "c1", 100);
    insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      concepts: [makeConcept("a", "injected")],
      createdAt: 100,
    });
    // non-router row — ignored
    insertMessage("m2", "c1", 200);
    insertLog({
      conversationId: "c1",
      messageId: "m2",
      turn: 2,
      mode: "per-turn",
      concepts: [makeConcept("b", "injected")],
      createdAt: 200,
    });
    // router row, null messageId — skipped (no anchor)
    insertLog({
      conversationId: "c1",
      messageId: null,
      turn: 3,
      mode: "router",
      concepts: [makeConcept("c", "injected")],
      createdAt: 300,
    });
    // router row, messageId does not resolve — skipped
    insertLog({
      conversationId: "c1",
      messageId: "ghost",
      turn: 4,
      mode: "router",
      concepts: [makeConcept("d", "injected")],
      createdAt: 400,
    });

    const turns = extractOracleTurns(getDb(), { limit: 50 });
    expect(turns.length).toBe(1);
    expect(turns[0]?.turn).toBe(1);
    expect(turns[0]?.groundTruthSlugs).toEqual(["a"]);
    expect(turns[0]?.anchorMessageId).toBe("m1");
    expect(turns[0]?.anchorCreatedAt).toBe(100);
  });

  test("ground truth keeps injected/in_context, drops the rest", () => {
    insertMessage("m1", "c1", 100);
    insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      createdAt: 100,
      concepts: [
        makeConcept("inj", "injected"),
        makeConcept("ctx", "in_context"),
        makeConcept("noinj", "not_injected"),
        makeConcept("miss", "page_missing"),
        makeConcept("bad", "corrupt"),
      ],
    });
    const turns = extractOracleTurns(getDb());
    expect(turns[0]?.groundTruthSlugs.sort()).toEqual(["ctx", "inj"]);
  });

  test("includeNotInjected adds not_injected to ground truth", () => {
    insertMessage("m1", "c1", 100);
    insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      createdAt: 100,
      concepts: [
        makeConcept("inj", "injected"),
        makeConcept("noinj", "not_injected"),
      ],
    });
    const turns = extractOracleTurns(getDb(), { includeNotInjected: true });
    expect(turns[0]?.groundTruthSlugs.sort()).toEqual(["inj", "noinj"]);
  });

  test("pageExists predicate drops slugs whose page is gone", () => {
    insertMessage("m1", "c1", 100);
    insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      createdAt: 100,
      concepts: [
        makeConcept("present", "injected"),
        makeConcept("gone", "injected"),
      ],
    });
    const turns = extractOracleTurns(getDb(), {
      pageExists: (slug) => slug === "present",
    });
    expect(turns[0]?.groundTruthSlugs).toEqual(["present"]);
  });

  test("skips rows whose ground truth is empty after filtering", () => {
    insertMessage("m1", "c1", 100);
    insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      createdAt: 100,
      concepts: [makeConcept("noinj", "not_injected")],
    });
    expect(extractOracleTurns(getDb()).length).toBe(0);
  });

  test("conversationIds filter restricts the scan", () => {
    insertMessage("m1", "c1", 100);
    insertLog({
      conversationId: "c1",
      messageId: "m1",
      turn: 1,
      mode: "router",
      concepts: [makeConcept("a", "injected")],
      createdAt: 100,
    });
    insertMessage("m2", "c2", 200);
    insertLog({
      conversationId: "c2",
      messageId: "m2",
      turn: 1,
      mode: "router",
      concepts: [makeConcept("b", "injected")],
      createdAt: 200,
    });
    const turns = extractOracleTurns(getDb(), { conversationIds: ["c2"] });
    expect(turns.length).toBe(1);
    expect(turns[0]?.conversationId).toBe("c2");
  });
});
