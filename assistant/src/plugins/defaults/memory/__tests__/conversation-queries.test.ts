import { beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

mock.module("../../../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { createConversation } from "../../../../persistence/conversation-crud.js";
import {
  buildExcerpt,
  buildRecallEvidenceExcerpt,
  countConversations,
  getMessageRoleStatsByConversation,
  listConversations,
  listConversationsBySource,
  listPinnedConversations,
  searchConversations,
} from "../../../../persistence/conversation-queries.js";
import { getDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { rawRun } from "../../../../persistence/raw-query.js";
import { conversations } from "../../../../persistence/schema/index.js";

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

function setConversationType(conversationId: string, type: string): void {
  const db = getDb();
  db.update(conversations)
    .set({ conversationType: type })
    .where(eq(conversations.id, conversationId))
    .run();
}

describe("buildExcerpt", () => {
  test("does not expose external_content tags for legacy plain-string rows", () => {
    const excerpt = buildExcerpt(
      '<external_content source="slack">\nSearchable Slack text\n</external_content>',
      "external_content",
    );

    expect(excerpt).toBe("Searchable Slack text");
    expect(excerpt).not.toContain("<external_content");
    expect(excerpt).not.toContain("</external_content>");
  });

  test("does not expose external_content tags for legacy text block rows", () => {
    const excerpt = buildExcerpt(
      JSON.stringify([
        {
          type: "text",
          text: '<external_content source="slack">\nSearchable block text\n</external_content>',
        },
      ]),
      "external_content",
    );

    expect(excerpt).toBe("Searchable block text");
    expect(excerpt).not.toContain("<external_content");
    expect(excerpt).not.toContain("</external_content>");
  });
});

describe("buildRecallEvidenceExcerpt", () => {
  test("preserves external_content boundaries for legacy plain-string rows", () => {
    const excerpt = buildRecallEvidenceExcerpt(
      '<external_content source="slack" origin="@alice">\nSearchable Slack text\n</external_content>',
      "Slack",
    );

    expect(excerpt).toBe(
      '<external_content source="slack" origin="@alice">\nSearchable Slack text\n</external_content>',
    );
  });

  test("preserves external_content boundaries for legacy text block rows", () => {
    const excerpt = buildRecallEvidenceExcerpt(
      JSON.stringify([
        {
          type: "text",
          text: '<external_content source="slack">\nSearchable block text\n</external_content>',
        },
      ]),
      "block",
    );

    expect(excerpt).toBe(
      '<external_content source="slack">\nSearchable block text\n</external_content>',
    );
  });

  test("preserves external_content boundaries when joined with other text blocks", () => {
    const excerpt = buildRecallEvidenceExcerpt(
      JSON.stringify([
        {
          type: "text",
          text: '<external_content source="slack">\nSearchable block text\n</external_content>',
        },
        {
          type: "text",
          text: "Local follow-up text.",
        },
      ]),
      "block",
    );

    expect(excerpt).toBe(
      '<external_content source="slack">\nSearchable block text\n</external_content> Local follow-up text.',
    );
  });

  test("does not unwrap malformed or mixed external_content text", () => {
    const malformed =
      '<external_content source="slack">Malformed Slack text</external_content>';
    const mixed =
      'prefix <external_content source="slack">\nMixed Slack text\n</external_content>';

    expect(buildRecallEvidenceExcerpt(malformed, "Slack")).toBe(malformed);
    expect(buildRecallEvidenceExcerpt(mixed, "Slack")).toBe(
      'prefix <external_content source="slack"> Mixed Slack text </external_content>',
    );
  });
});

describe("countConversations", () => {
  beforeEach(() => {
    resetTables();
  });

  test("excludes 'private', 'background', and 'scheduled' rows from the foreground count", () => {
    createConversation("foreground-1");
    createConversation("foreground-2");

    const priv = createConversation("private-1");
    setConversationType(priv.id, "private");

    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    expect(countConversations()).toBe(2);
  });

  test("background-only count excludes private rows", () => {
    createConversation("foreground-1");
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    const priv = createConversation("private-1");
    setConversationType(priv.id, "private");

    expect(countConversations("background")).toBe(2);
  });

  test("includes standard conversations with group_id system:background in background count", () => {
    // GIVEN a standard conversation routed to system:background (e.g. heartbeat)
    createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a regular foreground conversation
    createConversation("foreground-1");

    // WHEN counting background conversations
    const bgCount = countConversations("background");

    // THEN the heartbeat conversation is included
    expect(bgCount).toBe(1);

    // AND excluded from the foreground count
    expect(countConversations("standard")).toBe(1);
  });

  test("excludes standard conversations with group_id system:background from foreground count", () => {
    // GIVEN two foreground conversations and one heartbeat
    createConversation("foreground-1");
    createConversation("foreground-2");
    createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // WHEN counting foreground conversations
    // THEN the heartbeat is excluded
    expect(countConversations("standard")).toBe(2);
  });

  test('"scheduled" count returns only scheduled rows', () => {
    // GIVEN one scheduled, one background, and one foreground conversation
    createConversation({ title: "sched-1", conversationType: "scheduled" });
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation("foreground-1");

    // WHEN counting scheduled conversations
    // THEN only the scheduled row is counted (background is excluded)
    expect(countConversations("scheduled")).toBe(1);
  });

  describe("archiveStatus", () => {
    test("defaults to active — archived rows are excluded from the count", () => {
      // GIVEN one live and one archived foreground conversation
      createConversation("live-1");
      const archived = createConversation("archived-1");
      rawRun(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        Date.now(),
        archived.id,
      );

      expect(countConversations()).toBe(1);
    });

    test('archiveStatus "archived" returns the archived count only', () => {
      createConversation("live-1");
      const a1 = createConversation("archived-1");
      const a2 = createConversation("archived-2");
      rawRun(
        "UPDATE conversations SET archived_at = ? WHERE id IN (?, ?)",
        Date.now(),
        a1.id,
        a2.id,
      );

      expect(countConversations("standard", "archived")).toBe(2);
    });

    test('archiveStatus "all" returns both', () => {
      createConversation("live-1");
      const archived = createConversation("archived-1");
      rawRun(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        Date.now(),
        archived.id,
      );

      expect(countConversations("standard", "all")).toBe(2);
    });
  });
});

describe("listConversations", () => {
  beforeEach(() => {
    resetTables();
  });

  test("background fetch includes conversations with group_id system:background regardless of conversationType", () => {
    // GIVEN a heartbeat conversation (conversationType standard, group_id system:background)
    createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a real background conversation
    createConversation({ title: "bg-1", conversationType: "background" });

    // AND a foreground conversation
    createConversation("foreground-1");

    // WHEN listing background conversations
    const bgList = listConversations(100, "background");

    // THEN both background and heartbeat conversations are returned
    expect(bgList).toHaveLength(2);
    const titles = bgList.map((c) => c.title);
    expect(titles).toContain("heartbeat-1");
    expect(titles).toContain("bg-1");
  });

  test("foreground fetch excludes conversations with group_id system:background", () => {
    // GIVEN a heartbeat conversation (conversationType standard, group_id system:background)
    createConversation({
      title: "heartbeat-1",
      source: "heartbeat",
      groupId: "system:background",
    });

    // AND a foreground conversation
    createConversation("foreground-1");

    // WHEN listing foreground conversations
    const fgList = listConversations(100, "standard");

    // THEN only the foreground conversation is returned
    expect(fgList).toHaveLength(1);
    expect(fgList[0]!.title).toBe("foreground-1");
  });

  test("conversations with group_id system:scheduled are included in background fetch", () => {
    // GIVEN a conversation with group_id system:scheduled but conversationType standard
    const conv = createConversation("schedule-routed");
    rawRun(
      "UPDATE conversations SET group_id = 'system:scheduled' WHERE id = ?",
      conv.id,
    );

    // WHEN listing background conversations
    const bgList = listConversations(100, "background");

    // THEN it appears in the background list
    expect(bgList).toHaveLength(1);
    expect(bgList[0]!.title).toBe("schedule-routed");

    // AND not in the foreground list
    const fgList = listConversations(100, "standard");
    expect(fgList).toHaveLength(0);
  });

  test('"scheduled" fetch returns only scheduled rows and excludes plain background', () => {
    // GIVEN a scheduled conversation, a background conversation, and a foreground one
    createConversation({ title: "sched-1", conversationType: "scheduled" });
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation("foreground-1");

    // WHEN listing scheduled conversations
    const scheduledList = listConversations(100, "scheduled");

    // THEN only the scheduled conversation is returned
    expect(scheduledList).toHaveLength(1);
    expect(scheduledList[0]!.title).toBe("sched-1");
  });

  test('"scheduled" fetch includes standard rows routed to group_id system:scheduled but not system:background', () => {
    // GIVEN a standard conversation routed to system:scheduled
    const scheduledRouted = createConversation("schedule-routed");
    rawRun(
      "UPDATE conversations SET group_id = 'system:scheduled' WHERE id = ?",
      scheduledRouted.id,
    );

    // AND a standard conversation routed to system:background
    const backgroundRouted = createConversation("background-routed");
    rawRun(
      "UPDATE conversations SET group_id = 'system:background' WHERE id = ?",
      backgroundRouted.id,
    );

    // WHEN listing scheduled conversations
    const scheduledList = listConversations(100, "scheduled");

    // THEN only the system:scheduled row appears
    expect(scheduledList).toHaveLength(1);
    expect(scheduledList[0]!.title).toBe("schedule-routed");
  });

  test('"scheduled" fetch excludes subagent runs', () => {
    // GIVEN a scheduled conversation produced by a subagent
    createConversation({
      title: "subagent-sched",
      conversationType: "scheduled",
      source: "subagent",
    });

    // WHEN listing scheduled conversations
    const scheduledList = listConversations(100, "scheduled");

    // THEN the subagent run is excluded
    expect(scheduledList).toHaveLength(0);
  });

  describe("archiveStatus", () => {
    test("defaults to active — archived rows are excluded", () => {
      // GIVEN a live conversation and an archived one
      createConversation("live-1");
      const archived = createConversation("archived-1");
      rawRun(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        Date.now(),
        archived.id,
      );

      // WHEN listing without an explicit archiveStatus
      const rows = listConversations(100, "standard");

      // THEN only the live conversation appears
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("live-1");
    });

    test('archiveStatus "archived" returns only archived rows', () => {
      // GIVEN a live conversation and an archived one
      createConversation("live-1");
      const archived = createConversation("archived-1");
      rawRun(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        Date.now(),
        archived.id,
      );

      // WHEN listing with archiveStatus "archived"
      const rows = listConversations(100, "standard", 0, "archived");

      // THEN only the archived conversation appears
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("archived-1");
    });

    test('archiveStatus "all" returns both active and archived rows', () => {
      // GIVEN a live conversation and an archived one
      createConversation("live-1");
      const archived = createConversation("archived-1");
      rawRun(
        "UPDATE conversations SET archived_at = ? WHERE id = ?",
        Date.now(),
        archived.id,
      );

      // WHEN listing with archiveStatus "all"
      const rows = listConversations(100, "standard", 0, "all");

      // THEN both conversations appear
      expect(rows).toHaveLength(2);
      const titles = rows.map((c) => c.title);
      expect(titles).toContain("live-1");
      expect(titles).toContain("archived-1");
    });

    test('archiveStatus "archived" composes with background-only', () => {
      // GIVEN an archived background conversation and an archived foreground one
      const archivedBg = createConversation({
        title: "archived-bg",
        conversationType: "background",
      });
      const archivedFg = createConversation("archived-fg");
      rawRun(
        "UPDATE conversations SET archived_at = ? WHERE id IN (?, ?)",
        Date.now(),
        archivedBg.id,
        archivedFg.id,
      );

      // WHEN listing archived background conversations
      const rows = listConversations(100, "background", 0, "archived");

      // THEN only the archived background row appears
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe("archived-bg");
    });
  });
});

describe("listConversationsBySource", () => {
  beforeEach(() => {
    resetTables();
  });

  test("returns only conversations whose source matches exactly", () => {
    createConversation({
      title: "consol-1",
      source: "memory_v2_consolidation",
    });
    createConversation({
      title: "consol-2",
      source: "memory_v2_consolidation",
    });
    createConversation({ title: "heartbeat-1", source: "heartbeat" });
    createConversation({ title: "user-1", source: "user" });

    const results = listConversationsBySource("memory_v2_consolidation");

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.title).sort()).toEqual([
      "consol-1",
      "consol-2",
    ]);
  });

  test("orders by createdAt descending", () => {
    const a = createConversation({
      title: "a",
      source: "memory_v2_consolidation",
    });
    const b = createConversation({
      title: "b",
      source: "memory_v2_consolidation",
    });
    const c = createConversation({
      title: "c",
      source: "memory_v2_consolidation",
    });
    // Force distinct createdAt regardless of ms-clock granularity.
    rawRun("UPDATE conversations SET created_at = ? WHERE id = ?", 1000, a.id);
    rawRun("UPDATE conversations SET created_at = ? WHERE id = ?", 3000, b.id);
    rawRun("UPDATE conversations SET created_at = ? WHERE id = ?", 2000, c.id);

    const results = listConversationsBySource("memory_v2_consolidation");

    expect(results.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
  });

  test("honors the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      createConversation({
        title: `consol-${i}`,
        source: "memory_v2_consolidation",
      });
    }

    const results = listConversationsBySource("memory_v2_consolidation", 3);

    expect(results).toHaveLength(3);
  });

  test("includes archived rows by default", () => {
    const conv = createConversation({
      title: "archived",
      source: "memory_v2_consolidation",
    });
    rawRun(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      conv.id,
    );

    const results = listConversationsBySource("memory_v2_consolidation");

    expect(results).toHaveLength(1);
    expect(results[0]!.archivedAt).not.toBeNull();
  });

  test("excludes archived rows when includeArchived is false", () => {
    const archived = createConversation({
      title: "archived",
      source: "memory_v2_consolidation",
    });
    createConversation({ title: "live", source: "memory_v2_consolidation" });
    rawRun(
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      archived.id,
    );

    const results = listConversationsBySource("memory_v2_consolidation", 20, {
      includeArchived: false,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("live");
  });

  test("does not apply the subagent-exclusion that listConversations does", () => {
    // The defensive `source != 'subagent'` carve-out in listConversations is
    // a foreground/background bucketing concern. A caller asking for the
    // exact `subagent` source via this query gets exactly that.
    createConversation({ title: "sub-1", source: "subagent" });

    const results = listConversationsBySource("subagent");

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("sub-1");
  });
});

