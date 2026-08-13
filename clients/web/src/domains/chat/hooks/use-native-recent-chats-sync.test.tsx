/**
 * Covers the native recent-chats sync contract, most importantly the
 * `listResolved` guard: the conversation-list query serves an `[]` fallback
 * while loading/gated/errored, and syncing that would wipe the iOS shell's
 * last-known-good Shortcuts picker cache on every launch (permanently, on a
 * launch that never loads). An empty list from a *resolved* query must still
 * sync: genuinely having no conversations should clear the picker.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import type { Conversation } from "@/types/conversation-types";

const syncRecentChatsMock = mock(async (_chats: unknown) => {});
let syncAvailable = true;
// Full module surface: `mock.module` is process-global in bun, so a partial
// shape would shadow the other export for later test files in the run.
mock.module("@/runtime/recent-chats", () => ({
  isRecentChatsSyncAvailable: () => syncAvailable,
  syncRecentChats: syncRecentChatsMock,
}));

import { useNativeRecentChatsSync } from "@/domains/chat/hooks/use-native-recent-chats-sync";

beforeEach(() => {
  syncAvailable = true;
  syncRecentChatsMock.mockClear();
});
afterEach(() => cleanup());

function conversation(id: string, title?: string): Conversation {
  return { conversationId: id, title, lastMessageAt: Date.parse("2026-08-01") };
}

describe("useNativeRecentChatsSync", () => {
  it("does not sync the pre-load [] fallback, then syncs once the list resolves", () => {
    const { rerender } = renderHook(
      ({ conversations, listResolved }) =>
        useNativeRecentChatsSync(conversations, listResolved),
      {
        initialProps: {
          conversations: [] as Conversation[],
          listResolved: false,
        },
      },
    );
    // An unresolved [] must never reach the shell: it would wipe the
    // last-known-good picker cache.
    expect(syncRecentChatsMock).not.toHaveBeenCalled();

    rerender({
      conversations: [conversation("c1", "Groceries")],
      listResolved: true,
    });
    expect(syncRecentChatsMock).toHaveBeenCalledTimes(1);
    expect(syncRecentChatsMock).toHaveBeenLastCalledWith([
      { id: "c1", title: "Groceries" },
    ]);
  });

  it("syncs an empty list once resolved: no conversations should clear the picker", () => {
    renderHook(
      ({ conversations, listResolved }) =>
        useNativeRecentChatsSync(conversations, listResolved),
      {
        initialProps: {
          conversations: [] as Conversation[],
          listResolved: true,
        },
      },
    );
    expect(syncRecentChatsMock).toHaveBeenCalledTimes(1);
    expect(syncRecentChatsMock).toHaveBeenLastCalledWith([]);
  });

  it("dedupes identical payloads across re-renders", () => {
    const props = {
      conversations: [conversation("c1", "Groceries")],
      listResolved: true,
    };
    const { rerender } = renderHook(
      ({ conversations, listResolved }) =>
        useNativeRecentChatsSync(conversations, listResolved),
      { initialProps: props },
    );
    rerender({
      conversations: [conversation("c1", "Groceries")],
      listResolved: true,
    });
    expect(syncRecentChatsMock).toHaveBeenCalledTimes(1);
  });

  it("excludes archived conversations and labels titleless ones Untitled", () => {
    renderHook(
      ({ conversations, listResolved }) =>
        useNativeRecentChatsSync(conversations, listResolved),
      {
        initialProps: {
          conversations: [
            { ...conversation("c-archived", "Old"), archivedAt: 1 },
            conversation("c-untitled"),
          ],
          listResolved: true,
        },
      },
    );
    expect(syncRecentChatsMock).toHaveBeenLastCalledWith([
      { id: "c-untitled", title: "Untitled" },
    ]);
  });

  it("is a no-op off Capacitor iOS", () => {
    syncAvailable = false;
    renderHook(
      ({ conversations, listResolved }) =>
        useNativeRecentChatsSync(conversations, listResolved),
      {
        initialProps: {
          conversations: [conversation("c1", "Groceries")],
          listResolved: true,
        },
      },
    );
    expect(syncRecentChatsMock).not.toHaveBeenCalled();
  });
});
