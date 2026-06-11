/**
 * Domain-level cache mutation helpers for conversations and groups.
 *
 * Each function is a thin `queryClient.setQueryData` wrapper so call sites
 * stay declarative. Low-level cache primitives (`updateConversationsCache`,
 * `findConversation`, `patchConversation`) live in `@/utils/conversation-cache`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import type { QueryClient } from "@tanstack/react-query";

import type { GroupsGetResponse } from "@/generated/daemon/types.gen";
import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import {
  isBackgroundConversation,
  isScheduledConversation,
} from "@/utils/conversation-predicates";
import {
  findConversation,
  updateAllConversationCaches,
  updateBackgroundConversationsCache,
  updateConversationsCache,
  updateScheduledConversationsCache,
} from "@/utils/conversation-cache";
import {
  CONVERSATION_NOT_FOUND,
  fetchConversationDetail,
} from "@/utils/fetch-conversation-detail";
import { conversationGroupsQueryKey } from "@/lib/sync/query-tags";

// ---------------------------------------------------------------------------
// Conversation cache helpers
// ---------------------------------------------------------------------------

/**
 * Mark the conversation as seen in the local cache. The matching server
 * call (`markConversationSeen` in `chat/api/conversations.ts`) is fired
 * separately by callers — keep them independent so the cache update can
 * run regardless of network success.
 */
export function markConversationSeenLocal(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
  lastSeenAssistantMessageAt?: number,
): void {
  const markSeen = (conversations: Conversation[]) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== key) {
        return c;
      }
      changed = true;
      return {
        ...c,
        hasUnseenLatestAssistantMessage: false,
        lastSeenAssistantMessageAt:
          lastSeenAssistantMessageAt ??
          c.latestAssistantMessageAt ??
          c.lastSeenAssistantMessageAt,
      };
    });
    return changed ? next : conversations;
  };
  updateAllConversationCaches(queryClient, assistantId, markSeen);
}

export function prependConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
): void {
  updateConversationsCache(queryClient, assistantId, (conversations) => [
    conversation,
    ...conversations,
  ]);
}

export function removeConversation(
  queryClient: QueryClient,
  assistantId: string | null,
  key: string,
): void {
  const drop = (conversations: Conversation[]) => {
    const filtered = conversations.filter((c) => c.conversationId !== key);
    return filtered.length === conversations.length ? conversations : filtered;
  };
  updateAllConversationCaches(queryClient, assistantId, drop);
}

export function shouldSurfaceConversationOnUserSend(
  conversation: Conversation,
): boolean {
  if (conversation.archivedAt != null) return false;
  if (conversation.surfacedAt != null) return false;
  if (conversation.isPinned === true || conversation.groupId === "system:pinned") {
    return false;
  }
  if (conversation.groupId && !conversation.groupId.startsWith("system:")) {
    return false;
  }
  return (
    isScheduledConversation(conversation) ||
    isBackgroundConversation(conversation)
  );
}

export function surfaceConversationInCaches(
  queryClient: QueryClient,
  assistantId: string | null,
  conversation: Conversation,
  surfacedAt: number,
  lastMessageAt = Date.now(),
): void {
  const surfacedConversation: Conversation = {
    ...conversation,
    groupId: "system:all",
    surfacedAt,
    lastMessageAt: Math.max(conversation.lastMessageAt ?? 0, lastMessageAt),
  };

  updateAllConversationCaches(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== conversation.conversationId) {
        return c;
      }
      changed = true;
      return surfacedConversation;
    });
    return changed ? next : conversations;
  });

  updateConversationsCache(queryClient, assistantId, (conversations) => [
    surfacedConversation,
    ...conversations.filter(
      (c) => c.conversationId !== conversation.conversationId,
    ),
  ]);
}

/**
 * Refresh a single conversation row in the cached sidebar list by
 * fetching `GET /v1/conversations/:id` and patching the cache in place.
 *
 * Drives the per-conversation `sync_changed` metadata-tag handler in
 * `use-conversation-sync.ts`: when the assistant emits a
 * `conversation:<id>:metadata` invalidation for a content-only change
 * (seen state, title, attention cursor), the consumer GETs that single
 * row instead of refetching the full paginated list — a single request
 * per signal instead of the legacy ~14-request drain at a few hundred
 * conversations.
 *
 * Behavior:
 * - Row present and server returns a payload: replace the cached row
 *   with the server copy (shape is identical — both ends serialize via
 *   `serializeConversationSummary`).
 * - Row absent from cache but server returns a payload: append; the
 *   row will sort into place on the next list refetch.
 * - Server returns 404 (`CONVERSATION_NOT_FOUND`): remove the row from
 *   the cache. Mirrors how `deleteConversation` cleans up after a local
 *   deletion.
 * - Network / other errors: rethrown to the caller so the SSE consumer
 *   can log/sentry-capture without silently dropping the signal.
 */
