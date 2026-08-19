/**
 * Which sidebar section a conversation belongs to, decided locally.
 *
 * Every section fetches its own rows through a server filter (LUM-2443), so a
 * section's membership is the contents of that section's cache entry rather
 * than something the client derives. A conversation's `groupId` / `isPinned` /
 * `archivedAt` are the server's inputs to that filter, so the moment a
 * mutation changes one of them locally, the caches disagree with the fields
 * until a refetch lands. Answering locally is what keeps a move off the
 * network: without it, each section corrects itself on its own round trip, and
 * a row is visible in two sections until the slower one returns.
 *
 * {@link matchesSectionFilter} is the client twin of the daemon's
 * `groupIdClause` / `originChannelClause` in
 * `assistant/src/persistence/conversation-queries.ts`. **Changing the rules
 * here means changing them there too**, or a locally placed row lands in a
 * section the next refetch takes it out of. The same twin relationship, and
 * the same warning, already governs `contributesToUnreadCount`.
 */

import { hashKey, type QueryClient } from "@tanstack/react-query";

import type { Conversation } from "@/types/conversation-types";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { GroupsGetResponse } from "@/generated/daemon/types.gen";
import {
  NATIVE_ORIGIN_CHANNEL,
  SYSTEM_ALL_GROUP_ID,
  SYSTEM_PINNED_GROUP_ID,
  isOriginChannel,
  sidebarSectionsQueryKey,
  type ConversationListPage,
  type SidebarIndexSection,
} from "@/utils/conversation-list-fetchers";
import {
  type ConversationListFilter,
  conversationListFilterOf,
  conversationListPrefix,
  conversationListQueryKey,
  isSectionFilter,
} from "@/utils/conversation-list-keys";
import { insertIntoWindow } from "@/utils/conversation-order";
import {
  isConversationPinned,
  isCustomGroupId,
} from "@/utils/conversation-predicates";

/**
 * The fields a section filter reads. A patch touching none of them cannot
 * change any section's membership, which is what lets the membership pass be
 * skipped for the common patches (seen state, title, processing flags).
 *
 * Derived from what {@link matchesSectionFilter} and
 * {@link isSidebarVisible} actually consult, so a rule that starts reading a
 * new field has to be added here in the same edit or the skip goes stale.
 */
const MEMBERSHIP_FIELDS = [
  "groupId",
  "isPinned",
  "archivedAt",
  "surfacedAt",
  "conversationType",
  "originChannel",
] as const satisfies readonly (keyof Conversation)[];

/**
 * Whether applying `patch` could move a conversation between sections.
 *
 * Presence, not value: a patch that sets `groupId` to what it already was
 * still runs the pass, which is a no-op that costs one comparison per cached
 * row. Comparing values here would mean reading the current row first, which
 * is the more expensive of the two.
 */
export function patchAffectsMembership(patch: Partial<Conversation>): boolean {
  return MEMBERSHIP_FIELDS.some((field) => field in patch);
}

/**
 * Whether any sidebar section can hold this conversation at all.
 *
 * The three arms of the daemon's `standardListingVisibilitySql`, plus the
 * archive filter every section query carries. Rows failing all three belong to
 * no section, so a local placement must not invent one for them.
 *
 * 1. **Foreground**: not a background, scheduled, or private run by type, and
 *    not routed to the `system:background` / `system:scheduled` groups.
 * 2. **Surfaced**: promoted through the surface API, or by a placement that
 *    stamps `surfaced_at` (see `resolvePlacementSurfacedAt`).
 * 3. **Custom group**: filed into a user-created group, whatever its type,
 *    because filing is an explicit organizational action.
 *
 * Private rows are excluded by all three. Subagent runs are excluded from the
 * surfaced and custom-group arms only, matching the SQL exactly: the
 * foreground arm does not test `source`.
 */
export function isSidebarVisible(
  conversation: Pick<
    Conversation,
    "archivedAt" | "conversationType" | "groupId" | "surfacedAt" | "source"
  >,
): boolean {
  if (conversation.archivedAt != null) {
    return false;
  }
  if (conversation.conversationType === "private") {
    return false;
  }
  const isForeground =
    conversation.conversationType !== "background" &&
    conversation.conversationType !== "scheduled" &&
    conversation.groupId !== "system:background" &&
    conversation.groupId !== "system:scheduled";
  if (isForeground) {
    return true;
  }
  const isSubagentRun = conversation.source === "subagent";
  if (isSubagentRun) {
    return false;
  }
  return (
    conversation.surfacedAt != null || isCustomGroupId(conversation.groupId)
  );
}

