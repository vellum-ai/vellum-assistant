/**
 * Tests for local section membership.
 *
 * Two things are under test and they fail in different ways.
 *
 * {@link matchesSectionFilter} is a twin of the daemon's SQL, so its tests are
 * written as the same scenario matrix the server clauses cover: a rule that
 * drifts from `groupIdClause` / `originChannelClause` puts a row in a section
 * the next refetch takes it back out of, which looks like a flicker rather
 * than a wrong answer.
 *
 * {@link reconcileSectionMembership} is the write, and the invariant it has to
 * hold is "a conversation appears in exactly one section, never twice"
 * (LUM-2443). Its tests count copies across every seeded section rather than
 * asserting the destination contains the row: a row that arrives in Pinned
 * while still sitting in the section it left satisfies every presence-only
 * assertion.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type { Conversation } from "@/types/conversation-types";
import {
  sidebarSectionsQueryKey,
  type SidebarIndexSection,
  type ConversationListPage,
} from "@/utils/conversation-list-fetchers";
import {
  conversationListQueryKey,
  type ConversationListFilter,
} from "@/utils/conversation-list-keys";
import { listPage } from "@/utils/conversation-list.test-helper";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  ensureSectionInIndex,
  matchesSectionFilter,
  patchAffectsMembership,
  reconcileSectionMembership,
  sectionFiltersHolding,
} from "@/utils/section-membership";

const ASSISTANT_ID = "asst-1";

const PINNED: ConversationListFilter = { groupId: "system:pinned" };
const CHATS: ConversationListFilter = { groupId: "system:all" };
const SLACK: ConversationListFilter = {
  groupId: "system:all",
  originChannel: "slack",
};
const NATIVE_CHATS: ConversationListFilter = {
  groupId: "system:all",
  originChannel: "vellum",
};
const CUSTOM: ConversationListFilter = { groupId: "group-uuid" };

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return { conversationId: "conv-1", lastMessageAt: 1_000, ...overrides };
}

// ---------------------------------------------------------------------------
// matchesSectionFilter
// ---------------------------------------------------------------------------

describe("matchesSectionFilter", () => {
  test("Pinned takes a row pinned by either representation", () => {
    expect(matchesSectionFilter(conversation({ isPinned: true }), PINNED)).toBe(
      true,
    );
    expect(
      matchesSectionFilter(conversation({ groupId: "system:pinned" }), PINNED),
    ).toBe(true);
    expect(matchesSectionFilter(conversation(), PINNED)).toBe(false);
  });

  test("system:all means unclaimed, so it admits a row with no group", () => {
    // The overwhelming majority of rows carry no `group_id` at all, and the
    // server's clause is `group_id IS NULL OR ...` for exactly this reason.
    expect(matchesSectionFilter(conversation(), CHATS)).toBe(true);
  });

  test("system:all admits the non-pinned system buckets", () => {
    // Mirrors `group_id LIKE 'system:%' AND group_id != 'system:pinned'`. A
    // surfaced background row keeps `system:background` and still renders in
    // Chats.
    expect(
      matchesSectionFilter(
        conversation({ groupId: "system:background", surfacedAt: 5 }),
        CHATS,
      ),
    ).toBe(true);
  });

  test("system:all excludes pinned and custom-group rows", () => {
    expect(matchesSectionFilter(conversation({ isPinned: true }), CHATS)).toBe(
      false,
    );
    expect(
      matchesSectionFilter(conversation({ groupId: "group-uuid" }), CHATS),
    ).toBe(false);
  });

  test("a custom group matches its id exactly", () => {
    expect(
      matchesSectionFilter(conversation({ groupId: "group-uuid" }), CUSTOM),
    ).toBe(true);
    expect(
      matchesSectionFilter(conversation({ groupId: "other-uuid" }), CUSTOM),
    ).toBe(false);
  });

  test("both axes are ANDed", () => {
    const slackRow = conversation({ originChannel: "slack" });
    expect(matchesSectionFilter(slackRow, SLACK)).toBe(true);
    // Filed into a custom group, it leaves the Slack card rather than
    // rendering in both.
    expect(
      matchesSectionFilter(
        conversation({ originChannel: "slack", groupId: "group-uuid" }),
        SLACK,
      ),
    ).toBe(false);
    expect(matchesSectionFilter(conversation(), SLACK)).toBe(false);
  });

  test("vellum admits an unattributed row, every other channel is exact", () => {
    // `origin_channel` is left unset so an inbound message can still claim
    // the conversation; reading unset as native is the self-correcting error.
    expect(matchesSectionFilter(conversation(), NATIVE_CHATS)).toBe(true);
    expect(
      matchesSectionFilter(
        conversation({ originChannel: "vellum" }),
        NATIVE_CHATS,
      ),
    ).toBe(true);
    expect(
      matchesSectionFilter(
        conversation({ originChannel: "slack" }),
        NATIVE_CHATS,
      ),
    ).toBe(false);
  });

  test("an archived row belongs to no section", () => {
    for (const filter of [PINNED, CHATS, SLACK, CUSTOM]) {
      expect(
        matchesSectionFilter(
          conversation({
            archivedAt: 10,
            isPinned: true,
            groupId: "system:pinned",
          }),
          filter,
        ),
      ).toBe(false);
    }
  });

  test("a private conversation belongs to no section", () => {
    // Excluded by all three arms of the daemon's visibility predicate.
    for (const filter of [PINNED, CHATS, CUSTOM]) {
      expect(
        matchesSectionFilter(
          conversation({
            conversationType: "private",
            surfacedAt: 5,
            groupId: filter === CUSTOM ? "group-uuid" : undefined,
          }),
          filter,
        ),
      ).toBe(false);
    }
  });

  test("a subagent run is excluded from the surfaced and filed arms only", () => {
    /* The foreground arm does not test `source`, so a standard subagent row
       stays visible; the surfaced and custom-group arms exclude it. Mirrors
       `surfacedVisibilitySql` / `customGroupVisibilitySql`. */
    const subagentBackground = conversation({
      source: "subagent",
      conversationType: "background",
      surfacedAt: 5,
    });
    expect(matchesSectionFilter(subagentBackground, CHATS)).toBe(false);
    expect(
      matchesSectionFilter(
        { ...subagentBackground, surfacedAt: undefined, groupId: "group-uuid" },
        CUSTOM,
      ),
    ).toBe(false);
    expect(
      matchesSectionFilter(conversation({ source: "subagent" }), CHATS),
    ).toBe(true);
  });

  test("a background run reaches a section only when surfaced or filed", () => {
    const background = conversation({ conversationType: "background" });
    expect(matchesSectionFilter(background, CHATS)).toBe(false);
    expect(matchesSectionFilter({ ...background, surfacedAt: 5 }, CHATS)).toBe(
      true,
    );
    expect(
      matchesSectionFilter({ ...background, groupId: "group-uuid" }, CUSTOM),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// patchAffectsMembership
// ---------------------------------------------------------------------------

describe("patchAffectsMembership", () => {
  test("true for every field a section filter reads", () => {
    expect(patchAffectsMembership({ groupId: "system:pinned" })).toBe(true);
    expect(patchAffectsMembership({ isPinned: true })).toBe(true);
    expect(patchAffectsMembership({ archivedAt: 1 })).toBe(true);
    expect(patchAffectsMembership({ surfacedAt: 1 })).toBe(true);
  });

  test("false for the patches that only change how a row renders", () => {
    // Mark-seen and rename run constantly, including per row in the bulk
    // paths; they must not pay for a membership pass.
    expect(
      patchAffectsMembership({ hasUnseenLatestAssistantMessage: false }),
    ).toBe(false);
    expect(patchAffectsMembership({ title: "renamed" })).toBe(false);
  });

  test("an explicit undefined still counts", () => {
    // Unarchive patches `archivedAt: undefined`, which is a membership change
    // even though the value is absent. Presence of the key is the test.
    expect(patchAffectsMembership({ archivedAt: undefined })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileSectionMembership
// ---------------------------------------------------------------------------

function seed(
  sections: Array<[ConversationListFilter, Conversation[], boolean?]>,
): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const [filter, rows, hasMore] of sections) {
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, filter),
      listPage(rows, hasMore),
    );
  }
  return client;
}

function rowsIn(
  client: QueryClient,
  filter: ConversationListFilter,
): Conversation[] {
  return (
    client.getQueryData<ConversationListPage>(
      conversationListQueryKey(ASSISTANT_ID, filter),
    )?.conversations ?? []
  );
}

/** How many sections hold `conversationId`, counting duplicates within one. */
function copiesAcrossSections(
  client: QueryClient,
  filters: ConversationListFilter[],
  conversationId: string,
): number {
  return filters.reduce(
    (total, filter) =>
      total +
      rowsIn(client, filter).filter((c) => c.conversationId === conversationId)
        .length,
    0,
  );
}

describe("reconcileSectionMembership", () => {
  test("pinning moves the row out of its section and into Pinned", () => {
    const row = conversation({ conversationId: "c1", originChannel: "slack" });
    const client = seed([
      [SLACK, [row]],
      [PINNED, []],
    ]);

    const changed = reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: true,
      groupId: "system:pinned",
    });

    // The invariant, not the destination: arriving in Pinned while still
    // sitting in Slack would satisfy the two assertions below on its own.
    expect(copiesAcrossSections(client, [SLACK, PINNED], "c1")).toBe(1);
    expect(rowsIn(client, PINNED).map((c) => c.conversationId)).toEqual(["c1"]);
    expect(rowsIn(client, SLACK)).toEqual([]);
    expect(changed).toHaveLength(2);
  });

  test("unpinning returns the row to the section that claims it", () => {
    const row = conversation({
      conversationId: "c1",
      originChannel: "slack",
      isPinned: true,
      groupId: "system:pinned",
    });
    const client = seed([
      [SLACK, []],
      [PINNED, [row]],
    ]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: false,
      groupId: "system:all",
    });

    expect(copiesAcrossSections(client, [SLACK, PINNED], "c1")).toBe(1);
    expect(rowsIn(client, SLACK).map((c) => c.conversationId)).toEqual(["c1"]);
    expect(rowsIn(client, PINNED)).toEqual([]);
  });

  test("pinning a background run places it once its promotion is stamped", () => {
    /* A background row reaches the sidebar only by being surfaced, and the
       daemon stamps `surfaced_at` in the same write that pins it. The patch
       has to carry that stamp or the row belongs to no section and the move
       waits for the refetch. */
    const row = conversation({
      conversationId: "c1",
      conversationType: "background",
    });
    const client = seed([[PINNED, []]]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: true,
      groupId: "system:pinned",
      surfacedAt: 42,
    });

    expect(rowsIn(client, PINNED).map((c) => c.conversationId)).toEqual(["c1"]);
  });

  test("demoting a surfaced background run keeps it out of Chats", () => {
    /* Moving into `system:background` clears the promotion, so the row leaves
       the sidebar. Without the cleared stamp it reads as an ordinary
       ungrouped row and lands in Chats, which is a worse failure than the lag
       it replaces: the refetch takes it straight back out. */
    const row = conversation({
      conversationId: "c1",
      conversationType: "background",
      surfacedAt: 42,
      isPinned: true,
      groupId: "system:pinned",
    });
    const client = seed([
      [CHATS, []],
      [PINNED, [row]],
    ]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: false,
      groupId: "system:background",
      surfacedAt: undefined,
    });

    expect(copiesAcrossSections(client, [CHATS, PINNED], "c1")).toBe(0);
  });

  test("archiving takes the row out of every section", () => {
    const row = conversation({ conversationId: "c1" });
    const client = seed([
      [CHATS, [row]],
      [PINNED, []],
    ]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      archivedAt: 99,
    });

    expect(copiesAcrossSections(client, [CHATS, PINNED], "c1")).toBe(0);
  });

  test("the row lands at its recency position, not at either end", () => {
    const client = seed([
      [
        PINNED,
        [
          conversation({ conversationId: "newer", lastMessageAt: 3_000 }),
          conversation({ conversationId: "older", lastMessageAt: 1_000 }),
        ],
      ],
    ]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      conversationId: "middle",
      lastMessageAt: 2_000,
      isPinned: true,
      groupId: "system:pinned",
    });

    expect(rowsIn(client, PINNED).map((c) => c.conversationId)).toEqual([
      "newer",
      "middle",
      "older",
    ]);
  });

  test("a row older than a window's last row is dropped, not appended", () => {
    /* The cache is a prefix of the true list (hasMore). Appending a row
       that belongs past the window would render it at the wrong position
       and hide the real page boundary; membership is not lost, load-more
       reaches it. Count the copies: zero in the destination window. */
    const client = seed([
      [
        PINNED,
        [
          conversation({ conversationId: "newer", lastMessageAt: 3_000 }),
          conversation({
            conversationId: "window-bottom",
            lastMessageAt: 2_000,
          }),
        ],
        true,
      ],
    ]);

    const changed = reconcileSectionMembership(client, ASSISTANT_ID, {
      conversationId: "ancient",
      lastMessageAt: 1_000,
      isPinned: true,
      groupId: "system:pinned",
    });

    expect(rowsIn(client, PINNED).map((c) => c.conversationId)).toEqual([
      "newer",
      "window-bottom",
    ]);
    /* Nothing changed, so nothing needs a settle refetch either. */
    expect(changed).toEqual([]);
  });

  test("a row inside the window still inserts when the cache is a window", () => {
    // The sibling of the drop test: the rule is positional, not "windows
    // reject inserts". Same window, a row newer than the bottom lands at
    // its recency position.
    const client = seed([
      [
        PINNED,
        [
          conversation({ conversationId: "newer", lastMessageAt: 3_000 }),
          conversation({
            conversationId: "window-bottom",
            lastMessageAt: 2_000,
          }),
        ],
        true,
      ],
    ]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      conversationId: "middle",
      lastMessageAt: 2_500,
      isPinned: true,
      groupId: "system:pinned",
    });

    expect(rowsIn(client, PINNED).map((c) => c.conversationId)).toEqual([
      "newer",
      "middle",
      "window-bottom",
    ]);
  });

  test("a complete section appends a row older than everything", () => {
    // hasMore false means the cache IS the list; there is no unloaded
    // remainder for the row to hide in, so it must land (at the end).
    const client = seed([
      [
        PINNED,
        [conversation({ conversationId: "only", lastMessageAt: 5_000 })],
      ],
    ]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      conversationId: "ancient",
      lastMessageAt: 1_000,
      isPinned: true,
      groupId: "system:pinned",
    });

    expect(rowsIn(client, PINNED).map((c) => c.conversationId)).toEqual([
      "only",
      "ancient",
    ]);
  });

  test("removal from a window keeps it a window", () => {
    const row = conversation({ conversationId: "c1", originChannel: "slack" });
    const client = seed([[SLACK, [row], true]]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      archivedAt: 99,
    });

    const page = client.getQueryData<ConversationListPage>(
      conversationListQueryKey(ASSISTANT_ID, SLACK),
    );
    expect(page?.conversations).toEqual([]);
    expect(page?.hasMore).toBe(true);
  });

  test("a section that has never fetched is not created", () => {
    // `useSectionConversations` reads "has data" as permission to stop
    // painting its derived fallback, so minting a cache here would hand that
    // section a single row and present it as the whole section.
    const client = seed([[CHATS, [conversation({ conversationId: "c1" })]]]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      conversationId: "c1",
      isPinned: true,
      groupId: "system:pinned",
    });

    expect(
      client.getQueryData(conversationListQueryKey(ASSISTANT_ID, PINNED)),
    ).toBeUndefined();
    expect(rowsIn(client, CHATS)).toEqual([]);
  });

  test("a section whose first fetch was cancelled is reported for refetch", async () => {
    /* Optimistic writes cancel the list prefix so an in-flight response
       cannot land on top of them, which leaves a first fetch abandoned with
       no data and no pending request. Nothing can be written into that cache,
       so the settle has to re-drive it or the section never loads. */
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID, CHATS),
      listPage([conversation({ conversationId: "c1" })]),
    );
    const pinnedKey = conversationListQueryKey(ASSISTANT_ID, PINNED);
    void client
      .prefetchQuery({
        queryKey: pinnedKey,
        queryFn: () => new Promise<ConversationListPage>(() => {}),
      })
      .catch(() => {});
    await client.cancelQueries({ queryKey: pinnedKey });

    expect(client.getQueryData(pinnedKey)).toBeUndefined();

    const keys = reconcileSectionMembership(client, ASSISTANT_ID, {
      conversationId: "c1",
      isPinned: true,
      groupId: "system:pinned",
    });

    const serialized = keys.map((k) => JSON.stringify(k));
    expect(serialized).toContain(JSON.stringify(pinnedKey));
  });

  test("a member is replaced in place and reports no membership change", () => {
    const row = conversation({ conversationId: "c1", title: "before" });
    const client = seed([[CHATS, [row]]]);

    const changed = reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      title: "after",
    });

    expect(rowsIn(client, CHATS)[0]?.title).toBe("after");
    expect(changed).toEqual([]);
  });

  test("the foreground list is left alone", () => {
    /* It shares the `conversation-list` prefix but is not a section, so the
       key decoder rejects it. It has to survive: the sidebar still reads it
       to decide which sections exist at all, and a pinned row has to stay in
       it for Pinned to appear in the first place. */
    const row = conversation({ conversationId: "c1" });
    const client = seed([[CHATS, [row]]]);
    client.setQueryData(
      conversationListQueryKey(ASSISTANT_ID),
      listPage([row]),
    );

    reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: true,
      groupId: "system:pinned",
    });

    expect(
      client
        .getQueryData<ConversationListPage>(
          conversationListQueryKey(ASSISTANT_ID),
        )
        ?.conversations.map((c) => c.conversationId),
    ).toEqual(["c1"]);
  });

  test("a destination no cache claims is reported for refetch", () => {
    /* A group with no conversations has no section index row, so the sidebar
       never rendered it and nothing ever mounted its query. The walk sees no
       cache to place the row in and would report only the section it left,
       while `ensureSectionInIndex` reveals that section immediately and its
       first fetch races the move that caused it. The daemon suppresses sync
       echo to the client that made the change, so this key is the only thing
       that re-drives the section the row was just filed into. */
    const row = conversation({ conversationId: "c1" });
    const client = seed([[CHATS, [row]]]);

    const keys = reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      groupId: "group-uuid",
    });

    expect(keys).toContainEqual(conversationListQueryKey(ASSISTANT_ID, CUSTOM));
    // Named, not minted: a cache holding this one row would read as the
    // whole section.
    expect(
      client.getQueryData(conversationListQueryKey(ASSISTANT_ID, CUSTOM)),
    ).toBeUndefined();
  });

  test("the first pin reports Pinned when no Pinned cache exists", () => {
    const row = conversation({ conversationId: "c1" });
    const client = seed([[CHATS, [row]]]);

    const keys = reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: true,
      groupId: "system:pinned",
    });

    expect(keys).toContainEqual(conversationListQueryKey(ASSISTANT_ID, PINNED));
  });

  test("an unpinned channel row names the section in either view", () => {
    /* Unpinning a channel's only conversation returns it to a channel
       section that emptied out while it was pinned. Which section renders it
       depends on the view mode, which this layer does not know, so both are
       named; a key no query holds invalidates nothing. */
    const row = conversation({
      conversationId: "c1",
      isPinned: true,
      groupId: "system:pinned",
      originChannel: "slack",
    });
    const client = seed([[PINNED, [row]]]);

    const keys = reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: false,
      groupId: "system:all",
    });

    expect(keys).toContainEqual(conversationListQueryKey(ASSISTANT_ID, CHATS));
    expect(keys).toContainEqual(conversationListQueryKey(ASSISTANT_ID, SLACK));
  });

  test("a section the walk claimed is not also named from the row", () => {
    /* The loaded destination decides for itself, deliberate skips included,
       so a section that is already right is never refetched to confirm it. */
    const row = conversation({ conversationId: "c1" });
    const client = seed([[CHATS, [row]]]);

    const keys = reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      surfacedAt: 5,
    });

    expect(keys).not.toContainEqual(
      conversationListQueryKey(ASSISTANT_ID, CHATS),
    );
  });

  test("one view's loaded section does not answer for the other view's", () => {
    /* Claiming is per destination, not one flag for the row. Only one view is
       mounted at a time and the other view's caches outlive a toggle by their
       gc time, so a flat Chats cache left over from before the switch still
       claims an unpinned channel row. It is not the section the grouped view
       renders it in, and that one is empty and unmounted: the exact state
       this pass exists to catch. */
    const row = conversation({
      conversationId: "c1",
      isPinned: true,
      groupId: "system:pinned",
      originChannel: "slack",
    });
    const client = seed([
      [PINNED, [row]],
      [CHATS, []],
    ]);

    const keys = reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: false,
      groupId: "system:all",
    });

    expect(keys).toContainEqual(conversationListQueryKey(ASSISTANT_ID, SLACK));
  });

  test("an archived row names no destination", () => {
    /* It belongs to no section, so the only thing left to reconcile is the
       one it left. Naming a destination anyway would refetch a section to be
       told the row is not in it. */
    const row = conversation({ conversationId: "c1" });
    const client = seed([[CHATS, [row]]]);

    const keys = reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      archivedAt: 99,
    });

    expect(keys).toEqual([conversationListQueryKey(ASSISTANT_ID, CHATS)]);
  });
});

