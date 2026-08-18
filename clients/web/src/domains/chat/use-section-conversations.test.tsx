/**
 * The rules that decide whether a section renders its own fetched rows or the
 * rows derived from the foreground page.
 *
 * The gate and the fallback live with the query, which is here, so this is
 * where they are covered.
 */

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import type * as ConversationQueries from "@/hooks/conversation-queries";
import type * as ListFetchers from "@/utils/conversation-list-fetchers";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import type { Conversation } from "@/types/conversation-types";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import {
  type ConversationListFilter,
  conversationListQueryKey,
} from "@/utils/conversation-list-keys";
import { listPage } from "@/utils/conversation-list.test-helper";

/** What the section query answers with, per test. */
let serverRows: Conversation[] = [];
let serverPending = false;
let serverErrored = false;
/**
 * Whether the query is holding data from an earlier success. Mirrors React
 * Query, which keeps the last successful data when a refetch fails, so
 * `serverErrored` and `serverHasData` are independent on purpose.
 */
let serverHasData = true;
/** Whether the query reports rows past the window (LUM-2444). */
let serverHasMore = false;
/** Filters the hook actually sent, so tests can assert the query is scoped. */
let sentFilters: Array<ConversationListFilter | null> = [];
/** Whether the query was enabled, so a closed gate is distinguishable. */
let lastEnabled = false;
/** Filters the bulk-path drain was asked for, and what it answers. */
let drainCalls: Array<{ groupId?: string; originChannel?: string }> = [];
let drainRows: Conversation[] = [];

/* Typed against the real module, so a stub that stops matching the hook it
   replaces fails the build instead of the test suite passing for the wrong
   reason. `hasData` is the case in point: unstubbed it reads `undefined`,
   every section falls back to its derived rows, and these tests would go
   green because nothing is filtered rather than because it is. */
mock.module(
  "@/hooks/conversation-queries",
  (): Partial<typeof ConversationQueries> => ({
    useSectionConversationListQuery: (_assistantId, filter, enabled = true) => {
      sentFilters.push(filter);
      lastEnabled = enabled;
      return {
        conversations: enabled && serverHasData ? serverRows : [],
        isLoading: serverPending,
        isPending: serverPending,
        isError: serverErrored,
        error: serverErrored ? new Error("section query failed") : null,
        hasData: enabled && serverHasData && !serverPending,
        hasMore: enabled && serverHasData ? serverHasMore : false,
        refetch: () => {},
      };
    },
  }),
);

const actualFetchers = await import("@/utils/conversation-list-fetchers");
mock.module("@/utils/conversation-list-fetchers", (): typeof ListFetchers => ({
  ...actualFetchers,
  drainConversationList: async (_assistantId, filter = {}) => {
    drainCalls.push(filter);
    return drainRows;
  },
}));

/* Chats consults a second, later gate. Left at the real implementation so
   these tests exercise the same version comparison the app does; the identity
   store seeded per test is what opens or closes both. */
mock.module("@/assistant/lifecycle-store", () => ({
  useAssistantLifecycleStore: (selector: (s: unknown) => unknown) =>
    selector({ assistantState: { kind: "active" } }),
}));

const { useSectionConversations } =
  await import("@/domains/chat/use-section-conversations");

/* The hook reads the query client for load-more and the bulk-path drain, so
   every render gets a fresh one; tests that seed the section cache reach it
   through this handle. */
let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}
function renderSection(section: SidebarSection, assistantId = "asst-1") {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderHook(() => useSectionConversations(assistantId, section), {
    wrapper,
  });
}

function conv(conversationId: string): Conversation {
  return { conversationId, hasUnseenLatestAssistantMessage: false };
}

const DERIVED = [conv("derived-1")];
const FROM_SERVER = [conv("server-1"), conv("server-2")];

function pinnedSection(all: Conversation[] = DERIVED): SidebarSection {
  return { type: "pinned", key: "pinned", label: "Pinned", all };
}

function groupSection(all: Conversation[] = DERIVED): SidebarSection {
  return {
    type: "group",
    key: "grp-work",
    label: "Work",
    all,
    group: { id: "grp-work", name: "Work", icon: null, conversations: all },
  };
}

