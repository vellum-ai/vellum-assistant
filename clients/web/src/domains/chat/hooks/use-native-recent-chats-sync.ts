import { useEffect, useRef } from "react";

import {
  isRecentChatsSyncAvailable,
  syncRecentChats,
  type RecentChatSyncEntry,
} from "@/runtime/recent-chats";
import type { Conversation } from "@/types/conversation-types";
import { compareByRecency } from "@/utils/conversation-order";

/**
 * How many conversations the native cache gets. The Shortcuts picker is a
 * "recent chats" surface, not a search index: 50 covers any plausible pick
 * while keeping the bridge payload and the UserDefaults blob small.
 */
const MAX_SYNCED_CHATS = 50;

/**
 * Mirror the sidebar conversation list into the iOS shell's `RecentChats`
 * plugin so the Shortcuts app's chat picker (the "Send Message to Chat"
 * action, LUM-3230) has the user's chats to offer.
 *
 * Mount once at a layout that already holds the conversation list (currently
 * `ChatLayout`, beside `useElectronDockSync`, its Electron sibling). No-ops
 * everywhere but Capacitor iOS.
 *
 * Syncs are deduped on the serialized payload, so re-renders and refetches
 * that change nothing the picker can see cost no bridge traffic. Archived
 * conversations are excluded to match the sidebar; titleless ones get the
 * sidebar's own "Untitled" fallback so every picker row has a label.
 *
 * `listResolved` must be false until the conversation-list query has actually
 * SUCCEEDED. The query serves an `[]` fallback while pending (loading, or
 * gated on the assistant/pod) AND while in a terminal error state, and the
 * caller must exclude both (`!isPending && !isError`): a bare `!isPending`
 * lets the error case through. Without the guard, every launch would wipe
 * the native cache before the first load, and a launch that never loads
 * (offline, assistant never ready, pod waking into a 503 error) would wipe it
 * permanently, leaving the Shortcuts picker empty despite a last-known-good
 * cache. An empty list from a *successful* query does sync: genuinely having
 * no conversations should clear the picker.
 */
export function useNativeRecentChatsSync(
  conversations: Conversation[],
  listResolved: boolean,
): void {
  const lastPayloadRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isRecentChatsSyncAvailable() || !listResolved) {
      return;
    }
    const chats: RecentChatSyncEntry[] = conversations
      .filter((conversation) => conversation.archivedAt === undefined)
      .sort(compareByRecency)
      .slice(0, MAX_SYNCED_CHATS)
      .map((conversation) => ({
        id: conversation.conversationId,
        title: conversation.title ?? "Untitled",
      }));
    const serialized = JSON.stringify(chats);
    if (serialized === lastPayloadRef.current) {
      return;
    }
    lastPayloadRef.current = serialized;
    void syncRecentChats(chats);
  }, [conversations, listResolved]);
}
