import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "../../../../__tests__/helpers/mock-logger.js";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import {
  addMessage,
  createConversation,
  getMessages,
} from "../../../../persistence/conversation-crud.js";
import { getDb, getSqlite } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import {
  buildForkCopyScript,
  copyForkMessagesViaSubprocess,
  type ForkIdPair,
} from "../../../../persistence/fork-message-copy.js";
import { messages as messagesTable } from "../../../../persistence/schema/index.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/** Mirror of the production `cloneForkMessageMetadata` semantics. */
function expectedClonedMetadata(
  sourceMetadata: string | null,
  sourceMessageId: string,
): unknown {
  const parsed = sourceMetadata == null ? null : JSON.parse(sourceMetadata);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const existing = record.forkSourceMessageId;
    return {
      ...record,
      forkSourceMessageId:
        typeof existing === "string" ? existing : sourceMessageId,
    };
  }
  return { forkSourceMessageId: sourceMessageId };
}

/** Build an in-JS old→new id map for a source conversation's messages. */
function idPairsFor(sourceConversationId: string): ForkIdPair[] {
  return getMessages(sourceConversationId).map((m) => ({
    oldId: m.id,
    newId: crypto.randomUUID(),
  }));
}

describe("copyForkMessagesViaSubprocess", () => {
  beforeEach(() => {
    resetTables();
  });

  test("copies rows with cloneForkMessageMetadata parity and a fresh id", async () => {
    const source = createConversation("source");
    await addMessage(source.id, "user", "draft a plan", {
      metadata: { branch: 1, source: "user" },
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "here is a pass", {
      metadata: { automated: true },
      skipIndexing: true,
    });
    // Already-stamped metadata must be preserved, not overwritten.
    await addMessage(source.id, "user", "carry this", {
      metadata: { forkSourceMessageId: "pre-existing", note: "x" },
      skipIndexing: true,
    });
    // Null metadata must become a fresh provenance-only object.
    await addMessage(source.id, "user", "no metadata", {
      skipIndexing: true,
    });

    const fork = createConversation({
      title: "fork",
      conversationType: "background",
    });
    const sourceMessages = getMessages(source.id);
    const idPairs = sourceMessages.map((m) => ({
      oldId: m.id,
      newId: crypto.randomUUID(),
    }));

    const result = await copyForkMessagesViaSubprocess({
      forkConversationId: fork.id,
      idPairs,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);

    const forkMessages = getMessages(fork.id);
    expect(forkMessages).toHaveLength(sourceMessages.length);
    expect(forkMessages.map((m) => m.role)).toEqual(
      sourceMessages.map((m) => m.role),
    );
    expect(forkMessages.map((m) => m.content)).toEqual(
      sourceMessages.map((m) => m.content),
    );
    expect(forkMessages.map((m) => m.createdAt)).toEqual(
      sourceMessages.map((m) => m.createdAt),
    );
    expect(
      forkMessages.map((m) => (m.metadata ? JSON.parse(m.metadata) : null)),
    ).toEqual(
      sourceMessages.map((m) => expectedClonedMetadata(m.metadata, m.id)),
    );
    // Fresh ids, and assigned exactly per the supplied map.
    const byOld = new Map(idPairs.map((p) => [p.oldId, p.newId]));
    for (const src of sourceMessages) {
      const expectedNewId = byOld.get(src.id);
      expect(forkMessages.some((f) => f.id === expectedNewId)).toBe(true);
    }
  });

  test("does not copy client_message_id onto fork rows", async () => {
    const source = createConversation("source");
    const db = getDb();
    const createdAt = Date.now();
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at, client_message_id)
       VALUES ('msg-with-client-id', '${source.id}', 'user', 'hi', ${createdAt}, 'client-123')`,
    );

    const fork = createConversation({
      title: "fork",
      conversationType: "background",
    });
    await copyForkMessagesViaSubprocess({
      forkConversationId: fork.id,
      idPairs: [{ oldId: "msg-with-client-id", newId: crypto.randomUUID() }],
      forceInProcess: true,
    });

    const forkRow = db
      .select()
      .from(messagesTable)
      .all()
      .find((r) => r.conversationId === fork.id);
    expect(forkRow).toBeDefined();
    expect(forkRow?.clientMessageId ?? null).toBeNull();
  });

  test("copies across batch boundaries", async () => {
    const source = createConversation("source");
    for (let i = 0; i < 5; i++) {
      await addMessage(source.id, "user", `m${i}`, { skipIndexing: true });
    }
    const fork = createConversation({
      title: "fork",
      conversationType: "background",
    });
    const idPairs = idPairsFor(source.id);

    const result = await copyForkMessagesViaSubprocess({
      forkConversationId: fork.id,
      idPairs,
      batchSize: 2,
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(getMessages(fork.id)).toHaveLength(5);
  });

  test("no-op for an empty id map", async () => {
    const result = await copyForkMessagesViaSubprocess({
      forkConversationId: crypto.randomUUID(),
      idPairs: [],
      forceInProcess: true,
    });
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBe(0);
  });

  test("does not leave the staging temp table on the connection", async () => {
    const source = createConversation("source");
    await addMessage(source.id, "user", "hi", { skipIndexing: true });
    const fork = createConversation({
      title: "fork",
      conversationType: "background",
    });
    await copyForkMessagesViaSubprocess({
      forkConversationId: fork.id,
      idPairs: idPairsFor(source.id),
      forceInProcess: true,
    });
    const tempTable = getSqlite()
      .query(
        "SELECT name FROM sqlite_temp_master WHERE type='table' AND name='_fork_id_map'",
      )
      .get();
    expect(tempTable).toBeNull();
  });
});

describe("buildForkCopyScript", () => {
  test("rejects an unsafe fork id", () => {
    expect(() =>
      buildForkCopyScript({
        forkConversationId: "abc'); DROP TABLE messages;--",
        idPairs: [],
      }),
    ).toThrow(/unsafe id/);
  });

  test("rejects an unsafe message id", () => {
    expect(() =>
      buildForkCopyScript({
        forkConversationId: crypto.randomUUID(),
        idPairs: [{ oldId: "ok", newId: "bad'id" }],
      }),
    ).toThrow(/unsafe id/);
  });
});