/**
 * Whether the section identified by `filter` holds this conversation.
 *
 * Both axes are ANDed, exactly as the daemon ANDs the two query parameters,
 * and an absent axis constrains nothing.
 *
 * Two of the server's clauses are tolerant, and both are reproduced here
 * rather than tightened:
 *
 * - `system:all` means "nothing else claimed it", so it matches a NULL group
 *   and the non-pinned system buckets, not the literal string. Most rows
 *   carry no `group_id` at all.
 * - `vellum` matches an unattributed row as well as an explicitly native one,
 *   because `origin_channel` is left unset at insert so an inbound message can
 *   still claim the conversation for its channel.
 *
 * The known asymmetry is on the channel axis and it predates this module:
 * `Conversation.originChannel` is binding-first on the client
 * (`channelBinding.sourceChannel ?? conversationOriginChannel`) while the
 * server matches the column alone, so a row whose binding names a channel its
 * column has not yet recorded reads as that channel here and as native there.
 * Self-correcting when the first inbound message stamps the column, and in the
 * safe direction: the row is in exactly one section throughout.
 */
export function matchesSectionFilter(
  conversation: Conversation,
  filter: ConversationListFilter,
): boolean {
  if (!isSidebarVisible(conversation)) {
    return false;
  }
  const { groupId, originChannel } = filter;

  if (groupId === SYSTEM_PINNED_GROUP_ID) {
    if (!isConversationPinned(conversation)) {
      return false;
    }
  } else if (groupId === SYSTEM_ALL_GROUP_ID) {
    if (
      isConversationPinned(conversation) ||
      isCustomGroupId(conversation.groupId)
    ) {
      return false;
    }
  } else if (groupId !== undefined && conversation.groupId !== groupId) {
    return false;
  }

  if (originChannel === undefined) {
    return true;
  }
  if (originChannel === NATIVE_ORIGIN_CHANNEL) {
    return (
      conversation.originChannel == null ||
      conversation.originChannel === NATIVE_ORIGIN_CHANNEL
    );
  }
  return conversation.originChannel === originChannel;
}

/**
 * Bring every cached section into agreement with `conversation`, and report
 * the sections a settle still has to ask the server about.
 *
 * Walks `getQueriesData` rather than writing through `setQueriesData` because
 * the decision needs the query *key*: a section states what it holds only
 * through the filter it was keyed by, and TanStack hands a `setQueriesData`
 * updater the data alone.
 *
 * Only caches that already hold rows are written. A section whose query has
 * not resolved must stay unfetched: `useSectionConversations` treats "has
 * data" as its signal to stop painting the derived fallback, so minting a
 * cache here would hand that section a single row and call it the whole
 * section.
 *
 * The returned keys are what a caller needs to reconcile narrowly, and they
 * are of three kinds:
 *
 * 1. Sections this write moved the row between. A move touches at most the
 *    one it left and the one it joined, so invalidating those beats
 *    invalidating the list prefix, which refetches every mounted section and
 *    the foreground list.
 * 2. Sections holding no data, which this write could not place the row in.
 *    A first fetch that was cancelled on the way in (optimistic writes cancel
 *    the prefix so an in-flight response cannot land on top of them) leaves an
 *    observer with nothing and no pending request, and a settle scoped to the
 *    sections that changed would never re-drive it.
 * 3. Each destination of the row that no walked cache claimed, one per
 *    section that could hold it (see {@link sectionFiltersHolding}). Kinds 1
 *    and 2 are both found by walking the cache, which answers only for
 *    sections something has already rendered; a section hidden because it was
 *    empty is precisely the one a placement fills and the one the walk cannot
 *    see.
 *
 * @see {@link https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientgetqueriesdata}
 */
/**
 * Make sure the section `conversation` now belongs to exists in the cached
 * section index, inserting a stub row when it does not.
 *
 * The index decides which sections *render*, so a placement whose
 * destination has no index row yet (the first pin, the first conversation
 * moved into an empty group, an unpin returning a channel's only
 * conversation) would otherwise leave the row visible nowhere:
 * the membership pass removes it from its source section immediately, and
 * the destination section would not exist until the settle refetch answers.
 *
 * Insertion-only, deliberately. The removal directions (a section emptied by
 * a move, a failed move's stub) merely linger as an empty or extra section
 * until the settle refetch reconciles, which is benign; counts on the stub
 * are approximations reconciled the same way. A `null` cache (assistant
 * without the endpoint) and an absent cache are both left alone.
 *
 * Group metadata comes from the cached groups list; a stub for a group the
 * groups cache does not know cannot be named and is skipped, leaving that
 * rare case on the settle refetch.
 */