function openGate() {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", "0.12.0", "asst-1");
}

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
  serverRows = [];
  serverPending = false;
  serverErrored = false;
  serverHasData = true;
  serverHasMore = false;
  sentFilters = [];
  lastEnabled = false;
  drainCalls = [];
  drainRows = [];
});

describe("useSectionConversations", () => {
  test("renders the section's own rows once the query answers", () => {
    openGate();
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "server-1",
      "server-2",
    ]);
  });

  test("asks for the section's own group, not the whole list", () => {
    openGate();
    renderSection(groupSection());

    expect(sentFilters.at(-1)).toEqual({ groupId: "grp-work" });
  });

  test("Pinned asks for the pinned group", () => {
    openGate();
    renderSection(pinnedSection());

    expect(sentFilters.at(-1)).toEqual({ groupId: "system:pinned" });
  });

  /* A channel section constrains BOTH axes. `origin_channel` is a separate
     column from `group_id`, so without `system:all` a Slack conversation the
     user filed into a custom group would match that group's card AND Slack's,
     breaking "a conversation appears in exactly one section". */
  test("a channel asks for its channel AND the ungrouped bucket", () => {
    openGate();
    renderSection({
      type: "channel",
      key: "channel:slack",
      label: "Slack",
      all: DERIVED,
      channelId: "slack",
    });

    expect(sentFilters.at(-1)).toEqual({
      groupId: "system:all",
      originChannel: "slack",
    });
  });

  /* A channel id the generated query parameter does not accept must not be
     sent; the section stays on its derived rows instead. */
  test("never fetches for a channel the query parameter does not accept", () => {
    openGate();
    serverRows = FROM_SERVER;

    const { result } = renderSection({
      type: "channel",
      key: "channel:carrier-pigeon",
      label: "Carrier Pigeon",
      all: DERIVED,
      channelId: "carrier-pigeon",
    });

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "derived-1",
    ]);
    expect(lastEnabled).toBe(false);
  });

  /* An empty section is dropped from the sidebar, so falling through to the
     empty query result while pending would make the section vanish on every
     cold load until a multi-page drain finished. */
  test("keeps painting the derived rows while the query is pending", () => {
    openGate();
    serverPending = true;
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "derived-1",
    ]);
  });

  /* An assistant predating the filter ignores the unknown parameter and
     answers 200 with every conversation, which would render in full inside
     one section. Below the gate the section stays on what it was handed. */
  test("stays on the derived rows when the gate is closed", () => {
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "derived-1",
    ]);
    expect(lastEnabled).toBe(false);
  });

  /* The gate is assistant-scoped: a version fetched for another assistant
     must not authorize a filtered fetch for this one. */
  test("stays on the derived rows when the version belongs to another assistant", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.12.0", "asst-other");
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "derived-1",
    ]);
    expect(lastEnabled).toBe(false);
  });

  /* A failed first fetch is NOT pending, so branching on `isPending` alone
     lets the empty result through - and the hide-when-empty rule then removes
     the section from the sidebar and the rail entirely. One failed request
     would take Pinned, every custom group and every channel off screen while
     their conversations still existed. */
  test("keeps painting the derived rows when the first fetch fails", () => {
    openGate();
    serverErrored = true;
    serverHasData = false;

    const { result } = renderSection(pinnedSection());

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "derived-1",
    ]);
  });

  test("a failed fetch leaves a custom group its rows rather than none", () => {
    openGate();
    serverErrored = true;
    serverHasData = false;

    const { result } = renderSection(groupSection());

    expect(result.current.conversations).not.toHaveLength(0);
  });

  /* The other half of the rule, and the reason the guard is `hasData` rather
     than `!isError`: React Query keeps the last successful data when a
     refetch fails, so those rows are still the section's real membership.
     Falling back here would shrink a section to the derived subset on any
     transient blip. */
  test("keeps the fetched rows when a later refetch fails", () => {
    openGate();
    serverErrored = true;
    serverHasData = true;
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "server-1",
      "server-2",
    ]);
  });

  /* Chats is the ungrouped remainder AND native, so it carries both axes with
     `vellum` as the channel. Without `system:all` it would also collect rows
     the user filed into custom groups. */
  test("Chats asks for the ungrouped native rows", () => {
    openGate();
    renderSection({
      type: "recents",
      key: "recents",
      label: "Chats",
      all: DERIVED,
      holdsChannels: false,
    });

    expect(sentFilters.at(-1)).toEqual({
      groupId: "system:all",
      originChannel: "vellum",
    });
  });

  /* Ungrouped, there are no channel sections, so Chats is the only section a
     Slack or Telegram row can appear in. Narrowing to `vellum` here would drop
     every one of them from the sidebar - not reorder them, remove them - so
     the filter must carry `system:all` alone.

     Asserted with `toEqual` rather than by checking `originChannel` is absent:
     the failure this guards against is the key being *present*, and a
     subset-style assertion would pass while it was.

     The gate is open here on purpose. Below it this section falls back to its
     derived rows and never asks, so a closed gate would pass this test without
     exercising the branch. */
  test("ungrouped, Chats asks for every ungrouped row whatever its origin", () => {
    openGate();
    renderSection({
      type: "recents",
      key: "recents",
      label: "Chats",
      all: DERIVED,
      holdsChannels: true,
    });

    expect(sentFilters.at(-1)).toEqual({ groupId: "system:all" });
  });

  /* Below the native-origin gate the daemon compiles `vellum` to a strict
     equality, which matches only explicitly stamped rows and returns a
     fraction of the section. That reads as a quiet account rather than a
     broken filter, so Chats must not ask at all.

     The version below sits BETWEEN the two floors deliberately: it clears the
     group-filter gate, so Pinned and the custom groups are fetching happily,
     and only Chats holds back. A version below both would pass this test
     without exercising this gate. */
  test("Chats stays on its derived rows below the native-origin gate", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", "0.11.2-dev.202608060000.abc1234", "asst-1");
    serverRows = FROM_SERVER;

    const { result } = renderSection({
      type: "recents",
      key: "recents",
      label: "Chats",
      all: DERIVED,
      holdsChannels: false,
    });

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "derived-1",
    ]);
    /* No filter means no query: nothing to key on, so nothing observed. */
    expect(sentFilters.at(-1)).toBeNull();
    expect(lastEnabled).toBe(false);
  });

  test("hasMore is false on the derived fallback even when the query says more", () => {
    // The derived rows come from the drained foreground list; offering a
    // load-more there would page a query the section is not even rendering.
    serverHasMore = true;
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());

    expect(result.current.hasMore).toBe(false);
    expect(lastEnabled).toBe(false);
  });

  test("hasMore reflects the query on the live path", () => {
    openGate();
    serverHasMore = true;
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());

    expect(result.current.hasMore).toBe(true);
  });

  test("getAllRows returns the derived rows below the gate without draining", async () => {
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());

    await expect(result.current.getAllRows()).resolves.toEqual(DERIVED);
    expect(drainCalls).toEqual([]);
  });

  test("getAllRows answers from a complete cache without draining", async () => {
    openGate();
    serverRows = FROM_SERVER;

    const { result } = renderSection(pinnedSection());
    queryClient.setQueryData(
      conversationListQueryKey("asst-1", { groupId: "system:pinned" }),
      listPage(FROM_SERVER),
    );

    await expect(result.current.getAllRows()).resolves.toEqual(FROM_SERVER);
    expect(drainCalls).toEqual([]);
  });

  test("getAllRows drains the section when the cache is a window", async () => {
    /* The bulk actions' completeness contract: a windowed cache cannot
       answer "every member", so the drain must run, with the section's own
       filter, and its answer is what the bulk action covers. */
    openGate();
    serverRows = FROM_SERVER;
    const fullMembership = [...FROM_SERVER, conv("past-window")];
    drainRows = fullMembership;

    const { result } = renderSection(pinnedSection());
    queryClient.setQueryData(
      conversationListQueryKey("asst-1", { groupId: "system:pinned" }),
      listPage(FROM_SERVER, true),
    );

    await expect(result.current.getAllRows()).resolves.toEqual(fullMembership);
    expect(drainCalls).toEqual([{ groupId: "system:pinned" }]);
  });

  test("renders the server's order as-is", () => {
    openGate();
    // Reverse creation order, so any client re-sort would flip this.
    serverRows = [conv("newer"), conv("older")];

    const { result } = renderSection(groupSection());

    expect(result.current.conversations.map((c) => c.conversationId)).toEqual([
      "newer",
      "older",
    ]);
  });
});
