/**
 * Tests for `NotificationsBell`.
 *
 * The trigger tests use `renderToStaticMarkup` (SSR) like
 * `preferences-menu.test.tsx`: the unread dot lives on the trigger, which is
 * all Radix renders while the popover is closed. The panel tests render into
 * happy-dom and click the trigger open, since the rows only mount with it.
 *
 * Assertions target text and test ids, never class strings: those drift with
 * styling and turn behaviour tests into styling tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Conversation } from "@/types/conversation-types";
import type { FeedItem } from "@vellumai/assistant-api";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const feedRef: { items: FeedItem[] } = { items: [] };

mock.module("@/domains/home/hooks/use-home-feed-query", () => ({
  useHomeFeedQuery: () => ({
    data: { items: feedRef.items },
    isLoading: false,
    isError: false,
    updateStatus: { mutate: () => {}, isPending: false },
    markAll: { mutate: () => {}, isPending: false },
  }),
}));

mock.module("@/lib/backwards-compat/bulk-feed-status", () => ({
  useSupportsBulkFeedStatus: () => true,
}));

const navigateMock = mock((..._args: unknown[]) => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

// Mocked at the boundary the bell calls, so "Go to Conversation" can be
// asserted without dragging the conversation stores, haptics, and sound
// manager that the real helper drives into a popover test.
const navigateToConversationMock = mock((..._args: unknown[]) => {});

mock.module("@/utils/conversation-navigation", () => ({
  navigateToConversation: navigateToConversationMock,
}));

/**
 * The three conversation lists the detail validates its link against, plus a
 * record of the `enabled` flag each hook was called with. The flags are what
 * pin the lazy-loading property: the bell must not fetch these lists to render
 * its list view.
 */
type ConversationListName = "foreground" | "background" | "scheduled";

const conversationListsRef: {
  foreground: Conversation[];
  background: Conversation[];
  scheduled: Conversation[];
  isPending: boolean;
} = { foreground: [], background: [], scheduled: [], isPending: false };

const enabledCalls: Record<ConversationListName, boolean[]> = {
  foreground: [],
  background: [],
  scheduled: [],
};

function conversationListResult(name: ConversationListName, enabled: boolean) {
  enabledCalls[name].push(enabled);
  return {
    conversations: conversationListsRef[name],
    isLoading: false,
    isPending: conversationListsRef.isPending,
    isError: false,
    error: null,
    refetch: () => {},
  };
}

mock.module("@/hooks/conversation-queries", () => ({
  useConversationListQuery: (_assistantId: string | null, enabled = true) =>
    conversationListResult("foreground", enabled),
  useBackgroundConversationListQuery: (
    _assistantId: string | null,
    enabled = true,
  ) => conversationListResult("background", enabled),
  useScheduledConversationListQuery: (
    _assistantId: string | null,
    enabled = true,
  ) => conversationListResult("scheduled", enabled),
}));

function conversation(conversationId: string): Conversation {
  return { conversationId } as Conversation;
}

/**
 * The schedules list the detail validates its "View schedule" link against,
 * plus a record of the `enabled` flag the query was called with. Same shape as
 * the conversation lists above, and the flags pin the same lazy-loading
 * property: the bell must not fetch schedules to render its list view.
 */
const schedulesRef: { list: { id: string }[]; isPending: boolean } = {
  list: [],
  isPending: false,
};

const scheduleEnabledCalls: boolean[] = [];

mock.module("@/domains/settings/api/schedules", () => ({
  schedulesListQueryOptions: (assistantId: string | undefined) => ({
    queryKey: ["schedules", assistantId ?? ""],
    queryFn: () => Promise.resolve(schedulesRef.list),
  }),
}));

// The bell is the only part of this tree that reads a TanStack query directly
// (the feed and conversation hooks are mocked above), so stubbing `useQuery`
// stands in for a QueryClientProvider and exposes the `enabled` flag.
mock.module("@tanstack/react-query", () => ({
  useQuery: (options: { enabled?: boolean }) => {
    scheduleEnabledCalls.push(options.enabled === true);
    return { data: schedulesRef.list, isPending: schedulesRef.isPending };
  },
}));

function schedule(id: string): { id: string } {
  return { id };
}

mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = {
    activeAssistantId: () => "assistant-1",
  };
  return { useResolvedAssistantsStore: store };
});

