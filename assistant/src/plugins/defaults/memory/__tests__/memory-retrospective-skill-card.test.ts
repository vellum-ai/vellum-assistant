import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state. Reset between tests.
// ---------------------------------------------------------------------------

let addMessageCalls: Array<{
  conversationId: string;
  role: string;
  content: string;
  options: Record<string, unknown> | undefined;
}> = [];
let addMessageThrowsFor: string | null = null;
let addMessageDeduplicatesFor: string | null = null;
// Mirrors the real persistence layer's `clientMessageId` idempotency: a
// repeated (conversationId, clientMessageId) pair reports `deduplicated`.
let seenClientMessageIds = new Set<string>();
let processingConversationIds: string[] = [];

let syncedToDisk: Array<{
  conversationId: string;
  messageId: string;
  createdAtMs: number;
}> = [];
let publishedConversationIds: string[] = [];

// Per-conversation overrides for getConversation. `null` marks a deleted
// conversation (getConversation returns undefined for it); ids absent from
// the map fall back to a generic user-conversation stub.
type ConversationStub = {
  source: string;
  forkParentMessageId: string | null;
  title?: string;
  createdAt?: number;
} | null;
let conversationOverrides: Record<string, ConversationStub> = {};

mock.module("../../../../persistence/conversation-crud.js", () => ({
  getMessagesAfter: (_id: string, _afterId: string | null) => [],
  getMessages: (_id: string) => [],
  getConversation: (id: string) => {
    if (id in conversationOverrides) {
      return conversationOverrides[id] ?? undefined;
    }
    return {
      source: "user",
      forkParentMessageId: null,
      title: "Source conversation",
      createdAt: 1111,
    };
  },
  isConversationProcessing: (id: string) =>
    processingConversationIds.includes(id),
  forkConversationForRetrospective: async (_params: unknown) => ({
    id: "fork-conv-1",
  }),
  addMessage: async (
    conversationId: string,
    role: string,
    content: string,
    options: Record<string, unknown> | undefined,
  ) => {
    if (addMessageThrowsFor === conversationId) {
      throw new Error(`insert failed for ${conversationId}`);
    }
    addMessageCalls.push({ conversationId, role, content, options });
    const clientMessageId = options?.clientMessageId;
    const dedupKey =
      typeof clientMessageId === "string"
        ? `${conversationId}:${clientMessageId}`
        : null;
    const deduplicated =
      addMessageDeduplicatesFor === conversationId ||
      (dedupKey !== null && seenClientMessageIds.has(dedupKey));
    if (dedupKey !== null) {
      seenClientMessageIds.add(dedupKey);
    }
    return {
      id: `persisted-msg-${addMessageCalls.length}`,
      conversationId,
      role,
      content,
      createdAt: 42,
      deduplicated,
    };
  },
  deleteConversation: (_id: string) => {},
  deleteConversationGently: async (_id: string) => ({
    segmentIds: [],
    deletedSummaryIds: [],
  }),
  resolveOverrideProfile: (_fields: unknown) => undefined,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../../../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: (
    conversationId: string,
    messageId: string,
    createdAtMs: number,
  ) => {
    syncedToDisk.push({ conversationId, messageId, createdAtMs });
  },
}));

mock.module("../../../../runtime/sync/resource-sync-events.js", () => ({
  publishConversationMessagesChanged: (conversationId: string) => {
    publishedConversationIds.push(conversationId);
  },
}));

// Deferred-insert job recorder (`upsertSkillCardInsertJob` is the coalescing
// upsert the mid-turn branch and the handler's re-upsert both call).
let skillCardJobUpserts: Array<{
  payload: Record<string, unknown>;
  runAfter: number;
}> = [];
mock.module("../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: () => "follow-up-job-id",
  upsertMemoryRetrospectiveJob: () => {},
  upsertSkillCardInsertJob: (
    payload: Record<string, unknown>,
    runAfter: number,
  ) => {
    skillCardJobUpserts.push({ payload, runAfter });
  },
}));

