import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq, like } from "drizzle-orm";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "conversation-fork-crud-test-")),
);
const workspaceDir = join(testDir, ".vellum", "workspace");
const conversationsDir = join(workspaceDir, "conversations");

mock.module("../util/platform.js", () => ({
  getRootDir: () => join(testDir, ".vellum"),
  getDataDir: () => join(workspaceDir, "data"),
  getWorkspaceDir: () => workspaceDir,
  getConversationsDir: () => conversationsDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

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
    secretDetection: { enabled: false },
  }),
}));

import {
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../memory/attachments-store.js";
import {
  getAttentionStateByConversationIds,
  markConversationUnread,
} from "../memory/conversation-attention-store.js";
import {
  addMessage,
  createConversation,
  forkConversation,
  getMessages,
  PRIVATE_CONVERSATION_FORK_ERROR,
} from "../memory/conversation-crud.js";
import { getConversationDirPath } from "../memory/conversation-disk-view.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { getRequestLogsByMessageId } from "../memory/llm-request-log-store.js";
import {
  channelInboundEvents,
  conversationAssistantAttentionState,
  conversations,
  externalConversationBindings,
  llmRequestLogs,
  memoryJobs,
  toolInvocations,
} from "../memory/schema.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.delete(channelInboundEvents).run();
  db.delete(externalConversationBindings).run();
  db.delete(conversationAssistantAttentionState).run();
  db.delete(llmRequestLogs).run();
  db.delete(toolInvocations).run();
  db.delete(memoryJobs).run();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

function parseMetadata(metadata: string | null): unknown {
  return metadata == null ? null : JSON.parse(metadata);
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("forkConversation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("forks a full transcript with copied history and lineage", async () => {
    const source = createConversation("Planning thread");
    await addMessage(
      source.id,
      "user",
      "Can you draft a launch plan?",
      { branch: 1, source: "user" },
      { skipIndexing: true },
    );
    await addMessage(
      source.id,
      "assistant",
      "Absolutely. Here is a first pass.",
      { automated: true },
      { skipIndexing: true },
    );
    const finalSourceMessage = await addMessage(
      source.id,
      "user",
      "Fork from here",
      { nested: { keep: true } },
      { skipIndexing: true },
    );

    const sourceMessages = getMessages(source.id);
    const fork = forkConversation({ conversationId: source.id });
    const forkMessages = getMessages(fork.id);

    expect(fork.id).not.toBe(source.id);
    expect(fork.title).toBe("Planning thread (Fork)");
    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).toBe(finalSourceMessage.id);
    expect(forkMessages).toHaveLength(sourceMessages.length);
    expect(forkMessages.map((message) => message.role)).toEqual(
      sourceMessages.map((message) => message.role),
    );
    expect(forkMessages.map((message) => message.content)).toEqual(
      sourceMessages.map((message) => message.content),
    );
    expect(forkMessages.map((message) => message.createdAt)).toEqual(
      sourceMessages.map((message) => message.createdAt),
    );
    expect(
      forkMessages.map((message) => parseMetadata(message.metadata)),
    ).toEqual(
      sourceMessages.map((message) => {
        const metadata = parseMetadata(message.metadata);
        return metadata && typeof metadata === "object"
          ? {
              ...(metadata as Record<string, unknown>),
              forkSourceMessageId: message.id,
            }
          : { forkSourceMessageId: message.id };
      }),
    );
    expect(
      forkMessages.every(
        (message, index) => message.id !== sourceMessages[index]?.id,
      ),
    ).toBe(true);
  });

  test("preserves source order when source messages share a timestamp", () => {
    const source = createConversation("Equal timestamp thread");
    const db = getDb();
    const createdAt = Date.now();

    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('z-source-message', '${source.id}', 'user', 'first', ${createdAt})`,
    );
    db.run(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('a-source-message', '${source.id}', 'assistant', 'second', ${createdAt})`,
    );

    const sourceMessages = getMessages(source.id);
    const fork = forkConversation({ conversationId: source.id });
    const forkMessages = getMessages(fork.id);

    expect(sourceMessages.map((message) => message.content)).toEqual([
      "first",
      "second",
    ]);
    expect(forkMessages.map((message) => message.content)).toEqual(
      sourceMessages.map((message) => message.content),
    );
    expect(forkMessages.map((message) => message.role)).toEqual(
      sourceMessages.map((message) => message.role),
    );
  });

  test("forks only through the requested branch point", async () => {
    const source = createConversation("Branchable thread");
    await addMessage(source.id, "user", "Message 1", undefined, {
      skipIndexing: true,
    });
    const branchPoint = await addMessage(
      source.id,
      "assistant",
      "Message 2",
      undefined,
      { skipIndexing: true },
    );
    await addMessage(source.id, "user", "Message 3", undefined, {
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "Message 4", undefined, {
      skipIndexing: true,
    });

    const fork = forkConversation({
      conversationId: source.id,
      throughMessageId: branchPoint.id,
    });

    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).toBe(branchPoint.id);
    expect(getMessages(fork.id).map((message) => message.content)).toEqual([
      "Message 1",
      "Message 2",
    ]);
  });

  test("preserves compacted context when forking from the visible window", async () => {
    const source = createConversation("Compacted thread");
    await addMessage(source.id, "user", "Message 1", undefined, {
      skipIndexing: true,
    });
    await addMessage(source.id, "assistant", "Message 2", undefined, {
      skipIndexing: true,
    });
    const branchPoint = await addMessage(
      source.id,
      "user",
      "Message 3",
      undefined,
      { skipIndexing: true },
    );
    await addMessage(source.id, "assistant", "Message 4", undefined, {
      skipIndexing: true,
    });

    const compactedAt = Date.now();
    getDb()
      .update(conversations)
      .set({
        contextSummary: "Compacted summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: compactedAt,
      })
      .where(eq(conversations.id, source.id))
      .run();

    const fork = forkConversation({
      conversationId: source.id,
      throughMessageId: branchPoint.id,
    });

    expect(fork.contextSummary).toBe("Compacted summary");
    expect(fork.contextCompactedMessageCount).toBe(2);
    expect(fork.contextCompactedAt).toBe(compactedAt);
    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).toBe(branchPoint.id);
  });

  test("forks from the compacted-away prefix without inheriting source compaction state", async () => {
    const source = createConversation("Compacted thread");
    const compactedBranchPoint = await addMessage(
      source.id,
      "user",
      "Message 1",
      undefined,
      { skipIndexing: true },
    );
    await addMessage(source.id, "assistant", "Message 2", undefined, {
      skipIndexing: true,
    });
    await addMessage(source.id, "user", "Message 3", undefined, {
      skipIndexing: true,
    });

    getDb()
      .update(conversations)
      .set({
        contextSummary: "Compacted summary",
        contextCompactedMessageCount: 2,
        contextCompactedAt: Date.now(),
      })
      .where(eq(conversations.id, source.id))
      .run();

    const fork = forkConversation({
      conversationId: source.id,
      throughMessageId: compactedBranchPoint.id,
    });

    expect(fork.contextSummary).toBeNull();
    expect(fork.contextCompactedMessageCount).toBe(0);
    expect(fork.contextCompactedAt).toBeNull();
    expect(fork.forkParentConversationId).toBe(source.id);
    expect(fork.forkParentMessageId).toBe(compactedBranchPoint.id);
    expect(getMessages(fork.id).map((message) => message.content)).toEqual([
      "Message 1",
    ]);
  });

  test("rejects forks when the source conversation has no persisted messages", () => {
    const source = createConversation("Empty thread");

    expect(() => forkConversation({ conversationId: source.id })).toThrow(
      `Conversation ${source.id} has no persisted messages to fork`,
    );
  });

  test("relinks copied attachments into the fork and syncs disk view", async () => {
    const source = createConversation("Attachment thread");
    await addMessage(source.id, "user", "Please review this image", undefined, {
      skipIndexing: true,
    });
    const sourceAssistant = await addMessage(
      source.id,
      "assistant",
      "Attached the updated mock.",
      undefined,
      { skipIndexing: true },
    );
    const uploaded = uploadAttachment("wireframe.png", "image/png", "iVBORw0K");
    linkAttachmentToMessage(sourceAssistant.id, uploaded.id, 0);

    const sourceAttachments = getAttachmentsForMessage(sourceAssistant.id);
    const fork = forkConversation({ conversationId: source.id });
    const forkAssistant = getMessages(fork.id).find(
      (message) => message.role === "assistant",
    );
    const forkJsonl = readFileSync(
      join(getConversationDirPath(fork.id, fork.createdAt), "messages.jsonl"),
      "utf-8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(forkAssistant).toBeDefined();
    const forkAttachments = getAttachmentsForMessage(forkAssistant!.id);
    expect(sourceAttachments).toHaveLength(1);
    expect(forkAttachments).toHaveLength(1);
    expect(forkAttachments[0]?.id).not.toBe(sourceAttachments[0]?.id);
    expect(
      existsSync(
        join(
          getConversationDirPath(fork.id, fork.createdAt),
          "attachments",
          "wireframe.png",
        ),
      ),
    ).toBe(true);
    expect(forkJsonl[1]?.attachments).toEqual(["wireframe.png"]);
    expect(getAttachmentsForMessage(sourceAssistant.id)[0]?.id).toBe(
      sourceAttachments[0]?.id,
    );
  });

  test("rejects private source forks", async () => {
    const source = createConversation({
      title: "Private notes",
      conversationType: "private",
    });
    await addMessage(
      source.id,
      "assistant",
      "This started as private context.",
      undefined,
      { skipIndexing: true },
    );

    const db = getDb();
    const now = Date.now();
    db.update(conversations)
      .set({ originChannel: "telegram", originInterface: "cli" })
      .where(eq(conversations.id, source.id))
      .run();
    db.insert(externalConversationBindings)
      .values({
        conversationId: source.id,
        sourceChannel: "telegram",
        externalChatId: "chat-1",
        externalUserId: "user-1",
        displayName: "Alex",
        username: "alex",
        createdAt: now,
        updatedAt: now,
        lastInboundAt: now,
        lastOutboundAt: now,
      })
      .run();

    expect(() => forkConversation({ conversationId: source.id })).toThrow(
      PRIVATE_CONVERSATION_FORK_ERROR,
    );
  });

  test("marks copied assistant history as seen and excludes request logs, queued work, and inbound events", async () => {
    const source = createConversation("Support thread");
    const sourceUser = await addMessage(
      source.id,
      "user",
      "The deploy is failing.",
      undefined,
      { skipIndexing: true },
    );
    const sourceAssistant = await addMessage(
      source.id,
      "assistant",
      "I found the failing migration.",
      undefined,
      { skipIndexing: true },
    );
    markConversationUnread(source.id);

    const db = getDb();
    const now = Date.now();
    db.insert(llmRequestLogs)
      .values({
        id: "llm-log-1",
        conversationId: source.id,
        messageId: sourceAssistant.id,
        requestPayload: '{"prompt":"debug"}',
        responsePayload: '{"result":"ok"}',
        createdAt: now,
      })
      .run();
    db.insert(toolInvocations)
      .values({
        id: "tool-invocation-1",
        conversationId: source.id,
        toolName: "bash",
        input: '{"command":"bun test"}',
        result: '{"ok":true}',
        decision: "allow",
        riskLevel: "medium",
        durationMs: 42,
        createdAt: now,
      })
      .run();
    db.insert(memoryJobs)
      .values({
        id: "memory-job-1",
        type: "delete_qdrant_vectors",
        payload: JSON.stringify({ conversationId: source.id }),
        status: "pending",
        attempts: 0,
        deferrals: 0,
        runAfter: now,
        lastError: null,
        startedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(channelInboundEvents)
      .values({
        id: "inbound-event-1",
        sourceChannel: "telegram",
        externalChatId: "chat-1",
        externalMessageId: "message-1",
        sourceMessageId: "source-message-1",
        conversationId: source.id,
        messageId: sourceUser.id,
        deliveryStatus: "pending",
        processingStatus: "pending",
        processingAttempts: 0,
        lastProcessingError: null,
        retryAfter: null,
        rawPayload: "{}",
        deliveredSegmentCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const sourceState = getAttentionStateByConversationIds([source.id]).get(
      source.id,
    );
    const fork = forkConversation({ conversationId: source.id });
    const forkAssistant = getMessages(fork.id).find(
      (message) => message.role === "assistant",
    );
    const forkAssistantMetadata = forkAssistant?.metadata
      ? (JSON.parse(forkAssistant.metadata) as {
          forkSourceMessageId?: string;
        })
      : null;
    const forkRequestLogs = forkAssistant
      ? getRequestLogsByMessageId(forkAssistant.id)
      : [];
    const forkState = getAttentionStateByConversationIds([fork.id]).get(
      fork.id,
    );
    const forkRequestLogCount = db
      .select()
      .from(llmRequestLogs)
      .where(eq(llmRequestLogs.conversationId, fork.id))
      .all().length;
    const forkToolInvocationCount = db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.conversationId, fork.id))
      .all().length;
    const forkInboundEventCount = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.conversationId, fork.id))
      .all().length;
    const forkQueuedWorkCount = db
      .select()
      .from(memoryJobs)
      .where(like(memoryJobs.payload, `%${fork.id}%`))
      .all().length;

    expect(sourceState).toBeDefined();
    expect(sourceState?.lastSeenAssistantMessageId).toBeNull();
    expect(forkAssistant).toBeDefined();
    expect(forkAssistantMetadata?.forkSourceMessageId).toBe(sourceAssistant.id);
    expect(forkRequestLogs).toHaveLength(1);
    expect(forkRequestLogs[0]?.conversationId).toBe(source.id);
    expect(forkRequestLogs[0]?.messageId).toBe(sourceAssistant.id);
    expect(forkState).toBeDefined();
    expect(forkState?.latestAssistantMessageId).toBe(forkAssistant?.id);
    expect(forkState?.lastSeenAssistantMessageId).toBe(forkAssistant?.id);
    expect(forkState?.lastSeenAssistantMessageAt).toBe(
      forkAssistant?.createdAt,
    );
    expect(forkRequestLogCount).toBe(0);
    expect(forkToolInvocationCount).toBe(0);
    expect(forkInboundEventCount).toBe(0);
    expect(forkQueuedWorkCount).toBe(0);
  });
});