import { NotificationsBell } from "@/domains/home/components/notifications-bell";

// The dot element itself, matched by a styling-independent test hook so the
// assertions survive restyling. The accessible name is a separate concern, so
// it is asserted alongside. The closing quote is load-bearing: it stops
// READ_LABEL matching the unread label.
const UNREAD_DOT = 'data-testid="notifications-bell-unread-dot"';
const UNREAD_LABEL = 'aria-label="Notifications (unread)"';
const READ_LABEL = 'aria-label="Notifications"';

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

function feedItem(overrides: Partial<FeedItem>): FeedItem {
  const timestamp = new Date(Date.now() - THREE_HOURS_MS).toISOString();
  return {
    id: "item-1",
    type: "notification",
    priority: 50,
    summary: "Something happened",
    timestamp,
    createdAt: timestamp,
    status: "new",
    ...overrides,
  };
}

function renderBell(): string {
  return renderToStaticMarkup(createElement(NotificationsBell));
}

async function clickTrigger(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  // Radix measures and positions the panel after the click, off a promise.
  await act(async () => {});
}

async function openBell(): Promise<void> {
  render(<NotificationsBell />);
  await clickTrigger();
}

/** Open the bell and select a row by the title its card carries. */
async function openDetail(title: string): Promise<void> {
  await openBell();
  fireEvent.click(screen.getByRole("button", { name: title }));
  await act(async () => {});
}

beforeEach(() => {
  isMobileRef.value = false;
  feedRef.items = [];
  conversationListsRef.foreground = [];
  conversationListsRef.background = [];
  conversationListsRef.scheduled = [];
  conversationListsRef.isPending = false;
  enabledCalls.foreground = [];
  enabledCalls.background = [];
  enabledCalls.scheduled = [];
  schedulesRef.list = [];
  schedulesRef.isPending = false;
  scheduleEnabledCalls.length = 0;
  navigateMock.mockClear();
  navigateToConversationMock.mockClear();
});

afterEach(async () => {
  // Radix schedules the panel's mount and unmount off a frame. Draining those
  // before the tree goes away keeps them from landing in the next test's
  // render, where React has no act scope to attribute them to.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
});

describe("NotificationsBell unread dot", () => {
  test("shows the dot when an unread notification exists", () => {
    feedRef.items = [feedItem({ status: "new" })];
    const html = renderBell();
    expect(html).toContain(UNREAD_DOT);
    expect(html).toContain(UNREAD_LABEL);
  });

  test("hides the dot when every notification has been read", () => {
    feedRef.items = [
      feedItem({ id: "a", status: "seen" }),
      feedItem({ id: "b", status: "acted_on" }),
    ];
    const html = renderBell();
    expect(html).not.toContain(UNREAD_DOT);
    expect(html).toContain(READ_LABEL);
    expect(html).not.toContain(UNREAD_LABEL);
  });

  test("hides the dot when the feed is empty", () => {
    const html = renderBell();
    expect(html).not.toContain(UNREAD_DOT);
    expect(html).toContain(READ_LABEL);
  });

  test("ignores unread items that the popover never shows", () => {
    // Dismissed and high-urgency items are filtered out of the list, so
    // they must not light a dot the panel can't explain.
    feedRef.items = [
      feedItem({ id: "a", status: "dismissed" }),
      feedItem({ id: "b", status: "new", urgency: "high" }),
    ];
    const html = renderBell();
    expect(html).not.toContain(UNREAD_DOT);
    expect(html).toContain(READ_LABEL);
  });

  test("mobile trigger carries the same dot", () => {
    isMobileRef.value = true;
    feedRef.items = [feedItem({ status: "new" })];
    const html = renderBell();
    expect(html).toContain(UNREAD_DOT);
    expect(html).toContain(UNREAD_LABEL);
  });
});

