/**
 * End-to-end guards over referential forking. A retrospective fork copies no
 * rows and reads its inherited window back through `fork_parent_message_id`.
 *
 * The load-bearing claim is equivalence. A referential fork must present the
 * same message list the source presents (through the fork point), because the
 * retrospective agent reads the fork natively and every downstream consumer
 * (accounting, dedup, the fork-boundary scan) reads it through the same
 * helpers.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  addMessage,
  countMessagesAfter,
  createConversation,
  deleteConversation,
  deleteConversationGently,
  forkConversation,
  forkConversationForRetrospective,
  getMessages,
  getMessagesAfter,
  getMessagesPaginated,
  hasMessages,
  isReferentialHistoryOrphaned,
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
import {
  MEMORY_RETROSPECTIVE_FORK_SOURCE,
  MEMORY_RETROSPECTIVE_INSTRUCTION_KIND,
} from "../plugins/defaults/memory/memory-retrospective-constants.js";
import { loadRetrospectiveRunMessages } from "../plugins/defaults/memory/memory-retrospective-fork-boundary.js";

await initializeDb();

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

/** Ids of every conversation currently in the database. */
function conversationIds(): string[] {
  return getDb()
    .select({ id: conversations.id })
    .from(conversations)
    .all()
    .map((row) => row.id);
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
  });

  test("copies no message rows and stamps the strategy", async () => {
    const source = await seedSource("Launch");

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

  test("presents the same messages as the source through the fork point", async () => {
    const source = await seedSource("Launch");

    const referenced = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    expect(textOf(getMessages(referenced.id))).toEqual(
      textOf(getMessages(source.id)),
    );
    expect(countMessagesAfter(referenced.id, null)).toBe(
      countMessagesAfter(source.id, null),
    );
  });

  test("rows written on the fork interleave after the inherited ones", async () => {
    const source = await seedSource("Launch");
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

  test("deleting the source orphans the fork instead of blocking or cascading", async () => {
    const source = await seedSource("Launch");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });
    await addMessage(fork.id, "user", "own row", { skipIndexing: true });

    deleteConversation(source.id);

    // The delete touches only what it names: the fork survives, keeps the rows
    // it owns, and the lineage read truncates at the missing parent instead of
    // throwing.
    expect(conversationIds()).toContain(fork.id);
    expect(textOf(getMessages(fork.id))).toEqual(["own row"]);
    expect(hasMessages(fork.id)).toBe(true);
    expect(countMessagesAfter(fork.id, null)).toBe(1);
  });

  test("the gentle delete path orphans the same way", async () => {
    const source = await seedSource("Launch");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    // `deleteConversationGently` is a separate implementation of the same
    // operation and is what the plugin facade exposes, so it must not diverge.
    await deleteConversationGently(source.id);

    expect(conversationIds()).toContain(fork.id);
    expect(getMessages(fork.id)).toHaveLength(0);
  });

  test("an orphaned fork reports the loss so clients can explain it", async () => {
    const source = await seedSource("Launch");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    expect(isReferentialHistoryOrphaned(fork)).toBe(false);
    deleteConversation(source.id);

    const orphan = getDb()
      .select()
      .from(conversations)
      .where(eq(conversations.id, fork.id))
      .get()!;
    expect(isReferentialHistoryOrphaned(orphan)).toBe(true);
  });

  test("a copied user fork whose source is deleted is not reported as orphaned", async () => {
    const source = await seedSource("Launch");
    const cloned = forkConversation({
      conversationId: source.id,
    });

    deleteConversation(source.id);

    // It holds its own copy, so a missing parent costs it nothing and there is
    // nothing to tell the user about.
    expect(isReferentialHistoryOrphaned(cloned)).toBe(false);
    expect(textOf(getMessages(cloned.id))).toHaveLength(4);
  });

  test("deleting a fork leaves its source alone", async () => {
    const source = await seedSource("Launch");
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    deleteConversation(fork.id);

    expect(conversationIds()).toContain(source.id);
    expect(textOf(getMessages(source.id))).toHaveLength(4);
  });

  test("loadRetrospectiveRunMessages attributes only owned rows on a reference fork", async () => {
    const source = await seedSource("Launch");
    const tip = getMessages(source.id).at(-1)!;
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: tip.id,
      conversationType: "background",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });

    const instruction = await addMessage(
      fork.id,
      "user",
      "review this conversation",
      {
        metadata: {
          kind: MEMORY_RETROSPECTIVE_INSTRUCTION_KIND,
          hidden: true,
        },
        skipIndexing: true,
      },
    );
    const remember = await addMessage(fork.id, "assistant", "remembered a fact", {
      skipIndexing: true,
    });

    const runRows = await loadRetrospectiveRunMessages(
      fork.id,
      MEMORY_RETROSPECTIVE_FORK_SOURCE,
    );
    expect(runRows?.map((m) => m.id)).toEqual([instruction.id, remember.id]);
    expect(runRows?.every((m) => m.conversationId === fork.id)).toBe(true);
  });

  test("loadRetrospectiveRunMessages returns an empty owned tail on a reference fork with no run rows", async () => {
    const source = await seedSource("Launch");
    const tip = getMessages(source.id).at(-1)!;
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: tip.id,
      conversationType: "background",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });

    // Lineage still presents the source prefix (those rows keep the source
    // conversationId). Empty owned set is determined output, not
    // indeterminate, and does not need a conversation-row strategy lookup.
    expect(getMessages(fork.id).length).toBeGreaterThan(0);
    const runRows = await loadRetrospectiveRunMessages(
      fork.id,
      MEMORY_RETROSPECTIVE_FORK_SOURCE,
    );
    expect(runRows).toEqual([]);
  });
});

describe("referential forking with unfinalized rows", () => {
  beforeEach(() => {
    resetTables();
  });

  test("ancestor rows are hidden while unfinalized and appear once finalized", async () => {
    const source = await seedSource("Launch");
    const midRow = getMessages(source.id)[1]!;
    getDb()
      .update(messages)
      .set({ finalized: 0 })
      .where(eq(messages.id, midRow.id))
      .run();

    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    // The fork's lineage read excludes the ancestor's in-flight row; the
    // source's own read keeps it.
    expect(textOf(getMessages(fork.id))).toEqual([
      "draft a launch plan",
      "tweak the timeline",
      "updated",
    ]);
    expect(getMessages(source.id)).toHaveLength(4);

    getDb()
      .update(messages)
      .set({ finalized: 1 })
      .where(eq(messages.id, midRow.id))
      .run();

    // Once the row finalizes it enters the inherited window on its own.
    expect(textOf(getMessages(fork.id))).toEqual([
      "draft a launch plan",
      "here is a first pass",
      "tweak the timeline",
      "updated",
    ]);
  });

  test("an unfinalized tail is not the fork anchor", async () => {
    const source = await seedSource("Launch");
    const tail = getMessages(source.id).at(-1)!;
    getDb()
      .update(messages)
      .set({ finalized: 0 })
      .where(eq(messages.id, tail.id))
      .run();

    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    expect(fork.forkParentMessageId).not.toBe(tail.id);
    expect(textOf(getMessages(fork.id))).toEqual([
      "draft a launch plan",
      "here is a first pass",
      "tweak the timeline",
    ]);
  });
});