// Content-arm (lexical candidate) surfacing behavior is covered in
// `persistence/__tests__/conversation-queries-search.test.ts`, which mocks the
// lexical index; this suite covers the title arm's surfacing rules.
describe("searchConversations · surfaced conversations", () => {
  beforeEach(() => {
    resetTables();
  });

  function setSurfaced(conversationId: string): void {
    rawRun(
      "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
      Date.now(),
      conversationId,
    );
  }

  test("a surfaced background conversation is found by title search", async () => {
    const surfaced = createConversation({
      title: "Quarterly metrics rollup",
      conversationType: "background",
    });
    setSurfaced(surfaced.id);

    const results = await searchConversations("Quarterly metrics");

    expect(results.map((r) => r.conversationId)).toEqual([surfaced.id]);
  });

  test("a non-surfaced background conversation stays excluded from title search", async () => {
    createConversation({
      title: "Quarterly metrics rollup",
      conversationType: "background",
    });

    expect(await searchConversations("Quarterly metrics")).toEqual([]);
  });

  test("private conversations are never included, even with surfaced_at set", async () => {
    const priv = createConversation("Quarterly metrics rollup");
    setConversationType(priv.id, "private");
    setSurfaced(priv.id);

    expect(await searchConversations("Quarterly metrics")).toEqual([]);
  });

  test("surfaced subagent runs stay excluded from title search", async () => {
    const subagent = createConversation({
      title: "Quarterly metrics rollup",
      conversationType: "background",
      source: "subagent",
    });
    setSurfaced(subagent.id);

    expect(await searchConversations("Quarterly metrics")).toEqual([]);
  });
});

