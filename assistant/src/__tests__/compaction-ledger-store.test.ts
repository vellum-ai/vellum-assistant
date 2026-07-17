import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  appendCompactionEvent,
  forkCompactionLedger,
  getLatestCompactionEventAtOrBefore,
} from "../persistence/compaction-ledger-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  conversationCompactionEvents,
  conversations,
} from "../persistence/schema/index.js";

await initializeDb();

function reset(): void {
  const db = getDb();
  db.delete(conversationCompactionEvents).run();
  db.delete(conversations).run();
}

function makeConversation(id: string): void {
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({ id, title: id, createdAt: now, updatedAt: now })
    .run();
}

function forkEventsFor(conversationId: string) {
  return getDb()
    .select()
    .from(conversationCompactionEvents)
    .where(eq(conversationCompactionEvents.conversationId, conversationId))
    .all();
}

describe("compaction-ledger-store", () => {
  beforeEach(reset);

  test("getLatestCompactionEventAtOrBefore returns the newest event at-or-before the cutoff", () => {
    makeConversation("conv");
    appendCompactionEvent("conv", {
      compactedAt: 100,
      summary: "s100",
      compactedMessageCount: 1,
    });
    appendCompactionEvent("conv", {
      compactedAt: 200,
      summary: "s200",
      compactedMessageCount: 3,
    });
    appendCompactionEvent("conv", {
      compactedAt: 300,
      summary: "s300",
      compactedMessageCount: 5,
    });

    expect(getLatestCompactionEventAtOrBefore("conv", 50)).toBeNull();
    expect(
      getLatestCompactionEventAtOrBefore("conv", 100)?.compactedMessageCount,
    ).toBe(1);
    expect(
      getLatestCompactionEventAtOrBefore("conv", 250)?.compactedMessageCount,
    ).toBe(3);
    expect(
      getLatestCompactionEventAtOrBefore("conv", 999)?.compactedMessageCount,
    ).toBe(5);
    expect(getLatestCompactionEventAtOrBefore("conv", null)).toBeNull();
  });

  test("getLatestCompactionEventAtOrBefore is scoped per conversation", () => {
    makeConversation("a");
    makeConversation("b");
    appendCompactionEvent("a", {
      compactedAt: 100,
      summary: "a",
      compactedMessageCount: 1,
    });

    expect(getLatestCompactionEventAtOrBefore("b", 999)).toBeNull();
  });

  test("forkCompactionLedger copies only events at-or-before the boundary", () => {
    makeConversation("src");
    makeConversation("fork");
    appendCompactionEvent("src", {
      compactedAt: 100,
      summary: "s100",
      compactedMessageCount: 1,
    });
    appendCompactionEvent("src", {
      compactedAt: 300,
      summary: "s300",
      compactedMessageCount: 5,
    });

    forkCompactionLedger(getDb(), "src", "fork", 200);

    const copied = forkEventsFor("fork");
    expect(copied).toHaveLength(1);
    expect(copied[0]?.compactedAt).toBe(100);
    expect(copied[0]?.summary).toBe("s100");
  });

  test("forkCompactionLedger with a null boundary copies nothing", () => {
    makeConversation("src");
    makeConversation("fork");
    appendCompactionEvent("src", {
      compactedAt: 100,
      summary: "s100",
      compactedMessageCount: 1,
    });

    forkCompactionLedger(getDb(), "src", "fork", null);

    expect(forkEventsFor("fork")).toHaveLength(0);
  });
});
