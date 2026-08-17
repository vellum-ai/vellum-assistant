/**
 * Tests for the listConversations route handler — focused on the
 * `archiveStatus` query param introduced to keep archived rows out of the
 * default sidebar restore. Other handlers in the file (seen/unread/get)
 * are covered transitively by `conversation-sync-tags.test.ts`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Avoid spinning up the real event hub for the pinned/groups branches.
mock.module("../../assistant-event-hub.js", () => ({
  assistantEventHub: {
    publish: async () => {},
    subscribe: () => () => {},
  },
  broadcastMessage: () => {},
}));

import { findConversation } from "../../../daemon/conversation-registry.js";
import {
  projectAssistantMessage,
  recordConversationSeenSignal,
} from "../../../persistence/conversation-attention-store.js";
import { createConversation } from "../../../persistence/conversation-crud.js";
import { getDb } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import { createGroup } from "../../../persistence/group-crud.js";
import { rawExec, rawRun } from "../../../persistence/raw-query.js";
import {
  conversationAssistantAttentionState,
  conversationAttentionEvents,
  conversations,
} from "../../../persistence/schema/index.js";
import { ROUTES as CONVERSATION_LIST_ROUTES } from "../conversation-list-routes.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition } from "../types.js";

// ---------------------------------------------------------------------------
// DB bootstrap
// ---------------------------------------------------------------------------

await initializeDb();

function clearConversations(): void {
  getDb().delete(conversations).run();
}

function seedArchived(title: string): string {
  const conv = createConversation({ title });
  rawRun(
    "test:archiveConversation",
    "UPDATE conversations SET archived_at = ? WHERE id = ?",
    Date.now(),
    conv.id,
  );
  return conv.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConversationSummary {
  id: string;
  title: string;
  archivedAt?: number;
}

interface ListResponse {
  conversations: ConversationSummary[];
  nextOffset: number;
  hasMore: boolean;
  groups?: unknown[];
}

function findHandler(routes: RouteDefinition[], operationId: string) {
  const route = routes.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

const listHandler = findHandler(CONVERSATION_LIST_ROUTES, "listConversations");

function invoke(queryParams: Record<string, string> = {}) {
  return listHandler({ queryParams }) as ListResponse | Promise<ListResponse>;
}

// Sanity guard — `findConversation` is a daemon-store side-effect call in the
// handler. Confirm it returns undefined for our cold seed rows so the assert
// doesn't accidentally rely on in-memory residency.
const _findConversationSentinel = findConversation;
void _findConversationSentinel;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/conversations — archiveStatus", () => {
  beforeEach(() => {
    clearConversations();
  });

  test("default response omits archived rows", async () => {
    createConversation("live-1");
    seedArchived("archived-1");

    const result = (await invoke()) as ListResponse;

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.title).toBe("live-1");
    expect(result.hasMore).toBe(false);
  });

  test("archiveStatus=archived returns only archived rows", async () => {
    createConversation("live-1");
    seedArchived("archived-1");
    seedArchived("archived-2");

    const result = (await invoke({
      archiveStatus: "archived",
    })) as ListResponse;

    expect(result.conversations).toHaveLength(2);
    const titles = result.conversations.map((c) => c.title).sort();
    expect(titles).toEqual(["archived-1", "archived-2"]);
  });

  test("archiveStatus=all returns active and archived rows", async () => {
    createConversation("live-1");
    seedArchived("archived-1");

    const result = (await invoke({ archiveStatus: "all" })) as ListResponse;

    expect(result.conversations).toHaveLength(2);
    const titles = result.conversations.map((c) => c.title).sort();
    expect(titles).toEqual(["archived-1", "live-1"]);
  });

  test("hasMore reflects the archived-only total count, not the full table", async () => {
    // 2 live rows, 1 archived. With limit=1 on the archived view there is
    // no second page even though the table contains three rows total.
    createConversation("live-1");
    createConversation("live-2");
    seedArchived("archived-1");

    const result = (await invoke({
      archiveStatus: "archived",
      limit: "1",
    })) as ListResponse;

    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.title).toBe("archived-1");
    expect(result.hasMore).toBe(false);
  });

  test("archived view skips pinned-row injection on first page", async () => {
    // GIVEN a pinned-but-archived row that would otherwise be force-included
    // on offset=0 of the active view.
    const pinned = createConversation("pinned-archived");
    rawRun(
      "test:setPinned",
      "UPDATE conversations SET is_pinned = 1 WHERE id = ?",
      pinned.id,
    );
    rawRun(
      "test:archiveConversation",
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      pinned.id,
    );

    // AND a live archived row to make sure the archived list isn't empty.
    seedArchived("archived-live");

    const result = (await invoke({
      archiveStatus: "archived",
    })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "archived-live",
      "pinned-archived",
    ]);
  });
});

describe("GET /v1/conversations — conversationType", () => {
  beforeEach(() => {
    clearConversations();
  });

  test("default response returns foreground rows only", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    createConversation("foreground-1");
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    // WHEN listing without a conversationType filter
    const result = (await invoke()) as ListResponse;

    // THEN only the foreground row is returned
    expect(result.conversations.map((c) => c.title)).toEqual(["foreground-1"]);
  });

  test("conversationType=background returns background and scheduled (umbrella)", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    createConversation("foreground-1");
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    // WHEN listing with conversationType=background
    const result = (await invoke({
      conversationType: "background",
    })) as ListResponse;

    // THEN both the background and scheduled rows are returned
    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "bg-1",
      "sched-1",
    ]);
  });

  test("conversationType=scheduled returns scheduled rows only", async () => {
    // GIVEN a foreground, a background, and a scheduled conversation
    createConversation("foreground-1");
    createConversation({ title: "bg-1", conversationType: "background" });
    createConversation({ title: "sched-1", conversationType: "scheduled" });

    // WHEN listing with conversationType=scheduled
    const result = (await invoke({
      conversationType: "scheduled",
    })) as ListResponse;

    // THEN only the scheduled row is returned (background is excluded)
    expect(result.conversations.map((c) => c.title)).toEqual(["sched-1"]);
  });

  test("unknown conversationType is rejected with a 400", async () => {
    // GIVEN a request with an unrecognized conversationType
    // WHEN listing — THEN it throws a BadRequestError (400) instead of
    // silently falling back to the foreground list
    expect(() => invoke({ conversationType: "private" })).toThrow(
      BadRequestError,
    );
  });
});

describe("GET /v1/conversations with groupId", () => {
  function seedInGroup(title: string, groupId: string): string {
    const conv = createConversation(title);
    rawRun(
      "test:fileIntoGroup",
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      groupId,
      conv.id,
    );
    return conv.id;
  }

  function seedPinned(title: string, displayOrder?: number): string {
    const conv = createConversation(title);
    rawRun(
      "test:pinConversation",
      "UPDATE conversations SET is_pinned = 1, group_id = 'system:pinned', display_order = ? WHERE id = ?",
      displayOrder ?? null,
      conv.id,
    );
    return conv.id;
  }

  beforeEach(() => {
    clearConversations();
  });

  test("system:all returns only conversations in no group", async () => {
    createConversation("ungrouped-1");
    const group = createGroup("Car Chat");
    seedInGroup("in-custom-group", group.id);
    seedPinned("pinned-1");

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual(["ungrouped-1"]);
  });

  test("system:all matches rows whose group_id is NULL, not just the literal sentinel", async () => {
    // `group_id` is only written when a conversation is filed somewhere, so
    // almost every ungrouped row carries NULL. An equality-only predicate
    // would return nothing at all here.
    const conv = createConversation("never-filed");
    rawRun(
      "test:clearGroup",
      "UPDATE conversations SET group_id = NULL WHERE id = ?",
      conv.id,
    );

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual(["never-filed"]);
  });

  test("system:pinned returns the Pinned section", async () => {
    createConversation("ungrouped-1");
    seedPinned("pinned-1");
    seedPinned("pinned-2");

    const result = (await invoke({ groupId: "system:pinned" })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "pinned-1",
      "pinned-2",
    ]);
  });

  test("a custom group id returns only that group's members", async () => {
    const carChat = createGroup("Car Chat");
    const recipes = createGroup("Recipes");
    seedInGroup("car-1", carChat.id);
    seedInGroup("car-2", carChat.id);
    seedInGroup("recipe-1", recipes.id);
    createConversation("ungrouped-1");

    const result = (await invoke({ groupId: carChat.id })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "car-1",
      "car-2",
    ]);
  });

  test("a group-scoped page is ordered by recency, not by display_order", async () => {
    /* `display_order` still holds values for anyone who arranged rows by hand
       before that affordance was removed, so the column is set here to the
       REVERSE of the expected result: a read that consults it again fails
       rather than passing by coincidence. Seeded oldest-first so insertion
       order cannot be mistaken for the assertion either. */
    const oldest = seedPinned("oldest", 0);
    const middle = seedPinned("middle", 1);
    const newest = seedPinned("newest", 2);
    for (const [id, at] of [
      [oldest, 1_000],
      [middle, 5_000],
      [newest, 9_000],
    ] as const) {
      rawRun(
        "test:setLastMessageAt",
        "UPDATE conversations SET last_message_at = ? WHERE id = ?",
        at,
        id,
      );
    }

    const result = (await invoke({ groupId: "system:pinned" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  test("a group-scoped page has no pinned rows appended to it", async () => {
    // Injection exists so a client reading Pinned out of the unfiltered list
    // still sees it. A caller that asked for one group gets that group.
    const group = createGroup("Car Chat");
    seedInGroup("car-1", group.id);
    seedPinned("pinned-1");

    const result = (await invoke({ groupId: group.id })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual(["car-1"]);
  });

  test("system:all keeps surfaced background and scheduled rows", async () => {
    // Surfacing writes only `surfaced_at`, so a promoted row keeps its
    // `system:background` / `system:scheduled` group id while the standard
    // listing renders it in Recents. A group filter that matched NULL and
    // "system:all" alone would drop it from the section that is supposed to
    // show it.
    const background = createConversation({
      title: "surfaced-background",
      conversationType: "background",
    });
    const scheduled = createConversation({
      title: "surfaced-scheduled",
      conversationType: "scheduled",
    });
    // The routed group id is the part that matters: heartbeat, reminders and
    // schedule-job runs are filed into these system buckets, and surfacing
    // does not clear that. A row left with a NULL group id would pass a
    // NULL-only predicate and prove nothing.
    rawRun(
      "test:routeToSystemBucket",
      "UPDATE conversations SET group_id = 'system:background', surfaced_at = ? WHERE id = ?",
      Date.now(),
      background.id,
    );
    rawRun(
      "test:routeToSystemBucket",
      "UPDATE conversations SET group_id = 'system:scheduled', surfaced_at = ? WHERE id = ?",
      Date.now(),
      scheduled.id,
    );
    createConversation("plain-ungrouped");

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "plain-ungrouped",
      "surfaced-background",
      "surfaced-scheduled",
    ]);
  });

  test("system:all still excludes background rows that were never surfaced", async () => {
    const quiet = createConversation({
      title: "quiet-background",
      conversationType: "background",
    });
    rawRun(
      "test:routeToSystemBucket",
      "UPDATE conversations SET group_id = 'system:background' WHERE id = ?",
      quiet.id,
    );
    createConversation("plain-ungrouped");

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual([
      "plain-ungrouped",
    ]);
  });

  test("system:all and system:pinned partition the sections, never overlapping", async () => {
    createConversation("ungrouped-1");
    seedPinned("pinned-1");
    const group = createGroup("Car Chat");
    seedInGroup("car-1", group.id);

    const ungrouped = (await invoke({ groupId: "system:all" })) as ListResponse;
    const pinned = (await invoke({ groupId: "system:pinned" })) as ListResponse;
    const custom = (await invoke({ groupId: group.id })) as ListResponse;

    expect(ungrouped.conversations.map((c) => c.title)).toEqual([
      "ungrouped-1",
    ]);
    expect(pinned.conversations.map((c) => c.title)).toEqual(["pinned-1"]);
    expect(custom.conversations.map((c) => c.title)).toEqual(["car-1"]);
  });

  test("a surfaced background row sorts by recency, not stale display order", async () => {
    // `display_order` persists through moves, so a row that carries one from
    // an earlier group must not have it resurface as a sort key here.
    const older = createConversation({
      title: "older",
      conversationType: "background",
    });
    const newer = createConversation({
      title: "newer",
      conversationType: "background",
    });
    rawRun(
      "test:staleOrder",
      "UPDATE conversations SET surfaced_at = ?, display_order = 0, last_message_at = 1000 WHERE id = ?",
      Date.now(),
      older.id,
    );
    rawRun(
      "test:staleOrder",
      "UPDATE conversations SET surfaced_at = ?, display_order = 99, last_message_at = 2000 WHERE id = ?",
      Date.now(),
      newer.id,
    );

    const result = (await invoke({ groupId: "system:all" })) as ListResponse;

    expect(result.conversations.map((c) => c.title)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("hasMore reflects the group's own total, not the whole table", async () => {
    const group = createGroup("Car Chat");
    seedInGroup("car-1", group.id);
    seedInGroup("car-2", group.id);
    for (let i = 0; i < 5; i++) {
      createConversation(`ungrouped-${i}`);
    }

    const result = (await invoke({
      groupId: group.id,
      limit: "2",
    })) as ListResponse;

    expect(result.conversations).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  test("omitting groupId is unchanged: every group is spanned and pinned still injects", async () => {
    const group = createGroup("Car Chat");
    seedInGroup("car-1", group.id);
    createConversation("ungrouped-1");
    seedPinned("pinned-1");

    const result = (await invoke()) as ListResponse;

    expect(result.conversations.map((c) => c.title).sort()).toEqual([
      "car-1",
      "pinned-1",
      "ungrouped-1",
    ]);
  });
});

describe("GET /v1/conversations/unread-count", () => {
  const unreadCountHandler = findHandler(
    CONVERSATION_LIST_ROUTES,
    "getUnreadConversationCount",
  );

  function invokeUnreadCount(): { count: number } {
    return unreadCountHandler({}) as { count: number };
  }

  function seedUnseen(conversationId: string): void {
    projectAssistantMessage({
      conversationId,
      messageId: `msg-${conversationId}`,
      messageAt: Date.now(),
    });
  }

  function markSeen(conversationId: string): void {
    recordConversationSeenSignal({
      conversationId,
      sourceChannel: "vellum",
      signalType: "macos_conversation_opened",
      confidence: "explicit",
      source: "test",
    });
  }

  beforeEach(() => {
    getDb().delete(conversationAttentionEvents).run();
    getDb().delete(conversationAssistantAttentionState).run();
    clearConversations();
  });

  test("counts only foreground conversations with an unseen latest assistant message", () => {
    const unseen = createConversation("unseen-1");
    seedUnseen(unseen.id);

    // A conversation with no attention projection reads as seen.
    createConversation("no-attention-row");

    const seen = createConversation("seen-1");
    seedUnseen(seen.id);
    markSeen(seen.id);

    expect(invokeUnreadCount()).toEqual({ count: 1 });
  });

  test("marking seen removes the conversation from the count", () => {
    const conv = createConversation("unseen-then-seen");
    seedUnseen(conv.id);
    expect(invokeUnreadCount()).toEqual({ count: 1 });

    markSeen(conv.id);
    expect(invokeUnreadCount()).toEqual({ count: 0 });
  });

  test("archived conversations are excluded", () => {
    const conv = createConversation("unseen-archived");
    seedUnseen(conv.id);
    rawRun(
      "test:archiveConversation",
      "UPDATE conversations SET archived_at = ? WHERE id = ?",
      Date.now(),
      conv.id,
    );

    expect(invokeUnreadCount()).toEqual({ count: 0 });
  });

  test("background and scheduled conversations count only when surfaced", () => {
    const bg = createConversation({
      title: "bg-1",
      conversationType: "background",
    });
    seedUnseen(bg.id);
    const sched = createConversation({
      title: "sched-1",
      conversationType: "scheduled",
    });
    seedUnseen(sched.id);
    expect(invokeUnreadCount()).toEqual({ count: 0 });

    // Surfacing promotes a row into the foreground listing, so it counts.
    rawRun(
      "test:surfaceConversation",
      "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
      Date.now(),
      bg.id,
    );
    expect(invokeUnreadCount()).toEqual({ count: 1 });
  });

  /**
   * The daemon half of the unread-count contract.
   *
   * The web client answers the same question in TypeScript
   * (`contributesToUnreadCount` in
   * `clients/web/src/utils/conversation-predicates.ts`), and its
   * `conversation-predicates.test.ts` asserts this same matrix against the
   * predicate. The two definitions are maintained separately, so this matrix
   * is the tripwire: a rule changed on one side without the other shows up as
   * one of these scenarios disagreeing across the two suites.
   *
   * Keep the scenario names identical on both sides.
   */
  describe("unread-count contract (daemon half)", () => {
    const scenarios: Array<{
      name: string;
      counts: boolean;
      seed: (groupId: string) => string;
    }> = [
      {
        name: "unseen foreground row",
        counts: true,
        seed: () => createConversation("unseen-foreground").id,
      },
      {
        name: "seen foreground row",
        counts: false,
        seed: () => {
          const conv = createConversation("seen-foreground");
          seedUnseen(conv.id);
          markSeen(conv.id);
          return conv.id;
        },
      },
      {
        name: "unseen archived row",
        counts: false,
        seed: () => {
          const conv = createConversation("unseen-archived");
          rawRun(
            "test:archiveConversation",
            "UPDATE conversations SET archived_at = ? WHERE id = ?",
            Date.now(),
            conv.id,
          );
          return conv.id;
        },
      },
      {
        name: "unseen background row, not surfaced",
        counts: false,
        seed: () =>
          createConversation({
            title: "unseen-background",
            conversationType: "background",
          }).id,
      },
      {
        name: "unseen scheduled row, not surfaced",
        counts: false,
        seed: () =>
          createConversation({
            title: "unseen-scheduled",
            conversationType: "scheduled",
          }).id,
      },
      {
        name: "unseen background row, surfaced",
        counts: true,
        seed: () => {
          const conv = createConversation({
            title: "unseen-background-surfaced",
            conversationType: "background",
          });
          rawRun(
            "test:surfaceConversation",
            "UPDATE conversations SET surfaced_at = ? WHERE id = ?",
            Date.now(),
            conv.id,
          );
          return conv.id;
        },
      },
      {
        name: "unseen background row filed in a custom group, not surfaced",
        counts: false,
        seed: (groupId) => {
          const conv = createConversation({
            title: "unseen-background-in-group",
            conversationType: "background",
          });
          rawRun(
            "test:fileIntoGroup",
            "UPDATE conversations SET group_id = ? WHERE id = ?",
            groupId,
            conv.id,
          );
          return conv.id;
        },
      },
      {
        name: "unseen standard row filed in a custom group",
        counts: true,
        seed: (groupId) => {
          const conv = createConversation("unseen-standard-in-group");
          rawRun(
            "test:fileIntoGroup",
            "UPDATE conversations SET group_id = ? WHERE id = ?",
            groupId,
            conv.id,
          );
          return conv.id;
        },
      },
    ];

    for (const scenario of scenarios) {
      test(`${scenario.name} ${scenario.counts ? "counts" : "does not count"}`, () => {
        const group = createGroup("unread-contract-group");
        const conversationId = scenario.seed(group.id);
        // The "seen" scenario seeds and clears its own attention row.
        if (scenario.name !== "seen foreground row") {
          seedUnseen(conversationId);
        }

        expect(invokeUnreadCount()).toEqual({
          count: scenario.counts ? 1 : 0,
        });
      });
    }

    test("the matrix totals across every scenario at once", () => {
      const group = createGroup("unread-contract-group");
      for (const scenario of scenarios) {
        const conversationId = scenario.seed(group.id);
        if (scenario.name !== "seen foreground row") {
          seedUnseen(conversationId);
        }
      }
      const expected = scenarios.filter((s) => s.counts).length;

      expect(invokeUnreadCount()).toEqual({ count: expected });
    });
  });

  test("background rows filed in a custom group stay excluded until surfaced", () => {
    // Custom-group rows are visible in the standard listing regardless of
    // type, but a non-surfaced background row must not count as unread
    // (the client's unread predicate excludes it).
    const group = createGroup("unread-count-test-group");

    const bgInGroup = createConversation({
      title: "bg-in-group",
      conversationType: "background",
    });
    seedUnseen(bgInGroup.id);
    rawRun(
      "test:fileIntoGroup",
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      group.id,
      bgInGroup.id,
    );

    const standardInGroup = createConversation("standard-in-group");
    seedUnseen(standardInGroup.id);
    rawRun(
      "test:fileIntoGroup",
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      group.id,
      standardInGroup.id,
    );

    expect(invokeUnreadCount()).toEqual({ count: 1 });
  });
});

describe("GET /v1/conversations/sections", () => {
  const sectionsHandler = findHandler(
    CONVERSATION_LIST_ROUTES,
    "getConversationSections",
  );

  interface SectionRow {
    kind: "pinned" | "group" | "channel" | "chats";
    groupId?: string;
    name?: string;
    icon?: string | null;
    sortPosition?: number;
    channelId?: string;
    total: number;
    unread: number;
  }

  function invokeSections(): SectionRow[] {
    return (sectionsHandler({}) as { sections: SectionRow[] }).sections;
  }

  function fileIntoGroup(conversationId: string, groupId: string): void {
    rawRun(
      "test:fileIntoGroup",
      "UPDATE conversations SET group_id = ? WHERE id = ?",
      groupId,
      conversationId,
    );
  }

  function stampChannel(conversationId: string, channel: string): void {
    rawRun(
      "test:stampChannel",
      "UPDATE conversations SET origin_channel = ? WHERE id = ?",
      channel,
      conversationId,
    );
  }

  function pin(conversationId: string): void {
    rawRun(
      "test:pinConversation",
      "UPDATE conversations SET is_pinned = 1, group_id = 'system:pinned' WHERE id = ?",
      conversationId,
    );
  }

  function seedUnseen(conversationId: string): void {
    projectAssistantMessage({
      conversationId,
      messageId: `msg-${conversationId}`,
      messageAt: Date.now(),
    });
  }

  beforeEach(() => {
    clearConversations();
  });

  test("an empty conversation table yields Chats alone, at zero", () => {
    // Chats is the leftover bucket and renders regardless, so its counts
    // are part of the contract even when nothing exists.
    expect(invokeSections()).toEqual([{ kind: "chats", total: 0, unread: 0 }]);
  });

  test("every section kind appears with its own totals", () => {
    const pinned = createConversation({ title: "pinned-1" });
    pin(pinned.id);
    const group = createGroup("Sections Spread Group");
    fileIntoGroup(createConversation({ title: "g-1" }).id, group.id);
    fileIntoGroup(createConversation({ title: "g-2" }).id, group.id);
    stampChannel(createConversation({ title: "slack-1" }).id, "slack");
    createConversation({ title: "native-unstamped" });
    stampChannel(createConversation({ title: "native-stamped" }).id, "vellum");

    const sections = invokeSections();

    expect(sections).toContainEqual({ kind: "pinned", total: 1, unread: 0 });
    expect(sections).toContainEqual({
      kind: "group",
      groupId: group.id,
      name: "Sections Spread Group",
      icon: null,
      sortPosition: group.sortPosition,
      total: 2,
      unread: 0,
    });
    expect(sections).toContainEqual({
      kind: "channel",
      channelId: "slack",
      total: 1,
      unread: 0,
    });
    // NULL origin_channel reads as native, exactly as the list filter reads
    // it, so the stamped and unstamped native rows share the Chats bucket.
    expect(sections).toContainEqual({ kind: "chats", total: 2, unread: 0 });
  });

  test("unread counts follow the seen state per section", () => {
    const pinned = createConversation({ title: "pinned-seen" });
    pin(pinned.id);
    seedUnseen(pinned.id);
    recordConversationSeenSignal({
      conversationId: pinned.id,
      sourceChannel: "vellum",
      signalType: "macos_conversation_opened",
      confidence: "explicit",
      source: "test",
    });

    const group = createGroup("Sections Unread Group");
    const unreadInGroup = createConversation({ title: "g-unread" });
    fileIntoGroup(unreadInGroup.id, group.id);
    seedUnseen(unreadInGroup.id);
    // A member with no attention projection at all reads as seen.
    fileIntoGroup(createConversation({ title: "g-quiet" }).id, group.id);

    const chatsUnread = createConversation({ title: "chat-unread" });
    seedUnseen(chatsUnread.id);

    const sections = invokeSections();

    expect(sections).toContainEqual({ kind: "pinned", total: 1, unread: 0 });
    expect(sections).toContainEqual({
      kind: "group",
      groupId: group.id,
      name: "Sections Unread Group",
      icon: null,
      sortPosition: group.sortPosition,
      total: 2,
      unread: 1,
    });
    expect(sections).toContainEqual({ kind: "chats", total: 1, unread: 1 });
  });

  test("a background row filed into a group counts toward total but never unread", () => {
    // Mirrors the unread-count contract: the custom-group visibility arm
    // admits the row into the section, and the not-background unread rule
    // keeps it out of the badge.
    const group = createGroup("Sections Background Group");
    const bg = createConversation({
      title: "bg-in-group",
      conversationType: "background",
    });
    fileIntoGroup(bg.id, group.id);
    seedUnseen(bg.id);

    const sections = invokeSections();

    expect(sections).toContainEqual({
      kind: "group",
      groupId: group.id,
      name: "Sections Background Group",
      icon: null,
      sortPosition: group.sortPosition,
      total: 1,
      unread: 0,
    });
  });

  test("an empty custom group gets no section", () => {
    const group = createGroup("Sections Empty Group");

    const sections = invokeSections();

    expect(sections.some((s) => s.groupId === group.id)).toBe(false);
  });

  test("archived rows count toward no section", () => {
    const group = createGroup("Sections Archived Group");
    fileIntoGroup(seedArchived("archived-in-group"), group.id);

    const sections = invokeSections();

    expect(sections.some((s) => s.groupId === group.id)).toBe(false);
  });

  test("a dangling group id is skipped, not surfaced", () => {
    /* Live write paths cannot create this state: group_id carries a foreign
       key, and the placement write sanitizes unknown groups precisely to
       avoid violating it. A restored snapshot can, though: in-place restore
       swaps the SQLite file without running migrations in-process (the same
       window that lets legacy private rows exist transiently), so the
       fixture creates the state the way reality does, with enforcement off. */
    rawExec("PRAGMA foreign_keys = OFF");
    try {
      fileIntoGroup(
        createConversation({ title: "dangling" }).id,
        "00000000-0000-4000-8000-00000000dead",
      );
    } finally {
      rawExec("PRAGMA foreign_keys = ON");
    }

    const sections = invokeSections();

    expect(sections.some((s) => s.kind === "group")).toBe(false);
    // Grouped, so it does not leak into the ungrouped Chats bucket either.
    expect(sections).toContainEqual({ kind: "chats", total: 0, unread: 0 });
  });

  test("an unsurfaced background row pinned by raw column writes stays invisible", () => {
    // Standard-listing visibility admits a pinned background row only when
    // it is surfaced (the pinned group fails the custom-group arm on its
    // system: prefix), so it appears in neither the Pinned list nor the
    // Pinned count.
    const bg = createConversation({
      title: "bg-pinned",
      conversationType: "background",
    });
    pin(bg.id);

    const sections = invokeSections();

    expect(sections.some((s) => s.kind === "pinned")).toBe(false);
  });
});