describe("listPinnedConversations · surfaced conversations", () => {
  beforeEach(() => {
    resetTables();
  });

  function setSurfaced(conversationId: string): void {
    rawRun(
      "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
      Date.now(),
      conversationId,
    );
  }

  function setPinned(conversationId: string): void {
    rawRun(
      "UPDATE conversations SET is_pinned = 1 WHERE id = ?",
      conversationId,
    );
  }

  test("a pinned surfaced background conversation is returned", () => {
    const surfaced = createConversation({
      title: "bg-pinned-surfaced",
      conversationType: "background",
    });
    setSurfaced(surfaced.id);
    setPinned(surfaced.id);

    const results = listPinnedConversations();

    expect(results.map((r) => r.id)).toEqual([surfaced.id]);
  });

  test("a pinned non-surfaced background conversation stays excluded", () => {
    const background = createConversation({
      title: "bg-pinned-hidden",
      conversationType: "background",
    });
    setPinned(background.id);

    expect(listPinnedConversations()).toEqual([]);
  });

  test("pinned private conversations are never included, even with surfaced_at set", () => {
    const priv = createConversation("private-pinned");
    setConversationType(priv.id, "private");
    setSurfaced(priv.id);
    setPinned(priv.id);

    expect(listPinnedConversations()).toEqual([]);
  });

  test("pinned surfaced subagent runs stay excluded", () => {
    const subagent = createConversation({
      title: "subagent-pinned",
      conversationType: "background",
      source: "subagent",
    });
    setSurfaced(subagent.id);
    setPinned(subagent.id);

    expect(listPinnedConversations()).toEqual([]);
  });
});

