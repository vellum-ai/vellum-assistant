import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../../config/sidebar-done-gate.js", () => ({
  isSidebarDoneEnabled: () => true,
  SIDEBAR_DONE_FLAG_KEY: "sidebar-done",
}));

import {
  archiveInactiveConversation,
  listAutoArchiveCandidates,
} from "../conversation-auto-archive.js";
import {
  archiveConversation,
  resurfaceArchivedConversation,
  unarchiveConversation,
} from "../conversation-crud.js";
import { ensureGroupMigration } from "../conversation-group-migration.js";
import { getDb } from "../db-connection.js";
import { initializeDb } from "../db-init.js";
import { rawGet, rawRun } from "../raw-query.js";
import {
  acpSessionHistory,
  conversationAssistantAttentionState,
  conversationModeSessions,
  conversations,
  externalConversationBindings,
  workflowRuns,
} from "../schema/index.js";
import { upsertSubagentRecord } from "../subagent-store.js";

await initializeDb();
ensureGroupMigration();
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const CUTOFF = NOW - 7 * DAY;
const ID = "conv-123";

function insert(
  id = ID,
  values: Partial<typeof conversations.$inferInsert> = {},
) {
  getDb()
    .insert(conversations)
    .values({
      id,
      createdAt: CUTOFF - DAY,
      updatedAt: NOW,
      lastMessageAt: CUTOFF,
      ...values,
    })
    .run();
}
function change(values: Partial<typeof conversations.$inferInsert>) {
  getDb()
    .update(conversations)
    .set(values)
    .where(eq(conversations.id, ID))
    .run();
}
function candidates(limit = 100) {
  return listAutoArchiveCandidates({ cutoff: CUTOFF, limit });
}
function state() {
  return getDb()
    .select({
      archivedAt: conversations.archivedAt,
      lastReopenedAt: conversations.lastReopenedAt,
    })
    .from(conversations)
    .where(eq(conversations.id, ID))
    .get();
}

beforeEach(() => {
  setSystemTime(NOW);
  const db = getDb();
  db.delete(conversationAssistantAttentionState).run();
  db.delete(conversationModeSessions).run();
  db.delete(externalConversationBindings).run();
  db.delete(acpSessionHistory).run();
  db.delete(workflowRuns).run();
  rawRun("test:clearSubagents", "DELETE FROM subagents");
  db.delete(conversations).run();
  insert();
});
afterAll(() => setSystemTime());

test("includes the exact cutoff, excludes newer activity, and ignores title/update timestamps", () => {
  expect(candidates().map((row) => row.id)).toEqual([ID]);
  change({ lastMessageAt: CUTOFF + 1 });
  expect(candidates()).toEqual([]);
  change({ lastMessageAt: null, createdAt: CUTOFF });
  expect(candidates()).toHaveLength(1);
});

