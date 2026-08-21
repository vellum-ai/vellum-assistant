import { useEffect, useRef } from "react";

import { useUnreadConversationCount } from "@/hooks/conversation-queries";
import {
  isWidgetSnapshotSyncAvailable,
  syncWidgetSnapshot,
  WIDGET_SNAPSHOT_SCHEMA_VERSION,
  type WidgetSnapshotConversation,
  type WidgetSnapshotPayload,
} from "@/runtime/widget-snapshot";
import { useConversationStore } from "@/stores/conversation-store";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import { compareByRecency } from "@/utils/conversation-order";

/**
 * How many conversations the Home Screen widgets get. The Catch Up medium
 * widget draws three rows and nothing else reads the list, so a longer
 * payload would only cost bridge traffic and App Group space.
 */
const MAX_SNAPSHOT_CONVERSATIONS = 3;

/**
 * Mirror the conversation list into the iOS shell's `WidgetSnapshot` plugin
 * so the Home Screen widgets can draw unread and in-progress counts and the
 * three most recent chats. No-ops everywhere but Capacitor iOS.
 *
 * Mount once at a layout that already holds the conversation list (currently
 * `ChatLayout`, beside `useNativeRecentChatsSync`, its Shortcuts sibling).
 *
 * The unread count prefers the assistant's server-side count and falls back
 * to the loaded rows, the same resolution the Electron Dock badge uses, so
 * the two surfaces never disagree about the number. The count query is gated
 * on the platform and on the assistant being active: `ChatLayout` mounts
 * before the assistant finishes starting, and querying a starting assistant
 * spends the retry budget on a request that cannot succeed.
 *
 * In-progress rows come from two sources that have to be unioned, exactly as
 * the sidebar row does it: the server-seeded `isProcessing` flag, and the
 * client's own in-flight turns tracked in `processingConversationIds`. Either
 * alone under-reports, since a turn started in this session may not be
 * reflected in the list payload yet and a turn started elsewhere is only in
 * the payload.
 *
 * Syncs are deduped on the serialized snapshot with `generatedAt` excluded.
 * Including it would make every render a fresh payload and the dedup dead,
 * so the shell would take bridge traffic and a widget timeline reload on
 * every re-render of the layout.
 *
 * `listResolved` must be false until the conversation-list query has actually
 * SUCCEEDED. The query serves an `[]` fallback while pending (loading, or
 * gated on the assistant/pod) AND while in a terminal error state, and the
 * caller must exclude both (`!isPending && !isError`): a bare `!isPending`
 * lets the error case through. Without the guard, every launch would blank
 * the widgets before the first load, and a launch that never loads (offline,
 * assistant never ready, pod waking into a 503 error) would blank them for as
 * long as it lasted, despite a last-known-good snapshot sitting in the App
 * Group. An empty list from a *successful* query does sync: genuinely having
 * no conversations should empty the widgets.
 */
export function useNativeWidgetSnapshotSync(
  assistantId: string | null,
  conversations: Conversation[],
  conversationGroups: ConversationGroup[],
  isAssistantActive: boolean,
  listResolved: boolean,
): void {
  const lastPayloadRef = useRef<string | null>(null);
  const processingConversationIds =
    useConversationStore.use.processingConversationIds();

  const unreadCount = useUnreadConversationCount(
    assistantId,
    conversations,
    isWidgetSnapshotSyncAvailable() && isAssistantActive,
  );

  useEffect(() => {
    if (!isWidgetSnapshotSyncAvailable() || !listResolved) {
      return;
    }

    const isProcessing = (conversation: Conversation): boolean =>
      conversation.isProcessing === true ||
      processingConversationIds.has(conversation.conversationId);

    const groupNames = new Map(
      conversationGroups.map((group) => [group.id, group.name]),
    );
    const active = conversations.filter(
      (conversation) => conversation.archivedAt === undefined,
    );
    const inProgressCount = active.filter(isProcessing).length;
    const rows: WidgetSnapshotConversation[] = active
      .sort(compareByRecency)
      .slice(0, MAX_SNAPSHOT_CONVERSATIONS)
      .map((conversation) => ({
        id: conversation.conversationId,
        title: conversation.title ?? "Untitled",
        subtitle:
          conversation.groupId === undefined
            ? undefined
            : groupNames.get(conversation.groupId),
        lastMessageAt:
          conversation.lastMessageAt === undefined
            ? undefined
            : new Date(conversation.lastMessageAt).toISOString(),
        hasUnseen: conversation.hasUnseenLatestAssistantMessage === true,
        isProcessing: isProcessing(conversation),
      }));

    // Built without `generatedAt` so the serialized form is the dedup key.
    const content: Omit<WidgetSnapshotPayload, "generatedAt"> = {
      schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
      unreadCount,
      inProgressCount,
      conversations: rows,
    };
    const serialized = JSON.stringify(content);
    if (serialized === lastPayloadRef.current) {
      return;
    }
    lastPayloadRef.current = serialized;
    void syncWidgetSnapshot({
      ...content,
      generatedAt: new Date().toISOString(),
    });
  }, [
    conversations,
    conversationGroups,
    processingConversationIds,
    unreadCount,
    listResolved,
  ]);
}
