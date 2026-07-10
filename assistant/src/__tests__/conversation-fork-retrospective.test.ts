import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { makeMockLogger } from "./helpers/mock-logger.js";

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
  }),
}));

import { eq } from "drizzle-orm";

import {
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import { appendCompactionEvent } from "../persistence/compaction-ledger-store.js";
import {
  addMessage,
  createConversation,
  forkConversation,
  forkConversationForRetrospective,
  getMessages,
} from "../persistence/conversation-crud.js";
import { getConversationDirPath } from "../persistence/conversation-disk-view.js";
import {
  getDb,
  getLogsDb,
  getMemoryDb,
  getSqlite,
} from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  activationState,
  channelInboundEvents,
  conversationAssistantAttentionState,
  conversationCompactionEvents,
  conversationGraphMemoryState,
  conversations,
  externalConversationBindings,
  llmRequestLogs,
  memoryJobs,
  memoryRetrospectiveState,
  messages,
  toolInvocations,
} from "../persistence/schema/index.js";
import {
  loadGraphMemoryState,
  saveGraphMemoryState,
} from "../plugins/defaults/memory/graph/graph-memory-state-store.js";
import { MEMORY_RETROSPECTIVE_FORK_SOURCE } from "../plugins/defaults/memory/memory-retrospective-constants.js";
import {
  findForkBoundaryCreatedAt,
  loadRetrospectiveRunMessages,
} from "../plugins/defaults/memory/memory-retrospective-fork-boundary.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(channelInboundEvents).run();
  db.delete(externalConversationBindings).run();
  db.delete(conversationAssistantAttentionState).run();
  db.delete(activationState).run();
  db.delete(conversationGraphMemoryState).run();
  db.delete(memoryRetrospectiveState).run();
  getLogsDb()!.delete(llmRequestLogs).run();
  db.delete(toolInvocations).run();
  getMemoryDb()!.delete(memoryJobs).run();
  db.run("DELETE FROM memory_v3_ever_injected");
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM conversation_compaction_events");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

/** Strip per-row identity so two forks of the same source compare equal. */
function normalize(message: {
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}) {
  return {
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    metadata: message.metadata,
  };
}

async function seedSource(title: string): Promise<{ id: string }> {
  const source = createConversation(title);
  await addMessage(source.id, "user", "draft a launch plan", {
    metadata: { branch: 1 },
    skipIndexing: true,
  });
  await addMessage(source.id, "assistant", "here is a first pass", {
    metadata: { automated: true },
    skipIndexing: true,
  });
  await addMessage(source.id, "user", "tweak the timeline", {
    skipIndexing: true,
  });
  await addMessage(source.id, "assistant", "updated", { skipIndexing: true });
  return source;
}