import type { MemoryJob } from "../../../../persistence/jobs-store.js";
import {
  insertSkillCardMessage,
  SKILL_CARD_INSERT_RETRY_DELAY_MS,
  skillCardInsertJob,
} from "../memory-retrospective-skill-card.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A claimed `skill_card_insert` job carrying the given payload. */
function makeInsertJob(payload: Record<string, unknown>): MemoryJob {
  return {
    id: "insert-job-1",
    type: "skill_card_insert",
    payload,
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("memory-retrospective skill card", () => {
  beforeEach(() => {
    addMessageCalls = [];
    addMessageThrowsFor = null;
    addMessageDeduplicatesFor = null;
    seenClientMessageIds = new Set();
    processingConversationIds = [];
    syncedToDisk = [];
    publishedConversationIds = [];
    conversationOverrides = {};
    skillCardJobUpserts = [];
  });

  // -------------------------------------------------------------------------
  // insertSkillCardMessage
  // -------------------------------------------------------------------------

  test("insert writes one assistant message with the exact contract shape", async () => {
    await insertSkillCardMessage("src-conv-9", "run-conv-1", [
      {
        skillId: "skill-a",
        name: "Skill A",
        description: "Does A",
        emoji: "🧭",
      },
      { skillId: "skill-b", name: "Skill B", description: "Does B" },
    ]);

    expect(addMessageCalls).toHaveLength(1);
    const call = addMessageCalls[0]!;
    expect(call.conversationId).toBe("src-conv-9");
    expect(call.role).toBe("assistant");
    expect(JSON.parse(call.content)).toEqual([
      {
        type: "ui_surface",
        surfaceId: "skill-card-run-conv-1",
        surfaceType: "skill_card",
        title: "New skill learned",
        display: "inline",
        data: {
          skills: [
            {
              skillId: "skill-a",
              name: "Skill A",
              description: "Does A",
              emoji: "🧭",
            },
            {
              skillId: "skill-b",
              name: "Skill B",
              description: "Does B",
              emoji: null,
            },
          ],
        },
      },
      // Plain-text fallback: fed to the model and flat-text consumers;
      // surface-capable clients skip it via the `_surfaceFallback` flag.
      {
        type: "text",
        text: "New skill learned: Skill A, Skill B",
        _surfaceFallback: true,
      },
    ]);
    expect(call.options).toEqual({
      metadata: { kind: "skill-authored-card", automated: true },
      skipIndexing: true,
      clientMessageId: "skill-card-run-conv-1",
    });
    // Disk view sync mirrors the wake-persist path, then clients are told to
    // refetch the message list.
    expect(syncedToDisk).toEqual([
      {
        conversationId: "src-conv-9",
        messageId: "persisted-msg-1",
        createdAtMs: 1111,
      },
    ]);
    expect(publishedConversationIds).toEqual(["src-conv-9"]);
  });

  test("insert is a no-op when the source conversation was deleted", async () => {
    conversationOverrides["gone-conv"] = null;

    await insertSkillCardMessage("gone-conv", "run-conv-1", [
      { skillId: "skill-a", name: "Skill A", description: "Does A" },
    ]);

    expect(addMessageCalls).toHaveLength(0);
    expect(syncedToDisk).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
  });

  test("mid-turn insert defers: no message is written, a skill_card_insert job is upserted with the full payload", async () => {
    // A card row landing between a persisted tool_use and its later
    // tool_result would wedge strict linear-translation providers, so a
    // mid-turn source must queue the delivery instead of inserting — the
    // durable job carries everything needed to insert once the turn ends.
    processingConversationIds = ["src-conv-9"];
    const skills = [
      { skillId: "skill-a", name: "Skill A", description: "Does A" },
    ];
    const before = Date.now();

    await insertSkillCardMessage("src-conv-9", "run-conv-1", skills);

    expect(addMessageCalls).toHaveLength(0);
    expect(syncedToDisk).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
    expect(skillCardJobUpserts).toHaveLength(1);
    expect(skillCardJobUpserts[0]!.payload).toEqual({
      sourceConversationId: "src-conv-9",
      runConversationId: "run-conv-1",
      skills,
    });
    expect(skillCardJobUpserts[0]!.runAfter).toBeGreaterThanOrEqual(
      before + SKILL_CARD_INSERT_RETRY_DELAY_MS,
    );
  });

  test("distinct run ids on the same source produce one card each; a retried run id stays deduped", async () => {
    const skills = [
      { skillId: "skill-a", name: "Skill A", description: "Does A" },
    ];

    await insertSkillCardMessage("src-conv-9", "run-conv-1", skills);
    await insertSkillCardMessage("src-conv-9", "run-conv-2", skills);
    // Retried delivery of run 1: same clientMessageId → persistence dedups.
    await insertSkillCardMessage("src-conv-9", "run-conv-1", skills);

    // Multiple cards over a conversation's life are expected — one per
    // authoring run, keyed by the run-derived clientMessageId.
    expect(
      addMessageCalls.map(
        (c) => (c.options as Record<string, unknown>).clientMessageId,
      ),
    ).toEqual([
      "skill-card-run-conv-1",
      "skill-card-run-conv-2",
      "skill-card-run-conv-1",
    ]);
    // Only the two distinct runs reach the disk view and client broadcast.
    expect(syncedToDisk.map((s) => s.messageId)).toEqual([
      "persisted-msg-1",
      "persisted-msg-2",
    ]);
    expect(publishedConversationIds).toEqual(["src-conv-9", "src-conv-9"]);
  });

  test("deduplicated insert (retried delivery) skips disk sync and publish", async () => {
    addMessageDeduplicatesFor = "src-conv-9";

    await insertSkillCardMessage("src-conv-9", "run-conv-1", [
      { skillId: "skill-a", name: "Skill A", description: "Does A" },
    ]);

    // The idempotent addMessage call still happens (it detects the dup)...
    expect(addMessageCalls).toHaveLength(1);
    // ...but the disk-view append and client broadcast do not repeat.
    expect(syncedToDisk).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
  });

  test("insert is best-effort: a persistence failure never throws", async () => {
    addMessageThrowsFor = "src-conv-9";

    await insertSkillCardMessage("src-conv-9", "run-conv-1", [
      { skillId: "skill-a", name: "Skill A", description: "Does A" },
    ]);

    expect(addMessageCalls).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // skillCardInsertJob (delivery handler)
  // -------------------------------------------------------------------------

  function insertJobPayload(): Record<string, unknown> {
    return {
      sourceConversationId: "src-conv-9",
      runConversationId: "run-conv-1",
      skills: [
        {
          skillId: "skill-a",
          name: "Skill A",
          description: "Does A",
          emoji: "🧭",
        },
      ],
    };
  }

  test("handler with an idle source inserts the card with the contract shape intact", async () => {
    await skillCardInsertJob(makeInsertJob(insertJobPayload()));

    expect(addMessageCalls).toHaveLength(1);
    const call = addMessageCalls[0]!;
    expect(call.conversationId).toBe("src-conv-9");
    expect(call.role).toBe("assistant");
    expect(JSON.parse(call.content)).toEqual([
      {
        type: "ui_surface",
        surfaceId: "skill-card-run-conv-1",
        surfaceType: "skill_card",
        title: "New skill learned",
        display: "inline",
        data: {
          skills: [
            {
              skillId: "skill-a",
              name: "Skill A",
              description: "Does A",
              emoji: "🧭",
            },
          ],
        },
      },
      {
        type: "text",
        text: "New skill learned: Skill A",
        _surfaceFallback: true,
      },
    ]);
    expect(call.options).toEqual({
      metadata: { kind: "skill-authored-card", automated: true },
      skipIndexing: true,
      clientMessageId: "skill-card-run-conv-1",
    });
    expect(syncedToDisk).toHaveLength(1);
    expect(publishedConversationIds).toEqual(["src-conv-9"]);
    expect(skillCardJobUpserts).toHaveLength(0);
  });

  test("handler batches a multi-skill payload into ONE card message", async () => {
    // A run that authors several skills coalesces into one pending job (the
    // jobs-store upsert merges by runConversationId), so the handler must
    // render every skill in a single ui_surface block.
    await skillCardInsertJob(
      makeInsertJob({
        sourceConversationId: "src-conv-9",
        runConversationId: "run-conv-1",
        skills: [
          { skillId: "skill-a", name: "Skill A", description: "Does A" },
          { skillId: "skill-b", name: "Skill B", description: "Does B" },
        ],
      }),
    );

    expect(addMessageCalls).toHaveLength(1);
    const blocks = JSON.parse(addMessageCalls[0]!.content) as Array<{
      type: string;
      data?: { skills: Array<{ skillId: string }> };
      text?: string;
      _surfaceFallback?: boolean;
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("ui_surface");
    expect(blocks[0]!.data!.skills.map((s) => s.skillId)).toEqual([
      "skill-a",
      "skill-b",
    ]);
    expect(blocks[1]).toEqual({
      type: "text",
      text: "New skill learned: Skill A, Skill B",
      _surfaceFallback: true,
    });
    expect(publishedConversationIds).toEqual(["src-conv-9"]);
  });

  test("handler with a still-mid-turn source re-upserts itself at the same delay and inserts nothing", async () => {
    processingConversationIds = ["src-conv-9"];
    const before = Date.now();

    await skillCardInsertJob(makeInsertJob(insertJobPayload()));

    expect(addMessageCalls).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
    expect(skillCardJobUpserts).toHaveLength(1);
    expect(skillCardJobUpserts[0]!.payload).toEqual(insertJobPayload());
    expect(skillCardJobUpserts[0]!.runAfter).toBeGreaterThanOrEqual(
      before + SKILL_CARD_INSERT_RETRY_DELAY_MS,
    );
  });

  test("handler with a deleted source drops the delivery without re-upserting", async () => {
    conversationOverrides["gone-conv"] = null;

    await skillCardInsertJob(
      makeInsertJob({
        ...insertJobPayload(),
        sourceConversationId: "gone-conv",
      }),
    );

    expect(addMessageCalls).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
    expect(skillCardJobUpserts).toHaveLength(0);
  });

  test("handler retried after a successful insert is deduped by clientMessageId", async () => {
    await skillCardInsertJob(makeInsertJob(insertJobPayload()));
    await skillCardInsertJob(makeInsertJob(insertJobPayload()));

    // The idempotent addMessage runs both times (the second detects the
    // dup)...
    expect(addMessageCalls).toHaveLength(2);
    // ...but the disk-view append and client broadcast fire exactly once.
    expect(syncedToDisk).toHaveLength(1);
    expect(publishedConversationIds).toEqual(["src-conv-9"]);
  });

  test("handler drops a malformed payload without inserting, re-upserting, or throwing", async () => {
    await skillCardInsertJob(
      makeInsertJob({ sourceConversationId: "src-conv-9", skills: [] }),
    );

    expect(addMessageCalls).toHaveLength(0);
    expect(skillCardJobUpserts).toHaveLength(0);
  });

  test("handler propagates persistence failures so the jobs worker retries", async () => {
    // Unlike the best-effort `insertSkillCardMessage` entry point, the job
    // handler must surface transient insert errors to the worker's retry
    // machinery — the card is only droppable when the source conversation is
    // gone.
    addMessageThrowsFor = "src-conv-9";

    await expect(
      skillCardInsertJob(makeInsertJob(insertJobPayload())),
    ).rejects.toThrow("insert failed for src-conv-9");
  });
});