describe("getMessageRoleStatsByConversation", () => {
  beforeEach(() => {
    resetTables();
  });

  function insertMessage(
    conversationId: string,
    role: string,
    createdAt: number,
  ): void {
    rawRun(
      "INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
      `msg-${conversationId}-${role}-${createdAt}`,
      conversationId,
      role,
      "x",
      createdAt,
    );
  }

  test("returns empty map for empty input", () => {
    const result = getMessageRoleStatsByConversation([]);
    expect(result.size).toBe(0);
  });

  test("returns empty map when conversations exist but no matching role", () => {
    const a = createConversation("a");
    insertMessage(a.id, "user", 1000);

    const result = getMessageRoleStatsByConversation([a.id], "assistant");

    expect(result.size).toBe(0);
  });

  test("counts assistant messages and returns max createdAt", () => {
    const a = createConversation("a");
    insertMessage(a.id, "user", 1000);
    insertMessage(a.id, "assistant", 1500);
    insertMessage(a.id, "assistant", 2500);
    insertMessage(a.id, "assistant", 2000);

    const result = getMessageRoleStatsByConversation([a.id], "assistant");

    expect(result.size).toBe(1);
    expect(result.get(a.id)).toEqual({ count: 3, lastAt: 2500 });
  });

  test("does not count messages from other roles", () => {
    const a = createConversation("a");
    insertMessage(a.id, "user", 1000);
    insertMessage(a.id, "user", 2000);
    insertMessage(a.id, "system", 1500);
    insertMessage(a.id, "assistant", 3000);

    const result = getMessageRoleStatsByConversation([a.id], "assistant");

    expect(result.get(a.id)).toEqual({ count: 1, lastAt: 3000 });
  });

  test("scopes to the supplied conversation ids", () => {
    const a = createConversation("a");
    const b = createConversation("b");
    insertMessage(a.id, "assistant", 1000);
    insertMessage(b.id, "assistant", 2000);

    const result = getMessageRoleStatsByConversation([a.id], "assistant");

    expect(result.size).toBe(1);
    expect(result.has(a.id)).toBe(true);
    expect(result.has(b.id)).toBe(false);
  });

  test("aggregates per-conversation across many ids in a single query", () => {
    const a = createConversation("a");
    const b = createConversation("b");
    const c = createConversation("c");
    insertMessage(a.id, "assistant", 1000);
    insertMessage(a.id, "assistant", 1500);
    insertMessage(b.id, "assistant", 2000);
    // c has no assistant messages → absent from the result.

    const result = getMessageRoleStatsByConversation(
      [a.id, b.id, c.id],
      "assistant",
    );

    expect(result.size).toBe(2);
    expect(result.get(a.id)).toEqual({ count: 2, lastAt: 1500 });
    expect(result.get(b.id)).toEqual({ count: 1, lastAt: 2000 });
    expect(result.has(c.id)).toBe(false);
  });

  test("role parameter selects the counted role (defaults to assistant)", () => {
    const a = createConversation("a");
    insertMessage(a.id, "user", 1000);
    insertMessage(a.id, "user", 2000);
    insertMessage(a.id, "assistant", 1500);

    const assistants = getMessageRoleStatsByConversation([a.id]);
    expect(assistants.get(a.id)).toEqual({ count: 1, lastAt: 1500 });

    const users = getMessageRoleStatsByConversation([a.id], "user");
    expect(users.get(a.id)).toEqual({ count: 2, lastAt: 2000 });
  });
});
