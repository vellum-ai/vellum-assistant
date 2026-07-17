import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const conversationsDir = join(testDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

import { getOrCreateConversation } from "../persistence/conversation-key-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  conversationKeys,
  conversations,
} from "../persistence/schema/index.js";
import type { AssistantEvent } from "../runtime/assistant-event.js";
import {
  _resetStreamStateForTesting,
  _simulateRestartForTesting,
  getCurrentSeq,
  stampAndBuffer,
} from "../runtime/assistant-stream-state.js";

await initializeDb();

beforeEach(() => {
  const db = getDb();
  db.delete(conversationKeys).run();
  db.delete(conversations).run();

  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
});

describe("conversation-key-store disk view", () => {
  test("creates disk-view directory on first key use and reuses it on second call", () => {
    const first = getOrCreateConversation("client-key");
    expect(first.created).toBe(true);

    const db = getDb();
    const conversation = db
      .select({ id: conversations.id, createdAt: conversations.createdAt })
      .from(conversations)
      .where(eq(conversations.id, first.conversationId))
      .get();
    expect(conversation).not.toBeUndefined();

    const expectedDirName = `${new Date(conversation!.createdAt).toISOString().replace(/:/g, "-")}_${first.conversationId}`;
    const metaPath = join(conversationsDir, expectedDirName, "meta.json");
    expect(existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.id).toBe(first.conversationId);
    expect(meta.title).toBe("Generating title...");
    expect(meta.type).toBe("standard");
    expect(meta.channel).toBeNull();
    expect(readdirSync(conversationsDir)).toEqual([expectedDirName]);

    const second = getOrCreateConversation("client-key");
    expect(second.created).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);

    const conversationRows = db
      .select({ id: conversations.id })
      .from(conversations)
      .all();
    const keyRows = db
      .select({ id: conversationKeys.id })
      .from(conversationKeys)
      .all();
    expect(conversationRows).toHaveLength(1);
    expect(keyRows).toHaveLength(1);
    expect(readdirSync(conversationsDir)).toEqual([expectedDirName]);
  });

  test("seeds the seq alignment baseline from the global counter at creation", () => {
    // Regression: this insert used to omit `seq`, so key-materialized
    // conversations (the web's first-send path) reported `seq: null` on
    // /messages for their entire first turn — the anchor-less snapshot that
    // let mid-turn refetches wipe streamed transcript content on clients.
    _resetStreamStateForTesting();
    const event: AssistantEvent = {
      id: "seed-evt",
      conversationId: "other-conversation",
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "other-conversation",
        text: "x",
      } as AssistantEvent["message"],
    };
    stampAndBuffer(event);
    const baseline = getCurrentSeq();
    expect(baseline).toBeGreaterThan(0);

    const created = getOrCreateConversation("seed-key");
    const row = getDb()
      .select({ seq: conversations.seq })
      .from(conversations)
      .where(eq(conversations.id, created.conversationId))
      .get();
    expect(row?.seq).toBe(baseline);
  });

  test("seeds from the persisted seq ceiling after a daemon restart", () => {
    // A restarted process with a warm workspace has stamped nothing yet, but
    // the reservation file proves every previously emitted seq is at or below
    // its ceiling — a conversation created before the first stamp must seed
    // from that ceiling, not report NULL as if the assistant were brand new.
    _resetStreamStateForTesting();
    const event: AssistantEvent = {
      id: "restart-evt",
      conversationId: "other-conversation",
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "other-conversation",
        text: "x",
      } as AssistantEvent["message"],
    };
    stampAndBuffer(event);
    _simulateRestartForTesting();

    const created = getOrCreateConversation("restart-key");
    const row = getDb()
      .select({ seq: conversations.seq })
      .from(conversations)
      .where(eq(conversations.id, created.conversationId))
      .get();
    expect(row?.seq).toBe(getCurrentSeq());
    expect(row?.seq).toBeGreaterThan(0);
  });

  test("stores NULL seq when nothing has been stamped yet (cold process)", () => {
    // getCurrentSeq() === 0 means no event was ever emitted; clients must
    // cold-start rather than align to seq 0, so the column stays NULL.
    _resetStreamStateForTesting();
    expect(getCurrentSeq()).toBe(0);

    const created = getOrCreateConversation("cold-key");
    const row = getDb()
      .select({ seq: conversations.seq })
      .from(conversations)
      .where(eq(conversations.id, created.conversationId))
      .get();
    expect(row?.seq).toBeNull();
  });
});