/**
 * The one sidebar bucket that holds `conversation`, by the daemon's
 * aggregation precedence: the group axis wins (pinned, then a custom group),
 * then the effective origin channel, with an unattributed row reading as
 * native.
 *
 * One derivation, three projections: whether an index row is this row's
 * bucket ({@link matchesIndexBucket}), the index row to insert when none is
 * ({@link ensureSectionInIndex}), and the filters that fetch that section's
 * conversations ({@link sectionFiltersHolding}). The precedence is what has
 * to agree with the daemon, so it is stated once; three copies of it can only
 * drift, and a projection is the part that legitimately differs.
 *
 * Visibility is deliberately not consulted. This answers which bucket a row
 * belongs to, not whether any section shows it, and only the filter
 * projection needs the stronger question. Folding it in here would also
 * change what the unread deltas in `conversation-cache-mutations.ts` adjust
 * for an archived row, which is a separate question from this one.
 */
type SectionBucket =
  | { kind: "pinned" }
  | { kind: "group"; groupId: string }
  | { kind: "chats" }
  | { kind: "channel"; channelId: string };

function sectionBucketOf(conversation: Conversation): SectionBucket {
  if (isConversationPinned(conversation)) {
    return { kind: "pinned" };
  }
  const groupId = conversation.groupId;
  if (isCustomGroupId(groupId)) {
    return { kind: "group", groupId };
  }
  const channel = conversation.originChannel;
  if (channel == null || channel === NATIVE_ORIGIN_CHANNEL) {
    return { kind: "chats" };
  }
  return { kind: "channel", channelId: channel };
}

/**
 * Whether `row` is the index bucket holding `conversation`. Shared by the
 * stub insertion here and the unread deltas in
 * `conversation-cache-mutations.ts`; see {@link sectionBucketOf} for the
 * precedence itself.
 */
export function matchesIndexBucket(
  conversation: Conversation,
  row: SidebarIndexSection,
): boolean {
  const bucket = sectionBucketOf(conversation);
  switch (bucket.kind) {
    case "pinned":
      return row.kind === "pinned";
    case "group":
      return row.kind === "group" && row.groupId === bucket.groupId;
    case "chats":
      return row.kind === "chats";
    case "channel":
      return row.kind === "channel" && row.channelId === bucket.channelId;
  }
}

export function ensureSectionInIndex(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
): void {
  if (!assistantId) {
    return;
  }
  const queryKey = sidebarSectionsQueryKey(assistantId);
  const index = queryClient.getQueryData<SidebarIndexSection[] | null>(
    queryKey,
  );
  if (
    index == null ||
    index.some((row) => matchesIndexBucket(conversation, row))
  ) {
    return;
  }

  const bucket = sectionBucketOf(conversation);
  switch (bucket.kind) {
    case "pinned":
      queryClient.setQueryData<SidebarIndexSection[] | null>(queryKey, [
        { kind: "pinned", total: 1, unread: 0 },
        ...index,
      ]);
      return;
    case "group": {
      const groups = queryClient.getQueryData<GroupsGetResponse>(
        groupsGetQueryKey({ path: { assistant_id: assistantId } }),
      )?.groups;
      const meta = groups?.find((g) => g.id === bucket.groupId);
      if (!meta) {
        return;
      }
      queryClient.setQueryData<SidebarIndexSection[] | null>(queryKey, [
        ...index,
        {
          kind: "group",
          groupId: bucket.groupId,
          name: meta.name,
          icon: meta.icon ?? null,
          sortPosition: meta.sortPosition ?? 0,
          total: 1,
          unread: 0,
        },
      ]);
      return;
    }
    case "chats":
      /* Chats renders regardless and the daemon always indexes it, so it
         needs no stub. */
      return;
    case "channel":
      /* A channel bucket can be missing too: pinning a channel's only
         conversation empties it out of the index, so the unpin returning the
         row targets a section the index no longer carries. */
      queryClient.setQueryData<SidebarIndexSection[] | null>(queryKey, [
        ...index,
        { kind: "channel", channelId: bucket.channelId, total: 1, unread: 0 },
      ]);
      return;
  }
}

/**
 * The section filters that hold `conversation`, whether or not those caches
 * exist yet.
 *
 * Derived from the row's own fields, the axes the daemon aggregates on, so a
 * placement can name its destination without depending on which caches
 * happen to be resident. The membership pass below can only speak for caches
 * the query client already holds, and the destination a placement most needs
 * reconciled is the one guaranteed absent: an empty section has no index row,
 * so the sidebar never rendered it, so nothing ever mounted its query. Moving
 * a conversation into an empty group lands exactly there, and
 * {@link ensureSectionInIndex} then makes that section appear while the write
 * that fills it is still in flight, so its first fetch can answer from before
 * the move.
 *
 * An ungrouped row names two filters because the two sidebar views ask for it
 * differently: flat Chats constrains the group axis alone, while the grouped
 * view splits the same rows into per-channel sections. Naming a filter no
 * query holds costs nothing, and naming one short leaves a stale section.
 *
 * A row no section can hold names none: {@link isSidebarVisible} is the same
 * gate the sections themselves are filtered by, so an archived or private row
 * has no destination to reconcile.
 */
