/**
 * End-to-end guards over referential forking: `forkStrategy: "reference"`
 * builds a fork that copies no rows and reads its inherited window back
 * through `fork_parent_message_id`.
 *
 * The load-bearing claim is equivalence. A referential fork must present the
 * same message list a copied fork presents, because the retrospective agent
 * reads the fork natively and every downstream consumer (accounting, dedup,
 * the fork-boundary scan) reads it through the same helpers. The parity test
 * against the cloning path is what pins that.
 */

import { rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { invalidateConfigCache } from "../config/loader.js";
import {
  addMessage,
  countMessagesAfter,
  createConversation,
  deleteConversation,
  deleteConversationGently,
  forkConversationForRetrospective,
  getMessages,
  getMessagesAfter,
  getMessagesPaginated,
  hasMessages,
  listReferentialForkChildren,
} from "../persistence/conversation-crud.js";
import { getDb, getLogsDb, getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  conversations,
  llmRequestLogs,
  memoryJobs,
  memoryRetrospectiveState,
  messages,
} from "../persistence/schema/index.js";
import { getWorkspaceConfigPath } from "../util/platform.js";

await initializeDb();

const configPath = getWorkspaceConfigPath();

/**
 * Point `memory.retrospective.forkStrategy` at a strategy. The fork path reads
 * it from config rather than taking a parameter, so exercising both branches
 * means writing the workspace config the loader reads.
 */
function setForkStrategy(strategy: "cloning" | "reference"): void {
  writeFileSync(
    configPath,
    JSON.stringify(
      { memory: { retrospective: { forkStrategy: strategy } } },
      null,
      2,
    ) + "\n",
  );
  invalidateConfigCache();
}

function clearConfig(): void {
  rmSync(configPath, { force: true });
  invalidateConfigCache();
}

afterAll(clearConfig);

function resetTables(): void {
  const db = getDb();
  getMemoryDb()!.delete(memoryRetrospectiveState).run();
  getMemoryDb()!.delete(memoryJobs).run();
  getLogsDb()!.delete(llmRequestLogs).run();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM conversation_compaction_events");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

async function seedSource(title: string): Promise<{ id: string }> {
  const source = createConversation(title);
  await addMessage(source.id, "user", "draft a launch plan", {
    skipIndexing: true,
  });
  await addMessage(source.id, "assistant", "here is a first pass", {
    skipIndexing: true,
  });
  await addMessage(source.id, "user", "tweak the timeline", {
    skipIndexing: true,
  });
  await addMessage(source.id, "assistant", "updated", { skipIndexing: true });
  return source;
}

/** Rows physically stored on a conversation, ignoring anything inherited. */
function ownedRowCount(conversationId: string): number {
  return getDb()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .all().length;
}

/** Flatten each row's content blocks down to their text, for readable asserts. */
function textOf(rows: Array<{ content: unknown }>): string[] {
  return rows.map((row) => {
    if (typeof row.content === "string") {
      return row.content;
    }
    const blocks = Array.isArray(row.content) ? row.content : [];
    return blocks
      .map((block: unknown) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("");
  });
}

describe("referential forking", () => {
  beforeEach(() => {
    resetTables();
    clearConfig();
  });

  test("copies no message rows and stamps the strategy", async () => {
    const source = await seedSource("Launch");

    setForkStrategy("reference");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    expect(ownedRowCount(fork.id)).toBe(0);
    expect(fork.forkStrategy).toBe("reference");
    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).not.toBeNull();
  });

  test("reads the source's history through the fork pointer", async () => {
    const source = await seedSource("Launch");

    setForkStrategy("reference");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    expect(textOf(getMessages(fork.id))).toEqual([
      "draft a launch plan",
      "here is a first pass",
      "tweak the timeline",
      "updated",
    ]);
    expect(hasMessages(fork.id)).toBe(true);
  });

  test("presents the same messages a cloning fork does", async () => {
    const source = await seedSource("Launch");

    setForkStrategy("cloning");
    const cloned = await forkConversationForRetrospective({
      conversationId: source.id,
    });
    setForkStrategy("reference");
    const referenced = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    expect(textOf(getMessages(referenced.id))).toEqual(
      textOf(getMessages(cloned.id)),
    );
    expect(countMessagesAfter(referenced.id, null)).toBe(
      countMessagesAfter(cloned.id, null),
    );
  });

  test("rows written on the fork interleave after the inherited ones", async () => {
    const source = await seedSource("Launch");
    setForkStrategy("reference");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    await addMessage(fork.id, "user", "review this conversation", {
      skipIndexing: true,
    });

    expect(textOf(getMessages(fork.id)).at(-1)).toBe(
      "review this conversation",
    );
    expect(ownedRowCount(fork.id)).toBe(1);
  });

  test("messages written on the source after the fork point are excluded", async () => {
    const source = await seedSource("Launch");
    setForkStrategy("reference");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    await addMessage(source.id, "user", "written after the fork", {
      skipIndexing: true,
    });

    const forkText = textOf(getMessages(fork.id));
    expect(forkText).not.toContain("written after the fork");
    expect(textOf(getMessages(source.id))).toContain("written after the fork");
  });

  test("a cutoff bounds the inherited window", async () => {
    const source = await seedSource("Launch");
    const sourceRows = getMessages(source.id);

    setForkStrategy("reference");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: sourceRows[1]!.id,
    });

    expect(textOf(getMessages(fork.id))).toEqual([
      "draft a launch plan",
      "here is a first pass",
    ]);
  });

  test("getMessagesAfter and countMessagesAfter cross the lineage boundary", async () => {
    const source = await seedSource("Launch");
    const sourceRows = getMessages(source.id);
    setForkStrategy("reference");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });
    await addMessage(fork.id, "user", "own row", { skipIndexing: true });

    // The cursor sits on an ancestor row while the rows it must return span
    // both the ancestor's tail and the fork's own writes.
    const after = getMessagesAfter(fork.id, sourceRows[1]!.id);

    expect(textOf(after)).toEqual(["tweak the timeline", "updated", "own row"]);
    expect(countMessagesAfter(fork.id, sourceRows[1]!.id)).toBe(3);
  });

  test("pagination returns the inherited rows", async () => {
    const source = await seedSource("Launch");
    setForkStrategy("reference");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    const unlimited = getMessagesPaginated(fork.id, undefined);
    expect(textOf(unlimited.messages)).toHaveLength(4);

    const page = getMessagesPaginated(fork.id, 2);
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    // Newest-first paging, so the page holds the tail of the inherited window.
    expect(textOf(page.messages)).toContain("updated");
  });

  test("deleting the source is refused while a referential fork reads it", async () => {
    const source = await seedSource("Launch");
    setForkStrategy("reference");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    expect(listReferentialForkChildren(source.id)).toEqual([fork.id]);
    expect(() => deleteConversation(source.id)).toThrow(/referential fork/);

    // Deleting the fork first releases the source.
    deleteConversation(fork.id);
    expect(listReferentialForkChildren(source.id)).toEqual([]);
    deleteConversation(source.id);
    expect(
      getDb()
        .select()
        .from(conversations)
        .where(eq(conversations.id, source.id))
        .all(),
    ).toHaveLength(0);
  });

  test("the gentle delete path enforces the same guard", async () => {
    const source = await seedSource("Launch");
    setForkStrategy("reference");
    await forkConversationForRetrospective({ conversationId: source.id });

    // `deleteConversationGently` is a separate implementation of the same
    // operation and is what the plugin facade exposes, so the invariant has to
    // hold there too or plugins can strip a fork of its history.
    await expect(deleteConversationGently(source.id)).rejects.toThrow(
      /referential fork/,
    );
  });

  test("a cloning fork does not block deleting its source", async () => {
    const source = await seedSource("Launch");
    setForkStrategy("cloning");
    await forkConversationForRetrospective({
      conversationId: source.id,
    });

    expect(listReferentialForkChildren(source.id)).toEqual([]);
    expect(() => deleteConversation(source.id)).not.toThrow();
  });
});