export async function refreshConversationRow(
  queryClient: QueryClient,
  assistantId: string | null,
  conversationId: string,
): Promise<void> {
  if (!assistantId) return;
  const result = await fetchConversationDetail(assistantId, conversationId);
  if (result === CONVERSATION_NOT_FOUND) {
    removeConversation(queryClient, assistantId, conversationId);
    return;
  }

  // Replace the row in whichever cache already holds it. Only when it lives
  // in neither do we append, routing the new row to the cache that matches
  // its type so a background job never lands in the foreground list.
  const replaceMatching = (conversations: Conversation[]) => {
    let replaced = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== result.conversationId) {
        return c;
      }
      replaced = true;
      return result;
    });
    return replaced ? next : conversations;
  };

  const existing = findConversation(queryClient, assistantId, conversationId);
  if (existing) {
    updateAllConversationCaches(queryClient, assistantId, replaceMatching);
    return;
  }

  if (isScheduledConversation(result)) {
    updateScheduledConversationsCache(queryClient, assistantId, (conversations) => [
      ...conversations,
      result,
    ]);
    return;
  }
  if (isBackgroundConversation(result)) {
    updateBackgroundConversationsCache(queryClient, assistantId, (conversations) => [
      ...conversations,
      result,
    ]);
    return;
  }
  updateConversationsCache(queryClient, assistantId, (conversations) => [
    ...conversations,
    result,
  ]);
}

export function resolveDraftKey(
  queryClient: QueryClient,
  assistantId: string | null,
  oldKey: string,
  newKey: string,
): void {
  updateConversationsCache(queryClient, assistantId, (conversations) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.conversationId !== oldKey) return c;
      changed = true;
      return { ...c, conversationId: newKey, draft: false };
    });
    return changed ? next : conversations;
  });
}

// ---------------------------------------------------------------------------
// Group cache helpers
// ---------------------------------------------------------------------------

function updateGroupsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: (groups: ConversationGroup[]) => ConversationGroup[],
): void {
  queryClient.setQueryData<GroupsGetResponse>(
    conversationGroupsQueryKey(assistantId),
    (prev) => {
      const list = prev?.groups ?? [];
      const next = updater(list);
      if (next === list) return prev;
      return { ...prev, groups: next };
    },
  );
}

export function appendGroup(
  queryClient: QueryClient,
  assistantId: string | null,
  group: ConversationGroup,
): void {
  updateGroupsCache(queryClient, assistantId, (groups) => [
    ...groups,
    {
      ...group,
      sortPosition: group.sortPosition ?? groups.length,
    },
  ]);
}

export function patchGroup(
  queryClient: QueryClient,
  assistantId: string | null,
  groupId: string,
  patch: Partial<ConversationGroup>,
): void {
  updateGroupsCache(queryClient, assistantId, (groups) => {
    let changed = false;
    const next = groups.map((g) => {
      if (g.id !== groupId) return g;
      changed = true;
      return { ...g, ...patch };
    });
    return changed ? next : groups;
  });
}

export function replaceOptimisticGroup(
  queryClient: QueryClient,
  assistantId: string | null,
  optimisticId: string,
  group: ConversationGroup,
): void {
  updateGroupsCache(queryClient, assistantId, (groups) => {
    let changed = false;
    const next = groups.map((g) => {
      if (g.id !== optimisticId) return g;
      changed = true;
      return group;
    });
    return changed ? next : groups;
  });
}

export function removeGroup(
  queryClient: QueryClient,
  assistantId: string | null,
  groupId: string,
): void {
  updateGroupsCache(queryClient, assistantId, (groups) => {
    const filtered = groups.filter((g) => g.id !== groupId);
    return filtered.length === groups.length ? groups : filtered;
  });
}

/**
 * Atomically delete a group and clear its `groupId` from every affected
 * conversation in the conversations cache.
 */
export function deleteGroupAndResetConversations(
  queryClient: QueryClient,
  assistantId: string | null,
  groupId: string,
): void {
  removeGroup(queryClient, assistantId, groupId);
  const clearGroupId = (conversations: Conversation[]) => {
    let changed = false;
    const next = conversations.map((c) => {
      if (c.groupId !== groupId) {
        return c;
      }
      changed = true;
      return { ...c, groupId: undefined };
    });
    return changed ? next : conversations;
  };
  updateAllConversationCaches(queryClient, assistantId, clearGroupId);
}
