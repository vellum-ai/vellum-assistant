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

import type { QueryClient } from "@tanstack/react-query";

import type { Conversation } from "@/types/conversation-types";
import { groupsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { GroupsGetResponse } from "@/generated/daemon/types.gen";
import {
  NATIVE_ORIGIN_CHANNEL,
  SYSTEM_ALL_GROUP_ID,
  SYSTEM_PINNED_GROUP_ID,
  sidebarSectionsQueryKey,
  type ConversationListPage,
  type SidebarIndexSection,
} from "@/utils/conversation-list-fetchers";
import {
  type ConversationListFilter,
  conversationListFilterOf,
  conversationListPrefix,
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
 * are of two kinds:
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
 * Whether `row` is the index bucket holding `conversation`, mirroring the
 * daemon's aggregation axes: the group axis wins (pinned, then a custom
 * group), then the effective origin channel with NULL reading as native
 * (the Chats bucket). The one bucket rule, shared by the stub insertion
 * here and the unread deltas in `conversation-cache-mutations.ts`.
 */
export function matchesIndexBucket(
  conversation: Conversation,
  row: SidebarIndexSection,
): boolean {
  if (isConversationPinned(conversation)) {
    return row.kind === "pinned";
  }
  if (isCustomGroupId(conversation.groupId)) {
    return row.kind === "group" && row.groupId === conversation.groupId;
  }
  const channel = conversation.originChannel;
  if (channel == null || channel === NATIVE_ORIGIN_CHANNEL) {
    return row.kind === "chats";
  }
  return row.kind === "channel" && row.channelId === channel;
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

  if (isConversationPinned(conversation)) {
    queryClient.setQueryData<SidebarIndexSection[] | null>(queryKey, [
      { kind: "pinned", total: 1, unread: 0 },
      ...index,
    ]);
    return;
  }

  const groupId = conversation.groupId;
  if (isCustomGroupId(groupId)) {
    const groups = queryClient.getQueryData<GroupsGetResponse>(
      groupsGetQueryKey({ path: { assistant_id: assistantId } }),
    )?.groups;
    const meta = groups?.find((g) => g.id === groupId);
    if (!meta) {
      return;
    }
    queryClient.setQueryData<SidebarIndexSection[] | null>(queryKey, [
      ...index,
      {
        kind: "group",
        groupId,
        name: meta.name,
        icon: meta.icon ?? null,
        sortPosition: meta.sortPosition ?? 0,
        total: 1,
        unread: 0,
      },
    ]);
    return;
  }

  /* An ungrouped row's destination is its channel section, and that bucket
     can be missing too: pinning a channel's only conversation empties its
     bucket out of the index, so the unpin returning the row targets a
     section the index no longer carries. The native bucket needs no stub;
     Chats renders regardless and the daemon always indexes it. */
  const channel = conversation.originChannel;
  if (channel == null || channel === NATIVE_ORIGIN_CHANNEL) {
    return;
  }
  queryClient.setQueryData<SidebarIndexSection[] | null>(queryKey, [
    ...index,
    { kind: "channel", channelId: channel, total: 1, unread: 0 },
  ]);
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
  const entries = queryClient.getQueriesData<ConversationListPage>({
    queryKey: conversationListPrefix(assistantId),
  });

  for (const [queryKey, page] of entries) {
    /* Only the section caches; the buckets are not membership caches. */
    const filter = conversationListFilterOf(queryKey);
    if (!filter || !isSectionFilter(filter)) {
      continue;
    }
    if (!page) {
      needsRefetch.push(queryKey);
      continue;
    }
    const rows = page.conversations;

    const index = rows.findIndex(
      (c) => c.conversationId === conversation.conversationId,
    );
    const belongs = matchesSectionFilter(conversation, filter);

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

  return needsRefetch;
}
