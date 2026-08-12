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
import { formatCompactLocalDate } from "@/utils/format-date";
import type { FeedItem, FeedItemStatus } from "@vellumai/assistant-api";

import { feedItem } from "../feed-test-fixtures";

const isTouchMobileRef = { value: false };

mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => isTouchMobileRef.value,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));

const feedRef: { items: FeedItem[] } = { items: [] };

interface UpdateStatusVars {
  itemId: string;
  status: FeedItemStatus;
}

interface TriggerActionVars {
  itemId: string;
  actionId: string;
}

interface TriggerActionCallbacks {
  onSuccess?: (data: { conversationId: string }) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
}

const updateStatusCalls: UpdateStatusVars[] = [];
const triggerActionCalls: TriggerActionVars[] = [];

/**
 * How the mocked `triggerAction` settles. "pending" leaves it in flight, which
 * is the state the double-click guard has to hold under: the real mutation's
 * `isPending` only reaches the button on the next render, so a guard that
 * relies on it would let a second click through and open a second
 * conversation.
 */
const triggerActionRef: {
  outcome: "pending" | "success" | "error";
  conversationId: string;
} = { outcome: "pending", conversationId: "action-conversation-1" };

mock.module("@/domains/home/hooks/use-home-feed-query", () => ({
  useHomeFeedQuery: () => ({
    data: { items: feedRef.items },
    isLoading: false,
    isError: false,
    updateStatus: {
      mutate: (vars: UpdateStatusVars) => {
        updateStatusCalls.push(vars);
      },
      isPending: false,
    },
    triggerAction: {
      mutate: (vars: TriggerActionVars, callbacks?: TriggerActionCallbacks) => {
        triggerActionCalls.push(vars);
        if (triggerActionRef.outcome === "success") {
          callbacks?.onSuccess?.({
            conversationId: triggerActionRef.conversationId,
          });
          callbacks?.onSettled?.();
        } else if (triggerActionRef.outcome === "error") {
          callbacks?.onError?.(new Error("action failed"));
          callbacks?.onSettled?.();
        }
      },
      isPending: false,
    },
    markAll: { mutate: () => {}, isPending: false },
  }),
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: () => {}, success: () => {} },
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
 * The lists the detail validates its entity links against ("View schedule",
 * "View skill"), plus a record of the `enabled` flag each query was called
 * with. Same shape as the conversation lists above, and the flags pin the same
 * lazy-loading property: the bell must not fetch either list to render its
 * list view.
 */
const schedulesRef: { list: { id: string }[]; isPending: boolean } = {
  list: [],
  isPending: false,
};

const skillsRef: { list: { id: string }[]; isPending: boolean } = {
  list: [],
  isPending: false,
};

const entityLinkEnabledCalls: boolean[] = [];

mock.module("@/utils/schedules", () => ({
  schedulesListQueryOptions: (assistantId: string | undefined) => ({
    queryKey: ["schedules", assistantId ?? ""],
    queryFn: () => Promise.resolve(schedulesRef.list),
  }),
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  skillsGetOptions: (options: { query?: { kind?: string } }) => ({
    queryKey: ["skills", options.query?.kind ?? ""],
    queryFn: () => Promise.resolve({ skills: skillsRef.list }),
  }),
}));

// The entity-link resolver is the only part of this tree that reads a TanStack
// query directly (the feed and conversation hooks are mocked above), so
// stubbing `useQuery` stands in for a QueryClientProvider and exposes the
// `enabled` flag. Dispatching on the query key keeps the two lists distinct:
// the resolver reads both on every render, and a stub that answered them
// identically could not tell a present skill from a present schedule.
mock.module("@tanstack/react-query", () => ({
  useQuery: (options: { enabled?: boolean; queryKey: unknown[] }) => {
    entityLinkEnabledCalls.push(options.enabled === true);
    if (options.queryKey[0] === "skills") {
      return {
        data: { skills: skillsRef.list },
        isPending: skillsRef.isPending,
      };
    }
    return { data: schedulesRef.list, isPending: schedulesRef.isPending };
  },
}));

function schedule(id: string): { id: string } {
  return { id };
}

function skill(id: string): { id: string } {
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

function bellItem(overrides: Partial<FeedItem>): FeedItem {
  // Relative so the bell's recency treatment is exercised.
  const timestamp = new Date(Date.now() - THREE_HOURS_MS).toISOString();
  return feedItem({
    id: "item-1",
    summary: "Something happened",
    timestamp,
    createdAt: timestamp,
    ...overrides,
  });
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

/**
 * Labels of the boxes the detail's footer holds, in document order. Read off
 * the elements rather than the accessibility tree so the row can be compared
 * across the pending window, where the links are deliberately not exposed.
 */
function footerLinkLabels(footer: HTMLElement): (string | null)[] {
  return Array.from(footer.querySelectorAll("button")).map(
    (button) => button.textContent,
  );
}

/** The detail's fixed-height content region. */
function detailContent(): HTMLElement {
  return screen.getByTestId("notifications-bell-detail-content");
}

/** The detail's pinned footer strip. */
function detailFooter(): HTMLElement {
  return screen.getByTestId("notifications-bell-detail-footer");
}

beforeEach(() => {
  isTouchMobileRef.value = false;
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
  skillsRef.list = [];
  skillsRef.isPending = false;
  entityLinkEnabledCalls.length = 0;
  updateStatusCalls.length = 0;
  triggerActionCalls.length = 0;
  triggerActionRef.outcome = "pending";
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
    feedRef.items = [bellItem({ status: "new" })];
    const html = renderBell();
    expect(html).toContain(UNREAD_DOT);
    expect(html).toContain(UNREAD_LABEL);
  });

  test("hides the dot when every notification has been read", () => {
    feedRef.items = [
      bellItem({ id: "a", status: "seen" }),
      bellItem({ id: "b", status: "acted_on" }),
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
      bellItem({ id: "a", status: "dismissed" }),
      bellItem({ id: "b", status: "new", urgency: "high" }),
    ];
    const html = renderBell();
    expect(html).not.toContain(UNREAD_DOT);
    expect(html).toContain(READ_LABEL);
  });

  test("mobile trigger carries the same dot", () => {
    isTouchMobileRef.value = true;
    feedRef.items = [bellItem({ status: "new" })];
    const html = renderBell();
    expect(html).toContain(UNREAD_DOT);
    expect(html).toContain(UNREAD_LABEL);
  });
});

describe("NotificationsBell panel", () => {
  test("renders each row with title, timestamp, and preview", async () => {
    feedRef.items = [
      bellItem({
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
      bellItem({
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
    feedRef.items = [bellItem({ status: "new" })];

    await openBell();

    expect(screen.getByTestId("notifications-bell-unread-dot")).toBeTruthy();
    expect(screen.getByTestId("home-recap-row-unread-dot")).toBeTruthy();
  });

  test("keeps the panel header and bulk actions", async () => {
    feedRef.items = [bellItem({ status: "new" })];

    await openBell();

    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mark all as read" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });

  test("offers no route out to the Activity page", async () => {
    feedRef.items = [bellItem({ status: "new" })];

    await openBell();

    expect(screen.queryByRole("button", { name: "View all" })).toBeNull();
  });
});

describe("NotificationsBell detail", () => {
  // bellItem, not the shared fixture: this block asserts the rendered
  // relative timestamp, which needs a time relative to now.
  const FIRST = bellItem({
    id: "first",
    title: "Watcher job failed",
    summary: "The watcher job could not reach the upstream service.",
  });
  const SECOND = feedItem({ id: "second", title: "Backup finished" });

  /**
   * Opens the detail on a body of the given length and reports the height its
   * content region resolved to, tearing the tree down so the next call starts
   * from one bell.
   */
  async function detailFrameHeight(summary: string): Promise<string> {
    feedRef.items = [{ ...FIRST, summary }];
    await openDetail("Watcher job failed");
    const height = detailContent().style.height;
    cleanup();
    return height;
  }

  test("selecting a row opens that item's detail in place", async () => {
    feedRef.items = [FIRST, SECOND];

    await openDetail("Watcher job failed");

    expect(
      screen.getByRole("heading", { name: "Watcher job failed" }),
    ).toBeTruthy();
    expect(
      screen.getByText("The watcher job could not reach the upstream service."),
    ).toBeTruthy();
    expect(detailFooter().textContent).toContain(
      formatCompactLocalDate(FIRST.timestamp),
    );
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

  test("withholds Go to Conversation while the lists are still loading", async () => {
    feedRef.items = [{ ...FIRST, conversationId: "background-1" }];
    conversationListsRef.isPending = true;

    await openDetail("Watcher job failed");

    expect(
      screen.queryByRole("button", { name: "Go to Conversation" }),
    ).toBeNull();
    // The row the link will take is held, so the panel keeps its height when
    // the lists land.
    expect(screen.getByTestId("notifications-bell-detail-footer")).toBeTruthy();
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

  test("withholds View schedule while the schedules list is still loading", async () => {
    feedRef.items = [{ ...FIRST, metadata: { scheduleId: "schedule-1" } }];
    schedulesRef.isPending = true;

    await openDetail("Watcher job failed");

    expect(screen.queryByRole("button", { name: "View schedule" })).toBeNull();
    expect(screen.getByTestId("notifications-bell-detail-footer")).toBeTruthy();
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

  test("offers View skill when the skill a background pass updated still exists", async () => {
    feedRef.items = [{ ...FIRST, metadata: { skillId: "weekly-export" } }];
    skillsRef.list = [skill("weekly-export")];

    await openDetail("Watcher job failed");

    // The schedules list stays empty: a skill link must come from the skills
    // list, not from whichever list answered first.
    expect(screen.getByRole("button", { name: "View skill" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "View schedule" })).toBeNull();
  });

  test("omits View skill when the item names no skill", async () => {
    feedRef.items = [FIRST];
    skillsRef.list = [skill("weekly-export")];

    await openDetail("Watcher job failed");

    expect(screen.queryByRole("button", { name: "View skill" })).toBeNull();
  });

  test("omits View skill when the skill has since been removed", async () => {
    feedRef.items = [{ ...FIRST, metadata: { skillId: "removed-skill" } }];
    skillsRef.list = [skill("weekly-export")];

    await openDetail("Watcher job failed");

    expect(screen.queryByRole("button", { name: "View skill" })).toBeNull();
  });

  test("withholds View skill while the skills list is still loading", async () => {
    feedRef.items = [{ ...FIRST, metadata: { skillId: "weekly-export" } }];
    skillsRef.isPending = true;

    await openDetail("Watcher job failed");

    expect(screen.queryByRole("button", { name: "View skill" })).toBeNull();
    expect(screen.getByTestId("notifications-bell-detail-footer")).toBeTruthy();
  });

  test("View skill opens the skill and closes the bell", async () => {
    feedRef.items = [{ ...FIRST, metadata: { skillId: "weekly-export" } }];
    skillsRef.list = [skill("weekly-export")];

    await openDetail("Watcher job failed");
    fireEvent.click(screen.getByRole("button", { name: "View skill" }));
    await act(async () => {});

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock.mock.calls[0]?.[0]).toBe(
      "/assistant/skills/weekly-export",
    );
    // Navigating closes the bell, so the panel is gone with it.
    expect(
      screen.queryByRole("heading", { name: "Watcher job failed" }),
    ).toBeNull();
  });

  test("percent-encodes a namespaced skill id so the deep link stays one path segment", async () => {
    feedRef.items = [{ ...FIRST, metadata: { skillId: "org/repo/skill" } }];
    skillsRef.list = [skill("org/repo/skill")];

    await openDetail("Watcher job failed");
    fireEvent.click(screen.getByRole("button", { name: "View skill" }));
    await act(async () => {});

    expect(navigateMock.mock.calls[0]?.[0]).toBe(
      "/assistant/skills/org%2Frepo%2Fskill",
    );
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

  test("neither footer link is reachable while the lists are still loading", async () => {
    feedRef.items = [
      {
        ...FIRST,
        conversationId: "conversation-1",
        metadata: { scheduleId: "schedule-1" },
      },
    ];
    conversationListsRef.isPending = true;
    schedulesRef.isPending = true;

    await openDetail("Watcher job failed");

    // Out of the accessibility tree, so neither reads as an actionable
    // control before its target is known to exist.
    expect(
      screen.queryByRole("button", { name: "Go to Conversation" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "View schedule" })).toBeNull();

    const conversationLink = screen.getByText("Go to Conversation");
    const scheduleLink = screen.getByText("View schedule");
    expect(conversationLink.hasAttribute("inert")).toBe(true);
    expect(scheduleLink.hasAttribute("inert")).toBe(true);

    fireEvent.click(conversationLink);
    fireEvent.click(scheduleLink);
    await act(async () => {});

    expect(navigateToConversationMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("the footer keeps its reserved row when the lists resolve", async () => {
    feedRef.items = [
      {
        ...FIRST,
        conversationId: "conversation-1",
        metadata: { scheduleId: "schedule-1" },
      },
    ];
    conversationListsRef.isPending = true;
    schedulesRef.isPending = true;

    const { rerender } = render(<NotificationsBell />);
    await clickTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Watcher job failed" }));
    await act(async () => {});

    const pendingFooter = screen.getByTestId(
      "notifications-bell-detail-footer",
    );
    expect(footerLinkLabels(pendingFooter)).toEqual([
      "View schedule",
      "Go to Conversation",
    ]);

    conversationListsRef.isPending = false;
    conversationListsRef.foreground = [conversation("conversation-1")];
    schedulesRef.isPending = false;
    schedulesRef.list = [schedule("schedule-1")];
    rerender(<NotificationsBell />);
    await act(async () => {});

    // The same footer element holding the same two boxes: the row the links
    // reserved is the row they end up in, so nothing resizes around them.
    const resolvedFooter = screen.getByTestId(
      "notifications-bell-detail-footer",
    );
    expect(resolvedFooter).toBe(pendingFooter);
    expect(footerLinkLabels(resolvedFooter)).toEqual([
      "View schedule",
      "Go to Conversation",
    ]);
    expect(screen.getByRole("button", { name: "View schedule" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Go to Conversation" }),
    ).toBeTruthy();
  });

  test("keeps the footer once the lists resolve without either target", async () => {
    feedRef.items = [
      {
        ...FIRST,
        conversationId: "deleted-1",
        metadata: { scheduleId: "deleted-2" },
      },
    ];
    conversationListsRef.foreground = [conversation("other-1")];
    schedulesRef.list = [schedule("other-2")];

    await openDetail("Watcher job failed");

    // No links survived validation, but the strip carries the timestamp, so
    // it stays and only the links go.
    const footer = detailFooter();
    expect(footerLinkLabels(footer)).toEqual([]);
    expect(footer.textContent).toContain(
      formatCompactLocalDate(FIRST.timestamp),
    );
    expect(
      screen.queryByRole("button", { name: "Go to Conversation" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "View schedule" })).toBeNull();
  });

  test("keeps the footer for an item with neither a conversation nor a schedule", async () => {
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    const footer = detailFooter();
    expect(footerLinkLabels(footer)).toEqual([]);
    expect(footer.textContent).toContain(
      formatCompactLocalDate(FIRST.timestamp),
    );
  });

  test("the timestamp rides in the footer rather than the body", async () => {
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    const footer = detailFooter();
    const absolute = formatCompactLocalDate(FIRST.timestamp);
    expect(footer.textContent).toContain(absolute);
    // The absolute form only. The relative label is the list row's treatment,
    // and repeating it here crowds the strip the links share.
    expect(footer.textContent).not.toContain("3h ago");
    expect(detailContent().textContent).not.toContain(absolute);
  });

  test("the content region is a fixed frame rather than a cap", async () => {
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    // A `height` in bare pixels, so the frame is drawn at the budget whatever
    // the notification is. The `max-height` riding alongside it is the
    // viewport clamp below, which carries no content term either.
    expect(detailContent().style.height).toMatch(/^\d+px$/);
  });

  test("the frame is clamped to the available viewport height", async () => {
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    // A phone in landscape is roughly 844x390: wide enough to take the
    // popover path (the mobile query is on width alone) but far too short for
    // the budget, which a fixed height on its own would overflow. `dvh` over
    // `vh` so the term stays honest under mobile browser chrome.
    const content = detailContent();
    const clamp = /^calc\(100dvh - (\d+)px\)$/.exec(content.style.maxHeight);
    expect(clamp).not.toBeNull();

    // The clamp may only engage on a viewport shorter than any ordinary
    // desktop window, so the frame there is still exactly the budget.
    const budget = Number.parseInt(content.style.height, 10);
    const chromeAllowance = Number.parseInt(clamp?.[1] ?? "", 10);
    expect(budget + chromeAllowance).toBeLessThan(600);
  });

  test("a long body and a short body render in the same frame", async () => {
    const shortHeight = await detailFrameHeight("Done.");
    const longHeight = await detailFrameHeight(
      "The watcher job could not reach the upstream service. ".repeat(80),
    );

    expect(shortHeight).not.toBe("");
    expect(shortHeight).toBe(longHeight);
  });

  test("loads the conversation and entity-link lists only once a detail is open", async () => {
    feedRef.items = [FIRST];

    await openBell();

    // The list view has no use for conversation, schedule, or skill ids, and
    // the bell renders on every route, so nothing may be fetched to show it.
    expect(enabledCalls.foreground.length).toBeGreaterThan(0);
    expect(enabledCalls.foreground.some((enabled) => enabled)).toBe(false);
    expect(enabledCalls.background.some((enabled) => enabled)).toBe(false);
    expect(enabledCalls.scheduled.some((enabled) => enabled)).toBe(false);
    expect(entityLinkEnabledCalls.length).toBeGreaterThan(0);
    expect(entityLinkEnabledCalls.some((enabled) => enabled)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Watcher job failed" }));
    await act(async () => {});

    expect(enabledCalls.foreground.at(-1)).toBe(true);
    expect(enabledCalls.background.at(-1)).toBe(true);
    expect(enabledCalls.scheduled.at(-1)).toBe(true);
    expect(entityLinkEnabledCalls.at(-1)).toBe(true);
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
    isTouchMobileRef.value = true;
    feedRef.items = [FIRST];

    await openDetail("Watcher job failed");

    expect(
      screen.getByRole("button", { name: "Back to notifications" }),
    ).toBeTruthy();
    expect(
      screen.getByText("The watcher job could not reach the upstream service."),
    ).toBeTruthy();
    // No viewport clamp on this path: the sheet is capped at 85dvh and its
    // body scrolls, so an oversized frame scrolls inside the sheet rather
    // than escaping the viewport the way the popover would. The sheet's own
    // budget is a bare `dvh` length, which happy-dom drops from the CSSOM, so
    // the height value itself is only observable on the popover path above.
    expect(detailContent().style.maxHeight).toBe("");
    expect(detailFooter().textContent).toContain(
      formatCompactLocalDate(FIRST.timestamp),
    );
  });
});

describe("NotificationsBell detail status actions", () => {
  const READ = feedItem({
    id: "first",
    status: "seen",
    title: "Watcher job failed",
  });
  const SECOND = feedItem({
    id: "second",
    status: "seen",
    title: "Backup finished",
  });

  test("marks an unread item as read", async () => {
    feedRef.items = [feedItem({ id: "first", title: "Watcher job failed" })];

    await openDetail("Watcher job failed");
    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
    await act(async () => {});

    // Two calls: selecting the row already marks it seen, and the header
    // button is the second. The mocked feed never writes the status back, so
    // the item stays unread and the button keeps offering the same action.
    expect(updateStatusCalls).toEqual([
      { itemId: "first", status: "seen" },
      { itemId: "first", status: "seen" },
    ]);
  });

  test("marks a read item as unread", async () => {
    feedRef.items = [READ];

    await openDetail("Watcher job failed");
    fireEvent.click(screen.getByRole("button", { name: "Mark as unread" }));
    await act(async () => {});

    expect(updateStatusCalls).toEqual([{ itemId: "first", status: "new" }]);
  });

  test("dismissing returns to the list", async () => {
    feedRef.items = [READ, SECOND];

    await openDetail("Watcher job failed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => {});

    expect(updateStatusCalls).toEqual([
      { itemId: "first", status: "dismissed" },
    ]);
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("Backup finished")).toBeTruthy();
  });

  test("an item dismissed elsewhere offers Restore in place of Dismiss", async () => {
    feedRef.items = [READ];

    const { rerender } = render(<NotificationsBell />);
    await clickTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Watcher job failed" }));
    await act(async () => {});

    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();

    feedRef.items = [{ ...READ, status: "dismissed" }];
    rerender(<NotificationsBell />);
    await act(async () => {});

    // The detail stays on the item rather than blanking, and swaps the
    // destructive action for the one that undoes it.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await act(async () => {});

    expect(updateStatusCalls).toEqual([{ itemId: "first", status: "seen" }]);
  });

  test("the status actions stay out of the list view", async () => {
    feedRef.items = [READ];

    await openBell();

    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
});

describe("NotificationsBell detail action items", () => {
  const ACTIONS = [
    { id: "triage", label: "Triage my inbox", prompt: "Triage my inbox" },
    { id: "digest", label: "Set up daily digest", prompt: "Set up a digest" },
  ];

  const WITH_ACTIONS = feedItem({
    id: "first",
    status: "seen",
    title: "Gmail connected",
    actions: ACTIONS,
  });

  async function openActionDetail(): Promise<void> {
    feedRef.items = [WITH_ACTIONS];
    await openDetail("Gmail connected");
  }

  test("renders one button per action, labelled by the action", async () => {
    await openActionDetail();

    expect(
      screen.getByTestId("notifications-bell-detail-actions"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Triage my inbox" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Set up daily digest" }),
    ).toBeTruthy();
  });

  test("renders no action section when the item carries none", async () => {
    feedRef.items = [
      feedItem({ id: "first", status: "seen", title: "Backup finished" }),
    ];

    await openDetail("Backup finished");

    expect(
      screen.queryByTestId("notifications-bell-detail-actions"),
    ).toBeNull();
  });

  test("renders no action section when the actions list is empty", async () => {
    feedRef.items = [{ ...WITH_ACTIONS, actions: [] }];

    await openDetail("Gmail connected");

    expect(
      screen.queryByTestId("notifications-bell-detail-actions"),
    ).toBeNull();
  });

  test("triggering an action opens the conversation it creates and closes the bell", async () => {
    triggerActionRef.outcome = "success";
    await openActionDetail();

    fireEvent.click(
      screen.getByRole("button", { name: "Set up daily digest" }),
    );
    await act(async () => {});

    expect(triggerActionCalls).toEqual([
      { itemId: "first", actionId: "digest" },
    ]);
    expect(navigateToConversationMock).toHaveBeenCalledTimes(1);
    expect(navigateToConversationMock.mock.calls[0]?.[1]).toBe(
      "action-conversation-1",
    );
    // Navigating closes the bell, so the panel is gone with it.
    expect(
      screen.queryByRole("heading", { name: "Gmail connected" }),
    ).toBeNull();
  });

  test("a second click while the first is in flight creates no second conversation", async () => {
    triggerActionRef.outcome = "pending";
    await openActionDetail();

    const action = screen.getByRole("button", { name: "Triage my inbox" });
    fireEvent.click(action);
    fireEvent.click(action);
    await act(async () => {});

    expect(triggerActionCalls).toEqual([
      { itemId: "first", actionId: "triage" },
    ]);
    expect(navigateToConversationMock).not.toHaveBeenCalled();
  });

  test("a failed action keeps the detail open and lets the user retry", async () => {
    triggerActionRef.outcome = "error";
    await openActionDetail();

    const action = screen.getByRole("button", { name: "Triage my inbox" });
    fireEvent.click(action);
    await act(async () => {});

    expect(navigateToConversationMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Gmail connected" }),
    ).toBeTruthy();

    fireEvent.click(action);
    await act(async () => {});

    expect(triggerActionCalls.length).toBe(2);
  });
});
