/**
 * Cache mutation helpers for conversation groups (folders).
 *
 * Thin wrappers over the generated `groupsGetSetQueryData` helper so call
 * sites stay declarative. Conversation-level cache mutations live in
 * `@/utils/conversation-cache-mutations`.
 *
 * References:
 * - https://tanstack.com/query/latest/docs/framework/react/guides/updates-from-mutation-responses
 */

import type { QueryClient } from "@tanstack/react-query";

import type { GroupsGetData } from "@/generated/daemon/types.gen";
import { groupsGetSetQueryData } from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type { Conversation, ConversationGroup } from "@/types/conversation-types";
import { updateAllConversationCaches } from "@/utils/conversation-cache";

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function updateGroupsCache(
  queryClient: QueryClient,
  assistantId: string | null,
  updater: (groups: ConversationGroup[]) => ConversationGroup[],
): void {
  const opts: Options<GroupsGetData> = { path: { assistant_id: assistantId ?? "" } };
  groupsGetSetQueryData(queryClient, opts, (prev) => {
    const list = prev?.groups ?? [];
    const next = updater(list);
    if (next === list) return prev;
    return { ...prev, groups: next };
  });
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

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
