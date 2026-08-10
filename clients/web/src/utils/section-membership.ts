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
import {
  NATIVE_ORIGIN_CHANNEL,
  SYSTEM_ALL_GROUP_ID,
  SYSTEM_PINNED_GROUP_ID,
  parseSectionConversationsQueryKey,
  sectionListPrefix,
  type SectionConversationFilter,
} from "@/utils/conversation-list-fetchers";
import { insertByRecency } from "@/utils/conversation-order";
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
function isSidebarVisible(conversation: Conversation): boolean {
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
  filter: SectionConversationFilter,
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
export function reconcileSectionMembership(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
): readonly (readonly unknown[])[] {
  if (!assistantId) {
    return [];
  }
  const needsRefetch: (readonly unknown[])[] = [];
  const entries = queryClient.getQueriesData<Conversation[]>({
    queryKey: sectionListPrefix(assistantId),
  });

  for (const [queryKey, rows] of entries) {
    const filter = parseSectionConversationsQueryKey(queryKey);
    if (!filter) {
      continue;
    }
    if (!rows) {
      needsRefetch.push(queryKey);
      continue;
    }

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
        queryClient.setQueryData<Conversation[]>(queryKey, next);
      }
      continue;
    }

    queryClient.setQueryData<Conversation[]>(
      queryKey,
      belongs
        ? insertByRecency(rows, conversation)
        : rows.filter((c) => c.conversationId !== conversation.conversationId),
    );
    needsRefetch.push(queryKey);
  }

  return needsRefetch;
}