describe("NotificationsBell panel", () => {
  test("renders each row with title, timestamp, and preview", async () => {
    feedRef.items = [
      feedItem({
        category: "background",
        title: "Watcher job failed",
        summary: "The watcher job could not reach the upstream service.",
      }),
    ];

    await openBell();

    expect(screen.getByText("Watcher job failed")).toBeTruthy();
    expect(screen.getByText("3h ago")).toBeTruthy();
    expect(
      screen.getByText("The watcher job could not reach the upstream service."),
    ).toBeTruthy();
  });

  test("rows drop the category chip and the source label", async () => {
    feedRef.items = [
      feedItem({
        category: "background",
        sourceLabel: "Heartbeat",
        title: "Watcher job failed",
      }),
    ];

    await openBell();

    expect(screen.queryByText("Background")).toBeNull();
    expect(screen.queryByText("Heartbeat")).toBeNull();
  });

  test("keeps its own unread dot distinct from the rows'", async () => {
    feedRef.items = [feedItem({ status: "new" })];

    await openBell();

    expect(screen.getByTestId("notifications-bell-unread-dot")).toBeTruthy();
    expect(screen.getByTestId("home-recap-row-unread-dot")).toBeTruthy();
  });

  test("keeps the panel header and bulk actions", async () => {
    feedRef.items = [feedItem({ status: "new" })];

    await openBell();

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mark all as read" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  test("offers no route out to the Activity page", async () => {
    feedRef.items = [feedItem({ status: "new" })];

    await openBell();

    expect(screen.queryByRole("button", { name: "View all" })).toBeNull();
  });
});

