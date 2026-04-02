import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that depend on them
// ---------------------------------------------------------------------------

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const workspaceDir = testDir;
const conversationsDir = join(workspaceDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { getDb, initializeDb } from "../memory/db.js";
import { conversations, messages } from "../memory/schema.js";
import { recoverConversationsFromDiskViewMigration } from "../workspace/migrations/028-recover-conversations-from-disk-view.js";

initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function resetConversationsDir() {
  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
}

function createDiskViewDir(
  id: string,
  meta: Record<string, unknown>,
  messagesJsonl?: string,
): string {
  const createdAt =
    typeof meta.createdAt === "string" ? meta.createdAt : new Date().toISOString();
  const timestamp = createdAt.replace(/:/g, "-");
  const dirName = `${timestamp}_${id}`;
  const dirPath = join(conversationsDir, dirName);
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  if (messagesJsonl !== undefined) {
    writeFileSync(join(dirPath, "messages.jsonl"), messagesJsonl);
  }
  return dirPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("028-recover-conversations-from-disk-view migration", () => {
  beforeEach(() => {
    resetTables();
    resetConversationsDir();
  });

  test("recovers conversation with messages", () => {
    const id = "conv-028-basic";
    const createdAt = "2026-03-18T14:23:00.000Z";
    const updatedAt = "2026-03-18T14:25:00.000Z";

    const userLine = JSON.stringify({
      role: "user",
      ts: "2026-03-18T14:23:30.000Z",
      content: "Hello, world",
    });
    const assistantLine = JSON.stringify({
      role: "assistant",
      ts: "2026-03-18T14:24:00.000Z",
      content: "Hi there!",
    });

    createDiskViewDir(
      id,
      { id, title: "Basic Recovery", type: "standard", channel: "desktop", createdAt, updatedAt },
      userLine + "\n" + assistantLine + "\n",
    );

    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    const db = getDb();
    const convRows = db.select().from(conversations).all();
    expect(convRows).toHaveLength(1);
    expect(convRows[0].id).toBe(id);
    expect(convRows[0].title).toBe("Basic Recovery");
    expect(convRows[0].conversationType).toBe("standard");
    expect(convRows[0].createdAt).toBe(Date.parse(createdAt));
    expect(convRows[0].updatedAt).toBe(Date.parse(updatedAt));

    const msgRows = db.select().from(messages).all();
    expect(msgRows).toHaveLength(2);

    const userMsg = msgRows.find((m) => m.role === "user")!;
    expect(userMsg).toBeDefined();
    const userContent = JSON.parse(userMsg.content);
    expect(userContent).toEqual([{ type: "text", text: "Hello, world" }]);
    expect(userMsg.createdAt).toBe(Date.parse("2026-03-18T14:23:30.000Z"));

    const assistantMsg = msgRows.find((m) => m.role === "assistant")!;
    expect(assistantMsg).toBeDefined();
    const assistantContent = JSON.parse(assistantMsg.content);
    expect(assistantContent).toEqual([{ type: "text", text: "Hi there!" }]);
    expect(assistantMsg.createdAt).toBe(Date.parse("2026-03-18T14:24:00.000Z"));
  });

  test("handles toolCalls and toolResults", () => {
    const id = "conv-028-tools";
    const createdAt = "2026-03-18T15:00:00.000Z";

    const toolCallLine = JSON.stringify({
      role: "assistant",
      ts: "2026-03-18T15:00:10.000Z",
      toolCalls: [{ name: "bash", input: { command: "ls" } }],
    });
    const toolResultLine = JSON.stringify({
      role: "user",
      ts: "2026-03-18T15:00:20.000Z",
      toolResults: [{ content: "file.txt" }],
    });

    createDiskViewDir(
      id,
      { id, title: "Tool Test", type: "standard", createdAt, updatedAt: createdAt },
      toolCallLine + "\n" + toolResultLine + "\n",
    );

    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    const db = getDb();
    const msgRows = db.select().from(messages).all();
    expect(msgRows).toHaveLength(2);

    const assistantMsg = msgRows.find((m) => m.role === "assistant")!;
    const assistantContent = JSON.parse(assistantMsg.content);
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0].type).toBe("tool_use");
    expect(assistantContent[0].name).toBe("bash");
    expect(assistantContent[0].input).toEqual({ command: "ls" });
    // tool_use blocks get a random UUID id — just check it's a string
    expect(typeof assistantContent[0].id).toBe("string");

    const userMsg = msgRows.find((m) => m.role === "user")!;
    const userContent = JSON.parse(userMsg.content);
    expect(userContent).toHaveLength(1);
    expect(userContent[0].type).toBe("tool_result");
    expect(userContent[0].content).toBe("file.txt");
    expect(userContent[0].tool_use_id).toBe("");
  });

  test("skips existing conversations", () => {
    const id = "conv-028-existing";
    const createdAt = "2026-03-18T16:00:00.000Z";
    const createdAtMs = Date.parse(createdAt);

    // Pre-insert the conversation in the DB
    const db = getDb();
    db.insert(conversations)
      .values({
        id,
        title: "Already Here",
        createdAt: createdAtMs,
        updatedAt: createdAtMs,
        conversationType: "standard",
        source: "user",
        memoryScopeId: "default",
      })
      .run();

    // Create matching disk-view dir with a message
    createDiskViewDir(
      id,
      { id, title: "Already Here", type: "standard", createdAt, updatedAt: createdAt },
      JSON.stringify({ role: "user", ts: createdAt, content: "Should not be imported" }) + "\n",
    );

    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    // Verify no duplication: still 1 conversation, 0 messages (the disk-view message was not imported)
    const convRows = db.select().from(conversations).all();
    expect(convRows).toHaveLength(1);
    expect(convRows[0].title).toBe("Already Here");

    const msgRows = db.select().from(messages).all();
    expect(msgRows).toHaveLength(0);
  });

  test("idempotent — running twice produces same result", () => {
    const id = "conv-028-idem";
    const createdAt = "2026-03-18T17:00:00.000Z";

    createDiskViewDir(
      id,
      { id, title: "Idempotency Test", type: "standard", createdAt, updatedAt: createdAt },
      JSON.stringify({ role: "user", ts: createdAt, content: "First message" }) + "\n" +
        JSON.stringify({ role: "assistant", ts: "2026-03-18T17:01:00.000Z", content: "Reply" }) + "\n",
    );

    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    const db = getDb();
    const convCountAfterFirst = db.select().from(conversations).all().length;
    const msgCountAfterFirst = db.select().from(messages).all().length;
    expect(convCountAfterFirst).toBe(1);
    expect(msgCountAfterFirst).toBe(2);

    // Run again
    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    const convCountAfterSecond = db.select().from(conversations).all().length;
    const msgCountAfterSecond = db.select().from(messages).all().length;
    expect(convCountAfterSecond).toBe(convCountAfterFirst);
    expect(msgCountAfterSecond).toBe(msgCountAfterFirst);
  });

  test("handles missing messages.jsonl", () => {
    const id = "conv-028-no-messages";
    const createdAt = "2026-03-18T18:00:00.000Z";

    // Create dir with only meta.json — no messages.jsonl
    createDiskViewDir(
      id,
      { id, title: "No Messages", type: "standard", createdAt, updatedAt: createdAt },
    );

    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    const db = getDb();
    const convRows = db.select().from(conversations).all();
    expect(convRows).toHaveLength(1);
    expect(convRows[0].id).toBe(id);
    expect(convRows[0].title).toBe("No Messages");

    const msgRows = db.select().from(messages).all();
    expect(msgRows).toHaveLength(0);
  });

  test("handles malformed JSONL lines", () => {
    const id = "conv-028-malformed-jsonl";
    const createdAt = "2026-03-18T19:00:00.000Z";

    const validLine = JSON.stringify({ role: "user", ts: createdAt, content: "Valid" });
    const invalidLine = "{ this is not valid json }}}";

    createDiskViewDir(
      id,
      { id, title: "Malformed JSONL", type: "standard", createdAt, updatedAt: createdAt },
      validLine + "\n" + invalidLine + "\n",
    );

    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    const db = getDb();
    const convRows = db.select().from(conversations).all();
    expect(convRows).toHaveLength(1);

    // Only the valid line should produce a message row
    const msgRows = db.select().from(messages).all();
    expect(msgRows).toHaveLength(1);
    expect(msgRows[0].role).toBe("user");
    const content = JSON.parse(msgRows[0].content);
    expect(content).toEqual([{ type: "text", text: "Valid" }]);
  });

  test("handles malformed meta.json", () => {
    const id = "conv-028-malformed-meta";
    const createdAt = "2026-03-18T20:00:00.000Z";
    const timestamp = createdAt.replace(/:/g, "-");
    const dirName = `${timestamp}_${id}`;
    const dirPath = join(conversationsDir, dirName);
    mkdirSync(dirPath, { recursive: true });

    // Write broken JSON directly
    writeFileSync(join(dirPath, "meta.json"), "{ broken json");

    // Migration should complete without error
    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    const db = getDb();
    const convRows = db.select().from(conversations).all();
    expect(convRows).toHaveLength(0);
  });

  test("no-op when conversations dir missing", () => {
    // Remove the conversations dir entirely
    rmSync(conversationsDir, { recursive: true, force: true });
    expect(existsSync(conversationsDir)).toBe(false);

    // Migration should complete without error
    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    // No conversations should exist since we can't access the DB rows through a missing dir
    const db = getDb();
    const convRows = db.select().from(conversations).all();
    expect(convRows).toHaveLength(0);
  });

  test("processes multiple directories", () => {
    const ids = ["conv-028-multi-a", "conv-028-multi-b", "conv-028-multi-c"];
    const baseTime = Date.parse("2026-03-18T21:00:00.000Z");

    for (let i = 0; i < ids.length; i++) {
      const ts = new Date(baseTime + i * 60_000).toISOString();
      createDiskViewDir(
        ids[i],
        { id: ids[i], title: `Multi ${i + 1}`, type: "standard", createdAt: ts, updatedAt: ts },
        JSON.stringify({ role: "user", ts, content: `Message ${i + 1}` }) + "\n",
      );
    }

    recoverConversationsFromDiskViewMigration.run(workspaceDir);

    const db = getDb();
    const convRows = db.select().from(conversations).all();
    expect(convRows).toHaveLength(3);

    const recoveredIds = convRows.map((c) => c.id).sort();
    expect(recoveredIds).toEqual([...ids].sort());

    const msgRows = db.select().from(messages).all();
    expect(msgRows).toHaveLength(3);
  });
});