export function sectionFiltersHolding(
  conversation: Conversation,
): ConversationListFilter[] {
  if (!isSidebarVisible(conversation)) {
    return [];
  }
  const bucket = sectionBucketOf(conversation);
  switch (bucket.kind) {
    case "pinned":
      return [{ groupId: SYSTEM_PINNED_GROUP_ID }];
    case "group":
      return [{ groupId: bucket.groupId }];
    case "chats":
      return [
        { groupId: SYSTEM_ALL_GROUP_ID },
        {
          groupId: SYSTEM_ALL_GROUP_ID,
          originChannel: NATIVE_ORIGIN_CHANNEL,
        },
      ];
    case "channel":
      /* Flat Chats holds the channel rows too, so it is named alongside the
         channel's own section. A channel this client's schema predates
         cannot be a section at all: nothing can key a query by a value the
         daemon would reject. */
      return isOriginChannel(bucket.channelId)
        ? [
            { groupId: SYSTEM_ALL_GROUP_ID },
            {
              groupId: SYSTEM_ALL_GROUP_ID,
              originChannel: bucket.channelId,
            },
          ]
        : [{ groupId: SYSTEM_ALL_GROUP_ID }];
  }
}

export function reconcileSectionMembership(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
): readonly (readonly unknown[])[] {
  if (!assistantId) {
    return [];
  }
  const needsRefetch: (readonly unknown[])[] = [];
  /* The sections this pass walked and found the row to belong to, by key.
     Per destination rather than one flag for the row: an ungrouped row has a
     destination in each view (flat Chats and its channel section), only one
     view is mounted at a time, and the other view's caches outlive a toggle
     by their gc time. A single flag would let a stale flat Chats cache
     answer for a channel section that is not loaded, which is the failure
     this whole pass exists to prevent. */
  const claimedKeys = new Set<string>();
  const entries = queryClient.getQueriesData<ConversationListPage>({
    queryKey: conversationListPrefix(assistantId),
  });

  for (const [queryKey, page] of entries) {
    /* Only the section caches; the buckets are not membership caches. */
    const filter = conversationListFilterOf(queryKey);
    if (!filter || !isSectionFilter(filter)) {
      continue;
    }
    /* A property of the row and the filter, so it is known for an unresolved
       cache too: that section is already being asked about below, and it is
       still the section holding this row. */
    const belongs = matchesSectionFilter(conversation, filter);
    if (belongs) {
      claimedKeys.add(hashKey(queryKey));
    }
    if (!page) {
      needsRefetch.push(queryKey);
      continue;
    }
    const rows = page.conversations;

    const index = rows.findIndex(
      (c) => c.conversationId === conversation.conversationId,
    );

    if (belongs === (index !== -1)) {
      /* Membership agrees. The row is still replaced in place when it is a
         member, so a patch that changed a rendered field reaches this cache
         too. Skipped when the cache already holds this exact object, which is
         the usual case: the field patch that preceded this call put it there,
         and writing an equal array again would re-render the section for
         nothing. */
      if (belongs && rows[index] !== conversation) {
        const next = [...rows];
        next[index] = conversation;
        queryClient.setQueryData<ConversationListPage>(queryKey, {
          conversations: next,
          hasMore: page.hasMore,
        });
      }
      continue;
    }

    if (belongs) {
      /* A row past a window's last loaded row stays out of the cache
         (`insertIntoWindow` returns the page unchanged): the window is
         still a correct prefix, the row is in this section server-side,
         and load-more reaches it. Nothing changed, so there is nothing
         for a settle to reconcile either. */
      const inserted = insertIntoWindow(page, conversation);
      if (inserted === page) {
        continue;
      }
      queryClient.setQueryData<ConversationListPage>(queryKey, inserted);
    } else {
      queryClient.setQueryData<ConversationListPage>(queryKey, {
        conversations: rows.filter(
          (c) => c.conversationId !== conversation.conversationId,
        ),
        hasMore: page.hasMore,
      });
    }
    needsRefetch.push(queryKey);
  }

  /* Each destination the walk could not speak for, named from the row
     itself. A section with no cache is one nothing has rendered, and a
     section hidden while empty is exactly that, so this is the case the walk
     above is structurally unable to see. Keys named here can be for caches
     that do not exist; invalidating those is a no-op, and by the time a
     settle runs, the section the placement revealed has usually mounted
     one. */
  for (const filter of sectionFiltersHolding(conversation)) {
    const queryKey = conversationListQueryKey(assistantId, filter);
    if (!claimedKeys.has(hashKey(queryKey))) {
      needsRefetch.push(queryKey);
    }
  }

  return needsRefetch;
}
