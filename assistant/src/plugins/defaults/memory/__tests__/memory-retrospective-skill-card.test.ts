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

const watchdogEvents: Array<{
  checkName: string;
  value?: number | null;
  detail?: Record<string, unknown> | null;
}> = [];
mock.module("../../../../telemetry/watchdog-events-store.js", () => ({
  recordWatchdogEvent: (record: {
    checkName: string;
    value?: number | null;
    detail?: Record<string, unknown> | null;
  }) => {
    watchdogEvents.push(record);
  },
}));

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
    watchdogEvents.length = 0;
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

  test("a delivered card emits the skill_card_delivered counter; a dedup does not", async () => {
    await insertSkillCardMessage("conv-source", "conv-run-telemetry", [
      { skillId: "s-1", name: "Skill One", description: "d1" },
      { skillId: "s-2", name: "Skill Two", description: "d2" },
    ]);
    expect(
      watchdogEvents.filter((e) => e.checkName === "skill_card_delivered"),
    ).toEqual([
      {
        checkName: "skill_card_delivered",
        value: 2,
        detail: { skill_count: 2 },
      },
    ]);

    // Retried delivery for the same run dedups on clientMessageId — the
    // counter must not fire again.
    await insertSkillCardMessage("conv-source", "conv-run-telemetry", [
      { skillId: "s-1", name: "Skill One", description: "d1" },
    ]);
    expect(
      watchdogEvents.filter((e) => e.checkName === "skill_card_delivered"),
    ).toHaveLength(1);
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

  test("multi-skill run: A's job defers mid-run, B merges, the post-run attempt delivers ONE card with both skills", async () => {
    // The creation-site sequence end to end. Skill A's enqueue fires DURING
    // the fork run (the source is idle between turns), so the worker can
    // claim it before skill B's enqueue lands — delivering there would let
    // B's job dedup against the inserted message and vanish. The handler
    // must defer while the run is processing; B then merges into the
    // re-upserted pending row (the jobs-store coalesce is covered by
    // jobs-store-skill-card-upsert.test.ts), and the post-run attempt
    // renders every skill in a single ui_surface block.
    processingConversationIds = ["run-conv-1"];
    const skillA = {
      skillId: "skill-a",
      name: "Skill A",
      description: "Does A",
    };
    const skillB = {
      skillId: "skill-b",
      name: "Skill B",
      description: "Does B",
    };

    // Skill A's job is claimed mid-run: no insert, deferral re-upserted.
    await skillCardInsertJob(
      makeInsertJob({
        sourceConversationId: "src-conv-9",
        runConversationId: "run-conv-1",
        skills: [skillA],
      }),
    );
    expect(addMessageCalls).toHaveLength(0);
    expect(skillCardJobUpserts).toHaveLength(1);
    const deferred = skillCardJobUpserts[0]!.payload;
    expect(deferred.skills).toEqual([skillA]);

    // Skill B's creation-site enqueue merges into that pending row.
    const merged = {
      ...deferred,
      skills: [...(deferred.skills as unknown[]), skillB],
    };

    // The run finishes; the deferred job fires with the merged payload.
    processingConversationIds = [];
    await skillCardInsertJob(makeInsertJob(merged));

    expect(skillCardJobUpserts).toHaveLength(1); // no further deferral
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

  test("handler defers while the run conversation is still processing: no insert, re-upsert at the same delay", async () => {
    // Enqueues fire at the creation site DURING the fork run; the source is
    // usually idle then, so without the run gate the card would deliver
    // before later creations from the same run merge in (see module header).
    processingConversationIds = ["run-conv-1"];
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

  test("handler delivers when the run conversation is missing: a GC'd fork counts as finished", async () => {
    // Superseded-fork GC can delete the run conversation before delivery. A
    // fork can't be processing once its row is gone, so a missing run must
    // never strand the card — even against a stale processing read (the
    // explicit getConversation check wins over isConversationProcessing).
    conversationOverrides["run-conv-1"] = null;
    processingConversationIds = ["run-conv-1"];

    await skillCardInsertJob(makeInsertJob(insertJobPayload()));

    expect(addMessageCalls).toHaveLength(1);
    expect(syncedToDisk).toHaveLength(1);
    expect(publishedConversationIds).toEqual(["src-conv-9"]);
    expect(skillCardJobUpserts).toHaveLength(0);
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
