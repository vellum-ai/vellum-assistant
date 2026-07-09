import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Mock state. Reset between tests.
// ---------------------------------------------------------------------------

let newMessages: Array<{ id: string; createdAt: number }> = [];

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

type StubMessage = {
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
};
let messagesByConversationId: Record<string, StubMessage[]> = {};

mock.module("../../../../persistence/conversation-crud.js", () => ({
  getMessagesAfter: (_id: string, _afterId: string | null) => newMessages,
  getMessages: (id: string) => messagesByConversationId[id] ?? [],
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

let mockFlagEnabled = false;
mock.module("../../../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (key: string) =>
    key === "skill-creation-card" && mockFlagEnabled,
  getAssistantFeatureFlagValue: (key: string) =>
    key === "skill-creation-card" && mockFlagEnabled,
}));

let mockProcToSkillsActive = false;
mock.module("../../../../config/memory-v3-gate.js", () => ({
  isProcToSkillsActive: () => mockProcToSkillsActive,
  isMemoryV3Live: () => mockProcToSkillsActive,
}));

mock.module("../memory-retrospective-state.js", () => ({
  getRetrospectiveState: (_id: string) => null,
  upsertRetrospectiveState: async (_args: unknown) => {},
  bumpRetrospectiveLastRunAt: async (_id: string, _at: number) => {},
  appendToRememberedLog: (existing: string[], newEntries: string[]) => [
    ...existing,
    ...newEntries,
  ],
}));

mock.module("../find-most-recent-retrospective-for.js", () => ({
  findMostRecentRetrospectiveFor: (_id: string) => null,
}));

mock.module("../../../../daemon/trust-context.js", () => ({
  INTERNAL_GUARDIAN_TRUST_CONTEXT: { trustClass: "guardian" },
}));

mock.module("../../../../prompts/persona-resolver.js", () => ({
  resolveUserSlug: (_trustContext: unknown) => "alice",
}));

mock.module("../../../../runtime/agent-wake.js", () => ({
  wakeAgentForOpportunity: async (_opts: unknown) => ({ invoked: true }),
}));

mock.module("../../../../persistence/jobs-store.js", () => ({
  enqueueMemoryJob: () => "follow-up-job-id",
  upsertMemoryRetrospectiveJob: () => {},
}));

import type { MemoryJob } from "../../../../persistence/jobs-store.js";
import { memoryRetrospectiveJob } from "../memory-retrospective-job.js";
import {
  extractRetrospectiveRunSkillScaffolds,
  insertSkillCardMessage,
} from "../memory-retrospective-skill-card.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scaffoldMsg(
  toolUseId: string,
  input: Record<string, unknown>,
  opts: { createdAt?: number; metadata?: string | null } = {},
): StubMessage {
  return {
    role: "assistant",
    content: JSON.stringify([
      {
        type: "tool_use",
        id: toolUseId,
        name: "scaffold_managed_skill",
        input,
      },
    ]),
    createdAt: opts.createdAt ?? 2000,
    metadata: opts.metadata ?? null,
  };
}

function toolResultMsg(
  toolUseId: string,
  opts: {
    isError?: boolean;
    createdAt?: number;
    metadata?: string | null;
  } = {},
): StubMessage {
  return {
    role: "user",
    content: JSON.stringify([
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: opts.isError ? "Error: scaffold failed" : "ok",
        ...(opts.isError ? { is_error: true } : {}),
      },
    ]),
    createdAt: opts.createdAt ?? 2001,
    metadata: opts.metadata ?? null,
  };
}

function skillInput(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    skill_id: id,
    name: `Skill ${id}`,
    description: `Does ${id}`,
    ...overrides,
  };
}

function makeConfig(): Parameters<typeof memoryRetrospectiveJob>[1] {
  return {
    memory: {
      v2: { enabled: true },
      retrospective: {
        keepSupersededRuns: false,
        matchConversationProfile: false,
      },
    },
    ui: {},
  } as unknown as Parameters<typeof memoryRetrospectiveJob>[1];
}