describe("forkConversationForRetrospective", () => {
  beforeEach(() => {
    resetTables();
  });

  test("full fork is row-identical to the synchronous fork", async () => {
    const source = await seedSource("Planning thread");

    const syncFork = forkConversation({
      conversationId: source.id,
      conversationType: "background",
      source: "memory-retrospective-fork",
    });
    const asyncFork = await forkConversationForRetrospective({
      conversationId: source.id,
      conversationType: "background",
      source: "memory-retrospective-fork",
    });

    // The forkSourceMessageId stamp points at the SOURCE message id (shared by
    // both forks), so the normalized rows must be byte-identical.
    expect(getMessages(asyncFork.id).map(normalize)).toEqual(
      getMessages(syncFork.id).map(normalize),
    );
    expect(asyncFork.forkParentConversationId).toBe(source.id);
    expect(asyncFork.forkParentMessageId).toBe(syncFork.forkParentMessageId);
    // Fresh ids — not the source's.
    const sourceIds = new Set(getMessages(source.id).map((m) => m.id));
    expect(getMessages(asyncFork.id).every((m) => !sourceIds.has(m.id))).toBe(
      true,
    );
  });

  test("through-cutoff (truncated) fork matches the synchronous fork", async () => {
    const source = await seedSource("Truncated thread");
    const sourceMessages = getMessages(source.id);
    const cutoff = sourceMessages[1]!.id;

    const syncFork = forkConversation({
      conversationId: source.id,
      throughMessageId: cutoff,
      conversationType: "background",
      source: "memory-retrospective-fork",
    });
    const asyncFork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: cutoff,
      conversationType: "background",
      source: "memory-retrospective-fork",
    });

    expect(getMessages(asyncFork.id).map(normalize)).toEqual(
      getMessages(syncFork.id).map(normalize),
    );
    expect(asyncFork.forkParentMessageId).toBe(syncFork.forkParentMessageId);
  });

  test("skips the disk-view projection (throwaway fork)", async () => {
    const source = await seedSource("Disk-view thread");

    const syncFork = forkConversation({ conversationId: source.id });
    const asyncFork = await forkConversationForRetrospective({
      conversationId: source.id,
    });

    // The synchronous fork writes the per-message JSONL projection...
    expect(
      existsSync(
        join(
          getConversationDirPath(syncFork.id, syncFork.createdAt),
          "messages.jsonl",
        ),
      ),
    ).toBe(true);
    // ...the retrospective fork does not.
    expect(
      existsSync(
        join(
          getConversationDirPath(asyncFork.id, asyncFork.createdAt),
          "messages.jsonl",
        ),
      ),
    ).toBe(false);
  });

  test("relinks attachments per-conversation, like the synchronous fork", async () => {
    const source = createConversation("Attachment thread");
    const assistant = await addMessage(source.id, "assistant", "see mockup", {
      skipIndexing: true,
    });
    const uploaded = uploadAttachment("wireframe.png", "image/png", "iVBORw0K");
    linkAttachmentToMessage(assistant.id, uploaded.id, 0);

    const asyncFork = await forkConversationForRetrospective({
      conversationId: source.id,
    });
    const forkAssistant = getMessages(asyncFork.id).find(
      (m) => m.role === "assistant",
    );
    expect(forkAssistant).toBeDefined();
    const forkAttachments = getAttachmentsForMessage(forkAssistant!.id);
    expect(forkAttachments).toHaveLength(1);
    // Scoped to the fork — a distinct attachment row from the source's.
    expect(forkAttachments[0]?.id).not.toBe(
      getAttachmentsForMessage(assistant.id)[0]?.id,
    );
  });

  test("carries the parent graph-memory state on a full fork", async () => {
    const source = await seedSource("Graph-state thread");
    const snapshot = JSON.stringify({ inContext: ["node-a"], currentTurn: 3 });
    saveGraphMemoryState(source.id, snapshot);

    const asyncFork = await forkConversationForRetrospective({
      conversationId: source.id,
    });
    expect(loadGraphMemoryState(asyncFork.id)).toBe(snapshot);
    expect(loadGraphMemoryState(source.id)).toBe(snapshot);
  });

  test("rejects an unknown throughMessageId without creating a fork", async () => {
    const source = await seedSource("Failure thread");
    const countConversations = () =>
      (
        getSqlite().query("SELECT COUNT(*) AS c FROM conversations").get() as {
          c: number;
        }
      ).c;
    const before = countConversations();

    await expect(
      forkConversationForRetrospective({
        conversationId: source.id,
        throughMessageId: "does-not-exist",
      }),
    ).rejects.toThrow();

    // The boundary check fails before any fork row is created — no orphan row.
    expect(countConversations()).toBe(before);
  });
});

