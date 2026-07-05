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

import {
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
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
  conversationGraphMemoryState,
  externalConversationBindings,
  llmRequestLogs,
  memoryJobs,
  memoryRetrospectiveState,
  toolInvocations,
} from "../persistence/schema/index.js";
import {
  loadGraphMemoryState,
  saveGraphMemoryState,
} from "../plugins/defaults/memory/graph/graph-memory-state-store.js";
import { registerDefaultPluginPersistenceHooks } from "../plugins/defaults/memory/persistence-hooks-registration.js";

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
    registerDefaultPluginPersistenceHooks();
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