describe("NotificationsBell detail", () => {
  const FIRST = feedItem({
    id: "first",
    title: "Watcher job failed",
    summary: "The watcher job could not reach the upstream service.",
  });
  const SECOND = feedItem({ id: "second", title: "Backup finished" });

  test("selecting a row opens that item's detail in place", async () => {
    feedRef.items = [FIRST, SECOND];

    await openDetail("Watcher job failed");

    expect(
      screen.getByRole("heading", { name: "Watcher job failed" }),
    ).toBeTruthy();
    expect(
      screen.getByText("The watcher job could not reach the upstream service."),
    ).toBeTruthy();
    expect(screen.getByText("3h ago")).toBeTruthy();
    // The list is gone, so its other row went with it.
    expect(screen.queryByText("Backup finished")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Notifications" })).toBeNull();
  });

  test("selecting a row does not navigate", async () => {
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    expect(navigateMock).not.toHaveBeenCalled();
    expect(navigateToConversationMock).not.toHaveBeenCalled();
  });

  test("the list-level bulk actions stay out of the detail", async () => {
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    expect(
      screen.queryByRole("button", { name: "Mark all as read" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();
  });

  test("the back control returns to the list", async () => {
    feedRef.items = [FIRST, SECOND];

    await openDetail("Watcher job failed");
    fireEvent.click(
      screen.getByRole("button", { name: "Back to notifications" }),
    );
    await act(async () => {});

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("Backup finished")).toBeTruthy();
  });

  test("offers Go to Conversation when the item has a conversation", async () => {
    feedRef.items = [{ ...FIRST, conversationId: "conversation-1" }];
    conversationListsRef.foreground = [conversation("conversation-1")];

    await openDetail("Watcher job failed");
    fireEvent.click(screen.getByRole("button", { name: "Go to Conversation" }));
    await act(async () => {});

    expect(navigateToConversationMock).toHaveBeenCalledTimes(1);
    expect(navigateToConversationMock.mock.calls[0]?.[1]).toBe(
      "conversation-1",
    );
    // Navigating closes the bell, so the panel is gone with it.
    expect(
      screen.queryByRole("heading", { name: "Watcher job failed" }),
    ).toBeNull();
  });

  test("omits the conversation footer when the item has none", async () => {
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    expect(
      screen.queryByRole("button", { name: "Go to Conversation" }),
    ).toBeNull();
  });

  test("offers Go to Conversation for a background job that still exists", async () => {
    feedRef.items = [{ ...FIRST, conversationId: "background-1" }];
    conversationListsRef.background = [conversation("background-1")];

    await openDetail("Watcher job failed");

    expect(
      screen.getByRole("button", { name: "Go to Conversation" }),
    ).toBeTruthy();
  });

  test("omits the conversation footer when the conversation is gone", async () => {
    feedRef.items = [{ ...FIRST, conversationId: "deleted-1" }];
    conversationListsRef.foreground = [conversation("other-1")];
    conversationListsRef.scheduled = [conversation("other-2")];

    await openDetail("Watcher job failed");

    expect(
      screen.queryByRole("button", { name: "Go to Conversation" }),
    ).toBeNull();
  });

  test("offers Go to Conversation while the lists are still loading", async () => {
    feedRef.items = [{ ...FIRST, conversationId: "background-1" }];
    conversationListsRef.isPending = true;

    await openDetail("Watcher job failed");

    expect(
      screen.getByRole("button", { name: "Go to Conversation" }),
    ).toBeTruthy();
  });

  test("offers View schedule when the item's schedule still exists", async () => {
    feedRef.items = [{ ...FIRST, metadata: { scheduleId: "schedule-1" } }];
    schedulesRef.list = [schedule("schedule-1")];

    await openDetail("Watcher job failed");

    expect(screen.getByRole("button", { name: "View schedule" })).toBeTruthy();
  });

  test("omits View schedule when the item has no schedule", async () => {
    feedRef.items = [FIRST];
    schedulesRef.list = [schedule("schedule-1")];

    await openDetail("Watcher job failed");

    expect(screen.queryByRole("button", { name: "View schedule" })).toBeNull();
  });

  test("omits View schedule when the schedule is gone", async () => {
    feedRef.items = [{ ...FIRST, metadata: { scheduleId: "deleted-1" } }];
    schedulesRef.list = [schedule("schedule-1")];

    await openDetail("Watcher job failed");

    expect(screen.queryByRole("button", { name: "View schedule" })).toBeNull();
  });

  test("offers View schedule while the schedules list is still loading", async () => {
    feedRef.items = [{ ...FIRST, metadata: { scheduleId: "schedule-1" } }];
    schedulesRef.isPending = true;

    await openDetail("Watcher job failed");

    expect(screen.getByRole("button", { name: "View schedule" })).toBeTruthy();
  });

  test("View schedule opens the schedule and closes the bell", async () => {
    feedRef.items = [{ ...FIRST, metadata: { scheduleId: "schedule-1" } }];
    schedulesRef.list = [schedule("schedule-1")];

    await openDetail("Watcher job failed");
    fireEvent.click(screen.getByRole("button", { name: "View schedule" }));
    await act(async () => {});

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock.mock.calls[0]?.[0]).toBe(
      "/assistant/schedules/schedule-1",
    );
    // Navigating closes the bell, so the panel is gone with it.
    expect(
      screen.queryByRole("heading", { name: "Watcher job failed" }),
    ).toBeNull();
  });

  test("offers both footer links when the item has a schedule and a conversation", async () => {
    feedRef.items = [
      {
        ...FIRST,
        conversationId: "conversation-1",
        metadata: { scheduleId: "schedule-1" },
      },
    ];
    conversationListsRef.foreground = [conversation("conversation-1")];
    schedulesRef.list = [schedule("schedule-1")];

    await openDetail("Watcher job failed");

    expect(screen.getByRole("button", { name: "View schedule" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Go to Conversation" }),
    ).toBeTruthy();
  });

  test("loads the conversation and schedule lists only once a detail is open", async () => {
    feedRef.items = [FIRST];

    await openBell();

    // The list view has no use for conversation or schedule ids, and the bell
    // renders on every route, so nothing may be fetched to show it.
    expect(enabledCalls.foreground.length).toBeGreaterThan(0);
    expect(enabledCalls.foreground.some((enabled) => enabled)).toBe(false);
    expect(enabledCalls.background.some((enabled) => enabled)).toBe(false);
    expect(enabledCalls.scheduled.some((enabled) => enabled)).toBe(false);
    expect(scheduleEnabledCalls.length).toBeGreaterThan(0);
    expect(scheduleEnabledCalls.some((enabled) => enabled)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Watcher job failed" }));
    await act(async () => {});

    expect(enabledCalls.foreground.at(-1)).toBe(true);
    expect(enabledCalls.background.at(-1)).toBe(true);
    expect(enabledCalls.scheduled.at(-1)).toBe(true);
    expect(scheduleEnabledCalls.at(-1)).toBe(true);
  });

  test("reopening the bell lands back on the list", async () => {
    feedRef.items = [FIRST, SECOND];

    await openDetail("Watcher job failed");
    await clickTrigger();
    await clickTrigger();

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("Backup finished")).toBeTruthy();
  });

  test("mobile opens the detail in the bottom sheet", async () => {
    isMobileRef.value = true;
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    expect(
      screen.getByRole("button", { name: "Back to notifications" }),
    ).toBeTruthy();
    expect(
      screen.getByText("The watcher job could not reach the upstream service."),
    ).toBeTruthy();
  });
});
