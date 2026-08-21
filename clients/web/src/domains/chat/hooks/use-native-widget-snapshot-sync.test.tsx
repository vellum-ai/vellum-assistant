/**
 * Covers the iOS widget-snapshot contract: the `listResolved` guard, the
 * payload the Home Screen widgets read, and the dedup that keeps a re-render
 * from costing bridge traffic and a widget timeline reload.
 *
 * The guard is the same one the recent-chats sync carries: the
 * conversation-list query serves an `[]` fallback while loading, gated, or
 * errored, and syncing that would blank the widgets on every launch, and for
 * as long as the failure lasted on a launch that never loads. An empty list
 * from a *successful* query must still sync: genuinely having no
 * conversations should empty the widgets.
 *
 * `generatedAt` is deliberately outside the dedup key. It changes on every
 * render by construction, so including it would leave the dedup dead.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import type { WidgetSnapshotPayload } from "@/runtime/widget-snapshot";
import * as listFetchers from "@/utils/conversation-list-fetchers";

// Nothing in this file should reach the network: the count endpoint stands in
// as a request that never settles, so every case reads the derived fallback.
mock.module("@/utils/conversation-list-fetchers", () => ({
  ...listFetchers,
  fetchUnreadConversationCount: () => new Promise(() => {}),
}));

const syncedSnapshots: WidgetSnapshotPayload[] = [];
let syncAvailable = true;

// Full module surface: `mock.module` is process-global in bun, so a partial
// shape would shadow the other exports for later test files in the run.
mock.module("@/runtime/widget-snapshot", () => ({
  WIDGET_SNAPSHOT_SCHEMA_VERSION: 1,
  isWidgetSnapshotSyncAvailable: () => syncAvailable,
  syncWidgetSnapshot: async (snapshot: WidgetSnapshotPayload) => {
    syncedSnapshots.push(snapshot);
  },
  clearWidgetSnapshot: async () => {},
}));

const { useConversationStore } = await import("@/stores/conversation-store");
const { useNativeWidgetSnapshotSync } =
  await import("@/domains/chat/hooks/use-native-widget-snapshot-sync");

const ASSISTANT_ID = "asst-1";
const NO_GROUPS: ConversationGroup[] = [];

function conversation(
  conversationId: string,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    conversationId,
    title: conversationId,
    lastMessageAt: Date.parse("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

function group(id: string, name: string): ConversationGroup {
  return { id, name, sortPosition: 0, isSystemGroup: false };
}

interface Props {
  conversations: Conversation[];
  conversationGroups: ConversationGroup[];
  listResolved: boolean;
}

function render(initialProps: Props) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(
    (props: Props) =>
      useNativeWidgetSnapshotSync(
        ASSISTANT_ID,
        props.conversations,
        props.conversationGroups,
        true,
        props.listResolved,
      ),
    {
      initialProps,
      wrapper: ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children),
    },
  );
}

beforeEach(() => {
  syncedSnapshots.length = 0;
  syncAvailable = true;
  useConversationStore.setState({ processingConversationIds: new Set() });
});

afterEach(() => {
  cleanup();
  setSystemTime();
});

describe("useNativeWidgetSnapshotSync", () => {
  it("does not sync the pre-load [] fallback, then syncs once the list resolves", () => {
    const { rerender } = render({
      conversations: [],
      conversationGroups: NO_GROUPS,
      listResolved: false,
    });
    expect(syncedSnapshots).toHaveLength(0);

    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      listResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.conversations).toHaveLength(1);
  });

  it("a list that un-resolves after syncing does not blank the widgets", () => {
    const { rerender } = render({
      conversations: [conversation("c1")],
      conversationGroups: NO_GROUPS,
      listResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    // The query fell into a terminal error: the caller reports unresolved and
    // the list is the `[]` fallback again.
    rerender({
      conversations: [],
      conversationGroups: NO_GROUPS,
      listResolved: false,
    });
    expect(syncedSnapshots).toHaveLength(1);
  });

  it("syncs the three most recent rows with group names, unseen and processing state", () => {
    useConversationStore.setState({
      processingConversationIds: new Set(["c-client-turn"]),
    });
    render({
      conversations: [
        conversation("c-old", {
          title: "Oldest",
          lastMessageAt: Date.parse("2026-07-01T00:00:00Z"),
        }),
        conversation("c-archived", {
          lastMessageAt: Date.parse("2026-08-05T00:00:00Z"),
          archivedAt: Date.parse("2026-08-05T00:00:00Z"),
        }),
        conversation("c-client-turn", {
          title: "Client turn",
          lastMessageAt: Date.parse("2026-08-04T00:00:00Z"),
        }),
        conversation("c-server-turn", {
          title: "Server turn",
          lastMessageAt: Date.parse("2026-08-03T00:00:00Z"),
          isProcessing: true,
          groupId: "g1",
        }),
        conversation("c-unseen", {
          title: undefined,
          lastMessageAt: Date.parse("2026-08-02T00:00:00Z"),
          hasUnseenLatestAssistantMessage: true,
          groupId: "g-missing",
        }),
      ],
      conversationGroups: [group("g1", "Errands")],
      listResolved: true,
    });

    expect(syncedSnapshots).toHaveLength(1);
    const snapshot = syncedSnapshots[0];
    expect(snapshot?.schemaVersion).toBe(1);
    expect(snapshot?.unreadCount).toBe(1);
    // Both processing sources count, and the archived row is excluded from
    // the count as well as from the rows.
    expect(snapshot?.inProgressCount).toBe(2);
    expect(snapshot?.conversations).toEqual([
      {
        id: "c-client-turn",
        title: "Client turn",
        subtitle: undefined,
        lastMessageAt: "2026-08-04T00:00:00.000Z",
        hasUnseen: false,
        isProcessing: true,
      },
      {
        id: "c-server-turn",
        title: "Server turn",
        subtitle: "Errands",
        lastMessageAt: "2026-08-03T00:00:00.000Z",
        hasUnseen: false,
        isProcessing: true,
      },
      {
        id: "c-unseen",
        title: "Untitled",
        subtitle: undefined,
        lastMessageAt: "2026-08-02T00:00:00.000Z",
        hasUnseen: true,
        isProcessing: false,
      },
    ]);
  });

  it("syncs an empty snapshot once an empty list resolves", () => {
    render({
      conversations: [],
      conversationGroups: NO_GROUPS,
      listResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]).toMatchObject({
      unreadCount: 0,
      inProgressCount: 0,
      conversations: [],
    });
  });

  it("dedupes identical data across re-renders, ignoring the moving generatedAt", () => {
    setSystemTime(new Date("2026-08-21T16:00:00Z"));
    const { rerender } = render({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      listResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);
    expect(syncedSnapshots[0]?.generatedAt).toBe("2026-08-21T16:00:00.000Z");

    // A later render of the same data would carry a different `generatedAt`.
    // The dedup key excludes it, so nothing reaches the bridge.
    setSystemTime(new Date("2026-08-21T16:05:00Z"));
    rerender({
      conversations: [conversation("c1", { title: "Groceries" })],
      conversationGroups: NO_GROUPS,
      listResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(1);

    // A real change still gets through.
    rerender({
      conversations: [conversation("c1", { title: "Groceries and dinner" })],
      conversationGroups: NO_GROUPS,
      listResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(2);
    expect(syncedSnapshots[1]?.generatedAt).toBe("2026-08-21T16:05:00.000Z");
  });

  it("is a no-op off Capacitor iOS", () => {
    syncAvailable = false;
    render({
      conversations: [conversation("c1")],
      conversationGroups: NO_GROUPS,
      listResolved: true,
    });
    expect(syncedSnapshots).toHaveLength(0);
  });
});
