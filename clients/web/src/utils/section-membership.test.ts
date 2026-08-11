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
  conversationsQueryKey,
  sectionConversationsQueryKey,
  sidebarSectionsQueryKey,
  type SectionConversationFilter,
  type SidebarIndexSection,
} from "@/utils/conversation-list-fetchers";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  ensureSectionInIndex,
  matchesSectionFilter,
  patchAffectsMembership,
  reconcileSectionMembership,
} from "@/utils/section-membership";

const ASSISTANT_ID = "asst-1";

const PINNED: SectionConversationFilter = { groupId: "system:pinned" };
const CHATS: SectionConversationFilter = { groupId: "system:all" };
const SLACK: SectionConversationFilter = {
  groupId: "system:all",
  originChannel: "slack",
};
const NATIVE_CHATS: SectionConversationFilter = {
  groupId: "system:all",
  originChannel: "vellum",
};
const CUSTOM: SectionConversationFilter = { groupId: "group-uuid" };

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
  sections: Array<[SectionConversationFilter, Conversation[]]>,
): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  for (const [filter, rows] of sections) {
    client.setQueryData(
      sectionConversationsQueryKey(ASSISTANT_ID, filter),
      rows,
    );
  }
  return client;
}

function rowsIn(
  client: QueryClient,
  filter: SectionConversationFilter,
): Conversation[] {
  return (
    client.getQueryData<Conversation[]>(
      sectionConversationsQueryKey(ASSISTANT_ID, filter),
    ) ?? []
  );
}

/** How many sections hold `conversationId`, counting duplicates within one. */
function copiesAcrossSections(
  client: QueryClient,
  filters: SectionConversationFilter[],
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
      client.getQueryData(sectionConversationsQueryKey(ASSISTANT_ID, PINNED)),
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
    client.setQueryData(sectionConversationsQueryKey(ASSISTANT_ID, CHATS), [
      conversation({ conversationId: "c1" }),
    ]);
    const pinnedKey = sectionConversationsQueryKey(ASSISTANT_ID, PINNED);
    void client
      .prefetchQuery({
        queryKey: pinnedKey,
        queryFn: () => new Promise<Conversation[]>(() => {}),
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
    client.setQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID), [
      row,
    ]);

    reconcileSectionMembership(client, ASSISTANT_ID, {
      ...row,
      isPinned: true,
      groupId: "system:pinned",
    });

    expect(
      client
        .getQueryData<Conversation[]>(conversationsQueryKey(ASSISTANT_ID))
        ?.map((c) => c.conversationId),
    ).toEqual(["c1"]);
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