function makeJob(conversationId = "src-conv-1"): MemoryJob<{
  conversationId?: string;
}> {
  return {
    id: "job-1",
    type: "memory_retrospective",
    payload: { conversationId },
    status: "pending",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Card messages persisted to the given conversation (assistant role). */
function cardMessagesFor(conversationId: string) {
  return addMessageCalls.filter(
    (c) => c.conversationId === conversationId && c.role === "assistant",
  );
}

/**
 * Stage the job's own fork conversation ("fork-conv-1") as a fork-kind row
 * whose post-fork tail contains the given messages. A stamped copied-prefix
 * row establishes the fork boundary at createdAt 1000.
 */
function stageForkTail(tailMessages: StubMessage[]): void {
  conversationOverrides["fork-conv-1"] = {
    source: "memory-retrospective-fork",
    forkParentMessageId: null,
  };
  messagesByConversationId["fork-conv-1"] = [
    {
      role: "user",
      content: JSON.stringify([{ type: "text", text: "hi" }]),
      createdAt: 1000,
      metadata: JSON.stringify({ forkSourceMessageId: "m-src-1" }),
    },
    ...tailMessages,
  ];
}

describe("memory-retrospective skill card", () => {
  beforeEach(() => {
    newMessages = [
      { id: "m1", createdAt: Date.parse("2026-05-11T10:00:00Z") },
      { id: "m2", createdAt: Date.parse("2026-05-11T10:05:00Z") },
      { id: "m3", createdAt: Date.parse("2026-05-11T10:10:00Z") },
    ];
    addMessageCalls = [];
    addMessageThrowsFor = null;
    addMessageDeduplicatesFor = null;
    seenClientMessageIds = new Set();
    processingConversationIds = [];
    syncedToDisk = [];
    publishedConversationIds = [];
    conversationOverrides = {};
    messagesByConversationId = {};
    mockFlagEnabled = false;
    mockProcToSkillsActive = false;
  });

  // -------------------------------------------------------------------------
  // extractRetrospectiveRunSkillScaffolds
  // -------------------------------------------------------------------------

  test("extractor returns only successful, non-overwrite scaffolds", () => {
    conversationOverrides["retro-1"] = {
      source: "memory-retrospective",
      forkParentMessageId: null,
    };
    messagesByConversationId["retro-1"] = [
      // Successful create — included.
      scaffoldMsg("tu-1", skillInput("skill-a", { emoji: "🧭" }), {
        createdAt: 2000,
      }),
      toolResultMsg("tu-1", { createdAt: 2001 }),
      // Errored result — excluded.
      scaffoldMsg("tu-2", skillInput("skill-b"), { createdAt: 2002 }),
      toolResultMsg("tu-2", { isError: true, createdAt: 2003 }),
      // Refinement (overwrite: true) — excluded even though it succeeded.
      scaffoldMsg("tu-3", skillInput("skill-c", { overwrite: true }), {
        createdAt: 2004,
      }),
      toolResultMsg("tu-3", { createdAt: 2005 }),
      // No result at all (interrupted run) — excluded.
      scaffoldMsg("tu-4", skillInput("skill-d"), { createdAt: 2006 }),
      // A different tool — ignored.
      {
        role: "assistant",
        content: JSON.stringify([
          {
            type: "tool_use",
            id: "tu-5",
            name: "remember",
            input: { content: "a fact" },
          },
        ]),
        createdAt: 2007,
        metadata: null,
      },
      toolResultMsg("tu-5", { createdAt: 2008 }),
    ];

    const skills = extractRetrospectiveRunSkillScaffolds("retro-1");

    expect(skills).toEqual([
      {
        skillId: "skill-a",
        name: "Skill skill-a",
        description: "Does skill-a",
        emoji: "🧭",
      },
    ]);
  });

  test("extractor resolves the run's source itself and scopes fork-kind runs to the post-fork tail", () => {
    // The fork-kind source comes from the conversation row (getConversation),
    // not a caller-supplied parameter — tail scoping proves it was read.
    conversationOverrides["retro-fork-1"] = {
      source: "memory-retrospective-fork",
      forkParentMessageId: null,
    };
    messagesByConversationId["retro-fork-1"] = [
      // Copied prefix (stamped): a source-inline scaffold that must not leak
      // into this run's card.
      scaffoldMsg("tu-prefix", skillInput("prefix-skill"), {
        createdAt: 1000,
        metadata: JSON.stringify({ forkSourceMessageId: "m-src-1" }),
      }),
      toolResultMsg("tu-prefix", {
        createdAt: 1100,
        metadata: JSON.stringify({ forkSourceMessageId: "m-src-2" }),
      }),
      // Post-fork tail: this run's own scaffold.
      scaffoldMsg("tu-tail", skillInput("tail-skill"), { createdAt: 2000 }),
      toolResultMsg("tu-tail", { createdAt: 2100 }),
    ];

    const skills = extractRetrospectiveRunSkillScaffolds("retro-fork-1");

    expect(skills.map((s) => s.skillId)).toEqual(["tail-skill"]);
  });

  test("extractor degrades to empty for a fork-kind run with no detectable boundary", () => {
    conversationOverrides["retro-fork-2"] = {
      source: "memory-retrospective-fork",
      forkParentMessageId: null,
    };
    messagesByConversationId["retro-fork-2"] = [
      scaffoldMsg("tu-1", skillInput("skill-a"), { createdAt: 1000 }),
      toolResultMsg("tu-1", { createdAt: 1100 }),
    ];

    const skills = extractRetrospectiveRunSkillScaffolds("retro-fork-2");

    expect(skills).toEqual([]);
  });

  test("extractor normalizes padded/newline-carrying inputs to the persisted values", () => {
    // `executeScaffoldManagedSkill` trims skill_id (and newline-collapses +
    // trims name/description/emoji) before persisting: a padded " my-skill "
    // input creates skill `my-skill`, so a card built from the raw input
    // would link an id that does not exist.
    conversationOverrides["retro-2"] = {
      source: "memory-retrospective",
      forkParentMessageId: null,
    };
    messagesByConversationId["retro-2"] = [
      scaffoldMsg(
        "tu-1",
        {
          skill_id: " my-skill ",
          name: "  My\nSkill  ",
          description: " Does\r\nthings ",
          emoji: " 🧭 ",
        },
        { createdAt: 2000 },
      ),
      toolResultMsg("tu-1", { createdAt: 2001 }),
    ];

    const skills = extractRetrospectiveRunSkillScaffolds("retro-2");

    expect(skills).toEqual([
      {
        skillId: "my-skill",
        name: "My Skill",
        description: "Does things",
        emoji: "🧭",
      },
    ]);
  });

  test("extractor drops an emoji that is whitespace-only after normalization", () => {
    conversationOverrides["retro-3"] = {
      source: "memory-retrospective",
      forkParentMessageId: null,
    };
    messagesByConversationId["retro-3"] = [
      scaffoldMsg(
        "tu-1",
        {
          skill_id: "skill-a",
          name: "Skill A",
          description: "Does A",
          emoji: " \n ",
        },
        { createdAt: 2000 },
      ),
      toolResultMsg("tu-1", { createdAt: 2001 }),
    ];

    const skills = extractRetrospectiveRunSkillScaffolds("retro-3");

    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      skillId: "skill-a",
      name: "Skill A",
      description: "Does A",
    });
    expect("emoji" in skills[0]!).toBe(false);
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

  test("insert still writes the card when the source conversation is mid-turn", async () => {
    // A skill-created card must land EVERY time a retrospective authors
    // skills, mid-turn included: the message is provider-safe (fallback text
    // block; placeholder splice + ensureToolPairing tolerate an assistant
    // row between tool_use/tool_result) and the accounting excludes card
    // rows from re-trigger counting.
    processingConversationIds = ["src-conv-9"];

    await insertSkillCardMessage("src-conv-9", "run-conv-1", [
      { skillId: "skill-a", name: "Skill A", description: "Does A" },
    ]);

    expect(addMessageCalls).toHaveLength(1);
    expect(addMessageCalls[0]!.conversationId).toBe("src-conv-9");
    expect(syncedToDisk).toHaveLength(1);
    expect(publishedConversationIds).toEqual(["src-conv-9"]);
  });

  test("distinct run ids on the same source produce one card each; a retried run id stays deduped", async () => {
    const skills = [
      { skillId: "skill-a", name: "Skill A", description: "Does A" },
    ];

    await insertSkillCardMessage("src-conv-9", "run-conv-1", skills);
    await insertSkillCardMessage("src-conv-9", "run-conv-2", skills);
    // Retried finalize of run 1: same clientMessageId → persistence dedups.
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

  test("deduplicated insert (retried finalize) skips disk sync and publish", async () => {
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
  // Finalize wiring (flag + proc-to-skills gates), via the job handler
  // -------------------------------------------------------------------------

  test("two skills authored in one run batch into ONE card message on the source conversation", async () => {
    mockFlagEnabled = true;
    mockProcToSkillsActive = true;
    stageForkTail([
      scaffoldMsg("tu-1", skillInput("skill-a"), { createdAt: 2000 }),
      toolResultMsg("tu-1", { createdAt: 2001 }),
      scaffoldMsg("tu-2", skillInput("skill-b"), { createdAt: 2002 }),
      toolResultMsg("tu-2", { createdAt: 2003 }),
    ]);

    const outcome = await memoryRetrospectiveJob(makeJob(), makeConfig());

    expect(outcome.kind).toBe("invoked");
    const cards = cardMessagesFor("src-conv-1");
    expect(cards).toHaveLength(1);
    const blocks = JSON.parse(cards[0]!.content) as Array<{
      type: string;
      surfaceId?: string;
      data?: { skills: Array<{ skillId: string }> };
      text?: string;
      _surfaceFallback?: boolean;
    }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("ui_surface");
    expect(blocks[0]!.surfaceId).toBe("skill-card-fork-conv-1");
    expect(blocks[0]!.data!.skills.map((s) => s.skillId)).toEqual([
      "skill-a",
      "skill-b",
    ]);
    expect(blocks[1]).toEqual({
      type: "text",
      text: "New skill learned: Skill skill-a, Skill skill-b",
      _surfaceFallback: true,
    });
    expect(publishedConversationIds).toEqual(["src-conv-1"]);
  });

  test("flag off (default): finalize inserts nothing even when scaffolds occurred", async () => {
    mockProcToSkillsActive = true;
    stageForkTail([
      scaffoldMsg("tu-1", skillInput("skill-a"), { createdAt: 2000 }),
      toolResultMsg("tu-1", { createdAt: 2001 }),
    ]);

    const outcome = await memoryRetrospectiveJob(makeJob(), makeConfig());

    expect(outcome.kind).toBe("invoked");
    expect(cardMessagesFor("src-conv-1")).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
  });

  test("proc-to-skills inactive: finalize inserts nothing even with the flag on", async () => {
    mockFlagEnabled = true;
    stageForkTail([
      scaffoldMsg("tu-1", skillInput("skill-a"), { createdAt: 2000 }),
      toolResultMsg("tu-1", { createdAt: 2001 }),
    ]);

    const outcome = await memoryRetrospectiveJob(makeJob(), makeConfig());

    expect(outcome.kind).toBe("invoked");
    expect(cardMessagesFor("src-conv-1")).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
  });

  test("no scaffolds in the run: finalize inserts nothing", async () => {
    mockFlagEnabled = true;
    mockProcToSkillsActive = true;
    stageForkTail([
      {
        role: "assistant",
        content: JSON.stringify([
          {
            type: "tool_use",
            id: "tu-1",
            name: "remember",
            input: { content: "a fact" },
          },
        ]),
        createdAt: 2000,
        metadata: null,
      },
      toolResultMsg("tu-1", { createdAt: 2001 }),
    ]);

    const outcome = await memoryRetrospectiveJob(makeJob(), makeConfig());

    expect(outcome.kind).toBe("invoked");
    expect(cardMessagesFor("src-conv-1")).toHaveLength(0);
    expect(publishedConversationIds).toHaveLength(0);
  });
});