// ---------------------------------------------------------------------------
// sectionFiltersHolding
// ---------------------------------------------------------------------------

describe("sectionFiltersHolding", () => {
  test("pinned wins over every other axis", () => {
    expect(
      sectionFiltersHolding(
        conversation({
          isPinned: true,
          groupId: "group-uuid",
          originChannel: "slack",
        }),
      ),
    ).toEqual([PINNED]);
  });

  test("a custom group is the whole answer, whatever the channel", () => {
    expect(
      sectionFiltersHolding(
        conversation({ groupId: "group-uuid", originChannel: "slack" }),
      ),
    ).toEqual([CUSTOM]);
  });

  test("an unattributed row reads as native, like the daemon's COALESCE", () => {
    expect(sectionFiltersHolding(conversation())).toEqual([
      CHATS,
      NATIVE_CHATS,
    ]);
  });

  test("a channel this schema predates names no channel section", () => {
    /* Nothing could key a section by it either: the query parameter is a
       closed set, so sending it would fail the refetch being named. */
    expect(
      sectionFiltersHolding(conversation({ originChannel: "carrier-pigeon" })),
    ).toEqual([CHATS]);
  });

  test("a row no section can hold has no destination", () => {
    expect(sectionFiltersHolding(conversation({ archivedAt: 99 }))).toEqual([]);
    expect(
      sectionFiltersHolding(conversation({ conversationType: "background" })),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ensureSectionInIndex
// ---------------------------------------------------------------------------

describe("ensureSectionInIndex", () => {
  const INDEX_KEY = sidebarSectionsQueryKey(ASSISTANT_ID);
  const GROUPS_KEY = groupsGetQueryKey({
    path: { assistant_id: ASSISTANT_ID },
  });

  function indexClient(
    index: SidebarIndexSection[] | null | undefined,
  ): QueryClient {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (index !== undefined) {
      client.setQueryData(INDEX_KEY, index);
    }
    return client;
  }

  function kinds(client: QueryClient): string[] {
    return (
      client
        .getQueryData<SidebarIndexSection[]>(INDEX_KEY)
        ?.map((s) => s.kind) ?? []
    );
  }

  test("the first pin inserts a Pinned stub the settle refetch reconciles", () => {
    /* Without the stub the row is visible nowhere between the optimistic
       write and the settle: the membership pass removes it from its source
       section immediately, and no Pinned section renders until the index
       refetch answers. */
    const client = indexClient([{ kind: "chats", total: 3, unread: 0 }]);

    ensureSectionInIndex(
      client,
      ASSISTANT_ID,
      conversation({ isPinned: true, groupId: "system:pinned" }),
    );

    expect(kinds(client)).toContain("pinned");
  });

  test("an existing Pinned row is left alone", () => {
    const index: SidebarIndexSection[] = [
      { kind: "pinned", total: 2, unread: 1 },
    ];
    const client = indexClient(index);

    ensureSectionInIndex(
      client,
      ASSISTANT_ID,
      conversation({ isPinned: true, groupId: "system:pinned" }),
    );

    expect(client.getQueryData<SidebarIndexSection[]>(INDEX_KEY)).toBe(index);
  });

  test("the first row moved into an empty group inserts a stub with its metadata", () => {
    const client = indexClient([{ kind: "chats", total: 3, unread: 0 }]);
    client.setQueryData(GROUPS_KEY, {
      groups: [
        {
          id: "group-uuid",
          name: "Projects",
          icon: "folder",
          sortPosition: 2,
          isSystemGroup: false,
        },
      ],
    });

    ensureSectionInIndex(
      client,
      ASSISTANT_ID,
      conversation({ groupId: "group-uuid" }),
    );

    expect(
      client.getQueryData<SidebarIndexSection[]>(INDEX_KEY),
    ).toContainEqual({
      kind: "group",
      groupId: "group-uuid",
      name: "Projects",
      icon: "folder",
      sortPosition: 2,
      total: 1,
      unread: 0,
    });
  });

  test("a group the groups cache does not know is left to the settle refetch", () => {
    // A stub without a name cannot render; the rare gap stays on the
    // refetch rather than inventing metadata.
    const client = indexClient([{ kind: "chats", total: 3, unread: 0 }]);

    ensureSectionInIndex(
      client,
      ASSISTANT_ID,
      conversation({ groupId: "group-uuid" }),
    );

    expect(kinds(client)).toEqual(["chats"]);
  });

  test("an unpinned channel row restores its emptied channel bucket", () => {
    /* Pinning a channel's only conversation empties its bucket out of the
       index; the unpin returning the row targets a section the index no
       longer carries, and without the stub the row is visible nowhere until
       the settle refetch. */
    const client = indexClient([
      { kind: "pinned", total: 1, unread: 0 },
      { kind: "chats", total: 0, unread: 0 },
    ]);

    ensureSectionInIndex(
      client,
      ASSISTANT_ID,
      conversation({ originChannel: "slack", groupId: "system:all" }),
    );

    expect(
      client.getQueryData<SidebarIndexSection[]>(INDEX_KEY),
    ).toContainEqual({
      kind: "channel",
      channelId: "slack",
      total: 1,
      unread: 0,
    });
  });

  test("a native ungrouped row needs no stub", () => {
    // Chats renders regardless and the daemon always indexes it.
    const index: SidebarIndexSection[] = [
      { kind: "chats", total: 0, unread: 0 },
    ];
    const client = indexClient(index);

    ensureSectionInIndex(
      client,
      ASSISTANT_ID,
      conversation({ groupId: "system:all" }),
    );

    expect(client.getQueryData<SidebarIndexSection[]>(INDEX_KEY)).toBe(index);
  });

  test("a null index (assistant without the endpoint) is never written", () => {
    const client = indexClient(null);

    ensureSectionInIndex(
      client,
      ASSISTANT_ID,
      conversation({ isPinned: true, groupId: "system:pinned" }),
    );

    expect(client.getQueryData(INDEX_KEY)).toBeNull();
  });

  test("an ungrouped move inserts nothing", () => {
    const client = indexClient([{ kind: "chats", total: 3, unread: 0 }]);

    ensureSectionInIndex(
      client,
      ASSISTANT_ID,
      conversation({ groupId: "system:all" }),
    );

    expect(kinds(client)).toEqual(["chats"]);
  });
});
