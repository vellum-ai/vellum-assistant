import { useEffect, useRef } from "react";

import { useUnreadConversationCount } from "@/hooks/conversation-queries";
import {
  clearWidgetSnapshot,
  isWidgetSnapshotSyncAvailable,
  readWidgetSnapshotAssistantId,
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
import { activeConversationsByRecency } from "@/utils/conversation-order";

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
 *
 * That preservation is scoped to ONE assistant. A snapshot describes the
 * assistant it was built from, so an in-SPA switch
 * (`switchToResolvedAssistant`) invalidates it outright: the new assistant's
 * list starts unresolved, and preserving across the switch would leave the
 * previous assistant's titles, counts and conversation targets on a Home
 * Screen that never reloads on its own, indefinitely if the new assistant
 * never comes up. So the hook tracks which assistant produced the snapshot it
 * last wrote and drops it as soon as that id changes.
 *
 * An in-memory ref alone cannot answer that on a cold launch: the App Group
 * snapshot outlives the page, so a run that starts on a different assistant
 * begins with the ref null and would preserve another assistant's titles for
 * as long as its own list stayed unresolved. The producer id is therefore
 * also persisted next to the snapshot (`readWidgetSnapshotAssistantId`), and
 * read once per launch to seed that ref. A launch with no recorded producer,
 * or one recorded for the assistant now active, is not a switch and keeps the
 * preservation.
 *
 * The read seeds the ref rather than a per-render local because a launch on
 * the recorded producer may never resolve its own list, and so may never write
 * the ref itself. Held only for the render that read it, a later switch away
 * would find no known owner and leave that producer's titles on the Home
 * Screen indefinitely.
 */
export function useNativeWidgetSnapshotSync(
  assistantId: string | null,
  conversations: Conversation[],
  conversationGroups: ConversationGroup[],
  isAssistantActive: boolean,
  listResolved: boolean,
): void {
  const lastPayloadRef = useRef<string | null>(null);
  // The assistant the snapshot in the App Group was built from: whatever this
  // hook last wrote, or the producer read back from storage on a cold launch.
  // Null while no producer is known, which is what keeps a launch from reading
  // as a switch.
  const syncedAssistantIdRef = useRef<string | null>(null);
  // Whether the persisted producer id has been consulted. It only answers for
  // a snapshot this page lifetime did not write, so one read per launch is
  // enough and the ref is authoritative from then on.
  const readPersistedOwnerRef = useRef(false);
  const processingConversationIds =
    useConversationStore.use.processingConversationIds();

  const unreadCount = useUnreadConversationCount(
    assistantId,
    conversations,
    isWidgetSnapshotSyncAvailable() && isAssistantActive,
  );

  useEffect(() => {
    if (!isWidgetSnapshotSyncAvailable()) {
      return;
    }

    // Checked ahead of the `listResolved` guard, which would otherwise hold
    // the previous assistant's snapshot for the whole time the new one takes
    // to resolve. Dropping the dedup key too, so the new assistant's first
    // resolved list always reaches the bridge even when it happens to
    // serialize identically to what the previous one last wrote.
    //
    // On a cold launch the ref is null while a snapshot from a previous run
    // may still be on the Home Screen, so its producer comes from storage and
    // seeds the ref. Deferred until the active assistant is known, so a launch
    // that has not resolved one yet is never mistaken for a switch. Seeding
    // rather than reading into a local is what keeps the owner detectable when
    // the launch assistant's own list never resolves and never writes the ref.
    if (!readPersistedOwnerRef.current && assistantId !== null) {
      readPersistedOwnerRef.current = true;
      syncedAssistantIdRef.current = readWidgetSnapshotAssistantId();
    }
    const snapshotOwnerId = syncedAssistantIdRef.current;
    const switchedAssistant =
      snapshotOwnerId !== null && snapshotOwnerId !== assistantId;
    if (switchedAssistant) {
      syncedAssistantIdRef.current = null;
      lastPayloadRef.current = null;
    }

    if (!listResolved) {
      // Only on a switch: a pending or errored query for the SAME assistant
      // still keeps its last-known-good snapshot.
      if (switchedAssistant) {
        void clearWidgetSnapshot();
      }
      return;
    }

    const isProcessing = (conversation: Conversation): boolean =>
      conversation.isProcessing === true ||
      processingConversationIds.has(conversation.conversationId);

    const groupNames = new Map(
      conversationGroups.map((group) => [group.id, group.name]),
    );
    const active = activeConversationsByRecency(conversations);
    const inProgressCount = active.filter(isProcessing).length;
    const rows: WidgetSnapshotConversation[] = active
      .slice(0, MAX_SNAPSHOT_CONVERSATIONS)
      .map((conversation) => ({
        id: conversation.conversationId,
        title: conversation.title ?? "Untitled",
        subtitle:
          conversation.groupId === undefined
            ? undefined
            : groupNames.get(conversation.groupId),
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
    syncedAssistantIdRef.current = assistantId;
    void syncWidgetSnapshot(
      {
        ...content,
        generatedAt: new Date().toISOString(),
      },
      assistantId,
    );
  }, [
    assistantId,
    conversations,
    conversationGroups,
    processingConversationIds,
    unreadCount,
    listResolved,
  ]);
}