const exclusions: Array<[string, () => void]> = [
  ["already Done", () => change({ archivedAt: NOW })],
  ["processing", () => change({ processingStartedAt: NOW })],
  ["background", () => change({ conversationType: "background" })],
  ["scheduled", () => change({ conversationType: "scheduled" })],
  ["private", () => change({ conversationType: "private" })],
  ["system", () => change({ source: "system" })],
  ["subagent", () => change({ source: "subagent" })],
  ["spawned child", () => change({ parentConversationId: "conv-parent" })],
  ["memory", () => change({ source: "memory_v2_consolidation" })],
  ["schedule owner", () => change({ scheduleJobId: "schedule-123" })],
  [
    "pin",
    () => {
      rawRun(
        "test:pin",
        "UPDATE conversations SET group_id = 'system:pinned' WHERE id = ?",
        ID,
      );
    },
  ],
  [
    "background group",
    () => {
      rawRun(
        "test:background",
        "UPDATE conversations SET group_id = 'system:background' WHERE id = ?",
        ID,
      );
    },
  ],
  ["external origin", () => change({ originChannel: "slack" })],
  [
    "external binding",
    () => {
      getDb()
        .insert(externalConversationBindings)
        .values({
          conversationId: ID,
          sourceChannel: "telegram",
          externalChatId: "chat-123",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    },
  ],
  [
    "unread",
    () => {
      getDb()
        .insert(conversationAssistantAttentionState)
        .values({
          conversationId: ID,
          latestAssistantMessageAt: CUTOFF,
          lastSeenAssistantMessageAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    },
  ],
  [
    "ACP run",
    () => {
      getDb()
        .insert(acpSessionHistory)
        .values({
          id: "acp-123",
          agentId: "agent-123",
          acpSessionId: "session-123",
          parentConversationId: ID,
          status: "running",
          startedAt: CUTOFF,
        })
        .run();
    },
  ],
  [
    "workflow run",
    () => {
      getDb()
        .insert(workflowRuns)
        .values({
          id: "run-123",
          scriptSource: "",
          scriptHash: "hash-123",
          status: "running",
          conversationId: ID,
        })
        .run();
    },
  ],
  [
    "mode session",
    () => {
      getDb()
        .insert(conversationModeSessions)
        .values({
          id: "mode-123",
          conversationId: ID,
          mode: "browser",
          status: "active",
          sourceStartedAt: CUTOFF,
          lastActivityAt: CUTOFF,
        })
        .run();
    },
  ],
  [
    "subagent run",
    () => {
      upsertSubagentRecord({
        id: "task-123",
        parentConversationId: ID,
        conversationId: "conv-child",
        label: "Example task",
        objective: "Example objective",
        role: "builder",
        isFork: false,
        sendResultToUser: true,
        parentToolUseId: null,
        status: "running",
        error: null,
        createdAt: CUTOFF,
        startedAt: CUTOFF,
        completedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
      });
    },
  ],
];

describe.each(exclusions)("%s exclusion", (_name, exclude) => {
  test("is filtered from candidates and rechecked after sampling", () => {
    const sampled = candidates()[0]!;
    exclude();
    expect(candidates()).toEqual([]);
    expect(archiveInactiveConversation(sampled, CUTOFF, NOW)).toBe(false);
  });
});

test("native notification origins and read chats stay eligible", () => {
  change({ originChannel: "notification:reminder" });
  getDb()
    .insert(conversationAssistantAttentionState)
    .values({
      conversationId: ID,
      latestAssistantMessageAt: CUTOFF,
      lastSeenAssistantMessageAt: CUTOFF,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  expect(candidates()).toHaveLength(1);
});

test("a sampled old message change cannot be overwritten even if it remains below the cutoff", () => {
  const sampled = candidates()[0]!;
  change({ lastMessageAt: CUTOFF - 1 });
  expect(archiveInactiveConversation(sampled, CUTOFF, NOW)).toBe(false);
});

test("manual reopen receives a full interval and repeated unarchive does not extend it", () => {
  archiveConversation(ID);
  unarchiveConversation(ID);
  expect(state()).toEqual({ archivedAt: null, lastReopenedAt: NOW });
  expect(candidates()).toEqual([]);
  setSystemTime(NOW + DAY);
  unarchiveConversation(ID);
  expect(state()?.lastReopenedAt).toBe(NOW);
  expect(listAutoArchiveCandidates({ cutoff: NOW - 1, limit: 100 })).toEqual(
    [],
  );
  expect(listAutoArchiveCandidates({ cutoff: NOW, limit: 100 })).toHaveLength(
    1,
  );
});

test("reopen after sampling prevents the conditional archive", () => {
  const sampled = candidates()[0]!;
  archiveConversation(ID);
  unarchiveConversation(ID);
  expect(archiveInactiveConversation(sampled, CUTOFF, NOW)).toBe(false);
});

test("archive is idempotent and new visible activity resurfaces it", () => {
  const sampled = candidates()[0]!;
  expect(archiveInactiveConversation(sampled, CUTOFF, NOW)).toBe(true);
  expect(archiveInactiveConversation(sampled, CUTOFF, NOW + 1)).toBe(false);
  expect(resurfaceArchivedConversation(ID, NOW + 1)).toBe(true);
  expect(state()).toEqual({ archivedAt: null, lastReopenedAt: null });
});

test("keyset paging covers all rows while earlier pages are marked Done", () => {
  for (let i = 0; i < 205; i++) {
    insert(`conv-page-${String(i).padStart(3, "0")}`);
  }
  const visited: string[] = [];
  let after: ReturnType<typeof candidates>[number] | undefined;
  do {
    const page = listAutoArchiveCandidates({
      cutoff: CUTOFF,
      limit: 100,
      after,
    });
    if (page.length === 0) {
      break;
    }
    for (const candidate of page) {
      expect(archiveInactiveConversation(candidate, CUTOFF, NOW)).toBe(true);
      visited.push(candidate.id);
    }
    after = page[page.length - 1];
  } while (true);
  expect(new Set(visited).size).toBe(206);
  expect(
    rawGet<{ count: number }>(
      "test:doneCount",
      "SELECT count(*) AS count FROM conversations WHERE archived_at IS NOT NULL",
    )?.count,
  ).toBe(206);
});