describe("forkConversationForRetrospective — compacted source", () => {
  beforeEach(() => {
    resetTables();
  });

  interface CompactedSource {
    id: string;
    summary: string;
    compactedAt: number;
    compactedCount: number;
    base: number;
  }

  /**
   * Six-message source with a compaction covering the first four rows.
   * Timestamps are pinned so the compaction event sits strictly between
   * row 4 and row 5.
   */
  async function seedCompactedSource(): Promise<CompactedSource> {
    const source = createConversation("Compacted retro thread");
    const rows = [
      await addMessage(source.id, "user", "old question", {
        skipIndexing: true,
      }),
      await addMessage(source.id, "assistant", "old answer", {
        skipIndexing: true,
      }),
      await addMessage(source.id, "user", "older question", {
        skipIndexing: true,
      }),
      await addMessage(source.id, "assistant", "older answer", {
        skipIndexing: true,
      }),
      await addMessage(source.id, "user", "fresh question", {
        skipIndexing: true,
      }),
      await addMessage(source.id, "assistant", "fresh answer", {
        skipIndexing: true,
      }),
    ];
    const db = getDb();
    const base = Date.now();
    rows.forEach((row, index) => {
      const createdAt = index < 4 ? base + index : base + index + 10;
      db.update(messages)
        .set({ createdAt })
        .where(eq(messages.id, row.id))
        .run();
    });
    const compactedAt = base + 5;
    const summary = "Summary of the old exchange";
    db.update(conversations)
      .set({
        contextSummary: summary,
        contextCompactedMessageCount: 4,
        contextCompactedAt: compactedAt,
      })
      .where(eq(conversations.id, source.id))
      .run();
    appendCompactionEvent(source.id, {
      compactedAt,
      summary,
      compactedMessageCount: 4,
    });
    return { id: source.id, summary, compactedAt, compactedCount: 4, base };
  }

  function contentOf(m: { role: string; content: string; createdAt: number }) {
    return { role: m.role, content: m.content, createdAt: m.createdAt };
  }

  test("copies only the visible tail and renders identically to the source", async () => {
    const source = await seedCompactedSource();
    const sourceRows = getMessages(source.id);
    const tip = sourceRows.at(-1)!;

    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: tip.id,
      conversationType: "background",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });

    // Physical rows: the visible tail only, each stamped with its source id.
    const forkRows = getMessages(fork.id);
    expect(forkRows.map(contentOf)).toEqual(sourceRows.slice(4).map(contentOf));
    expect(
      forkRows.map(
        (m) =>
          (JSON.parse(m.metadata!) as { forkSourceMessageId: string })
            .forkSourceMessageId,
      ),
    ).toEqual(sourceRows.slice(4).map((m) => m.id));

    // Fork row: inherited summary + timestamp, fork-local count of 0.
    expect(fork.contextSummary).toBe(source.summary);
    expect(fork.contextCompactedMessageCount).toBe(0);
    expect(fork.contextCompactedAt).toBe(source.compactedAt);
    expect(fork.forkParentMessageId).toBe(tip.id);

    // Rendered history — summary + post-slice rows, assembled the way
    // `loadFromDb` does — is identical to the source's.
    const render = (
      summary: string | null,
      rows: Array<{ role: string; content: string; createdAt: number }>,
      count: number,
    ) => [summary, ...rows.slice(Math.min(count, rows.length)).map(contentOf)];
    expect(
      render(fork.contextSummary, forkRows, fork.contextCompactedMessageCount),
    ).toEqual(render(source.summary, sourceRows, source.compactedCount));

    // The synchronous user fork keeps the full physical history.
    const syncFork = forkConversation({
      conversationId: source.id,
      throughMessageId: tip.id,
    });
    expect(getMessages(syncFork.id)).toHaveLength(6);
    expect(syncFork.contextCompactedMessageCount).toBe(4);
  });

  test("carries per-conversation memory state wholesale on a tip fork", async () => {
    const source = await seedCompactedSource();
    const snapshot = JSON.stringify({ inContext: ["node-a"], currentTurn: 7 });
    saveGraphMemoryState(source.id, snapshot);
    const everInjected = JSON.stringify([{ slug: "page-a", turn: 1 }]);
    const db = getDb();
    db.insert(activationState)
      .values({
        conversationId: source.id,
        messageId: "source-turn-marker",
        stateJson: "{}",
        everInjectedJson: everInjected,
        currentTurn: 7,
        updatedAt: Date.now(),
      })
      .run();
    getSqlite()
      .query(
        `INSERT INTO memory_v3_ever_injected (conversation_id, slug, injected_at, bytes, pruned_at)
         VALUES (?, 'card-a', ?, 12, NULL)`,
      )
      .run(source.id, Date.now());

    const tip = getMessages(source.id).at(-1)!;
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: tip.id,
      conversationType: "background",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });

    // The fork's rendered window equals the source's, so activation,
    // ever-injected, and graph state are carried as-is.
    expect(loadGraphMemoryState(fork.id)).toBe(snapshot);
    const forkActivation = db
      .select()
      .from(activationState)
      .where(eq(activationState.conversationId, fork.id))
      .get();
    expect(forkActivation?.everInjectedJson).toBe(everInjected);
    const v3Rows = getSqlite()
      .query(
        "SELECT slug FROM memory_v3_ever_injected WHERE conversation_id = ?",
      )
      .all(fork.id) as Array<{ slug: string }>;
    expect(v3Rows.map((r) => r.slug)).toEqual(["card-a"]);
  });

  test("re-derives memory seeding from the copied tail on a truncated cutoff", async () => {
    const source = await seedCompactedSource();
    const db = getDb();
    const sourceRows = getMessages(source.id);
    // Injection blocks: one behind the summary, one on a visible tail row.
    db.update(messages)
      .set({
        metadata: JSON.stringify({
          memoryInjectedBlock: "# memory/concepts/prefix-slug.md",
        }),
      })
      .where(eq(messages.id, sourceRows[0]!.id))
      .run();
    db.update(messages)
      .set({
        metadata: JSON.stringify({
          memoryInjectedBlock: "# memory/concepts/tail-slug.md",
        }),
      })
      .where(eq(messages.id, sourceRows[4]!.id))
      .run();
    const snapshot = JSON.stringify({ inContext: ["node-a"], currentTurn: 7 });
    saveGraphMemoryState(source.id, snapshot);

    // Cut off before the tip (a user row, so no display-turn extension): the
    // fork is truncated and takes the derived-seeding branch.
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: sourceRows[4]!.id,
      conversationType: "background",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });

    // The compaction slice composes with the cutoff: source row 5 only.
    const forkRows = getMessages(fork.id);
    expect(forkRows.map((m) => m.content)).toEqual([sourceRows[4]!.content]);
    expect(fork.forkParentMessageId).toBe(sourceRows[4]!.id);

    // Derived seeding sees only the copied tail's slug; the wholesale graph
    // carry is skipped for truncated forks.
    const forkActivation = db
      .select()
      .from(activationState)
      .where(eq(activationState.conversationId, fork.id))
      .get();
    expect(forkActivation?.everInjectedJson).toBe(
      JSON.stringify([{ slug: "tail-slug", turn: 0 }]),
    );
    expect(loadGraphMemoryState(fork.id)).toBeNull();
  });

  test("seeds a single count-adjusted ledger event instead of copying the source ledger", async () => {
    const source = await seedCompactedSource();
    // An older superseded event on the source; it must not be copied either.
    appendCompactionEvent(source.id, {
      compactedAt: source.base + 1,
      summary: "Older summary",
      compactedMessageCount: 2,
    });

    const tip = getMessages(source.id).at(-1)!;
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: tip.id,
      conversationType: "background",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });

    const forkEvents = getDb()
      .select()
      .from(conversationCompactionEvents)
      .where(eq(conversationCompactionEvents.conversationId, fork.id))
      .all();
    expect(forkEvents).toHaveLength(1);
    expect(forkEvents[0]).toMatchObject({
      compactedAt: source.compactedAt,
      summary: source.summary,
      compactedMessageCount: 0,
    });

    // A fork of the fork at its tip inherits the summary with the fork-local
    // count — no rows are hidden behind it.
    const forkTip = getMessages(fork.id).at(-1)!;
    const grandchild = forkConversation({
      conversationId: fork.id,
      throughMessageId: forkTip.id,
    });
    expect(grandchild.contextSummary).toBe(source.summary);
    expect(grandchild.contextCompactedMessageCount).toBe(0);
    expect(getMessages(grandchild.id)).toHaveLength(
      getMessages(fork.id).length,
    );
  });

  test("post-fork tail extraction still detects the copied boundary", async () => {
    const source = await seedCompactedSource();
    const tip = getMessages(source.id).at(-1)!;
    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: tip.id,
      conversationType: "background",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });

    const boundary = findForkBoundaryCreatedAt(getMessages(fork.id));
    expect(boundary).toBe(tip.createdAt);

    // A run-authored message lands after the boundary and is the only row
    // attributed to the run.
    const runMessage = await addMessage(fork.id, "user", "retro instruction", {
      skipIndexing: true,
    });
    getDb()
      .update(messages)
      .set({ createdAt: tip.createdAt + 100 })
      .where(eq(messages.id, runMessage.id))
      .run();
    const runRows = loadRetrospectiveRunMessages(
      fork.id,
      MEMORY_RETROSPECTIVE_FORK_SOURCE,
    );
    expect(runRows?.map((m) => m.id)).toEqual([runMessage.id]);
  });

  test("succeeds with an empty tail when the compaction covers the whole cutoff range", async () => {
    const source = await seedCompactedSource();
    const db = getDb();
    const sourceRows = getMessages(source.id);
    const tip = sourceRows.at(-1)!;
    // A later compaction covering every row, timestamped exactly at the tip.
    db.update(conversations)
      .set({
        contextSummary: "Everything summarized",
        contextCompactedMessageCount: sourceRows.length,
        contextCompactedAt: tip.createdAt,
      })
      .where(eq(conversations.id, source.id))
      .run();
    appendCompactionEvent(source.id, {
      compactedAt: tip.createdAt,
      summary: "Everything summarized",
      compactedMessageCount: sourceRows.length,
    });

    const fork = await forkConversationForRetrospective({
      conversationId: source.id,
      throughMessageId: tip.id,
      conversationType: "background",
      source: MEMORY_RETROSPECTIVE_FORK_SOURCE,
    });

    expect(getMessages(fork.id)).toHaveLength(0);
    expect(fork.contextSummary).toBe("Everything summarized");
    expect(fork.contextCompactedMessageCount).toBe(0);
    expect(fork.contextCompactedAt).toBe(tip.createdAt);
    expect(fork.forkParentMessageId).toBe(tip.id);
    // Ageable despite copying no rows, so the startup orphan sweep (which
    // skips null `lastMessageAt` rows) can reclaim it after a crash.
    expect(fork.lastMessageAt).toBe(tip.createdAt);

    // With no stamped copied rows the copied prefix is empty, so the whole
    // conversation is the run's own output — run messages still feed the
    // success bookkeeping (dedup baseline, skill cards).
    const runMessage = await addMessage(fork.id, "user", "retro instruction", {
      skipIndexing: true,
    });
    const runRows = loadRetrospectiveRunMessages(
      fork.id,
      MEMORY_RETROSPECTIVE_FORK_SOURCE,
    );
    expect(runRows?.map((m) => m.id)).toEqual([runMessage.id]);
  });
});
