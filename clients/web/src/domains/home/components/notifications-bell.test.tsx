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

mock.module("react-router", () => ({
  useNavigate: () => () => {},
  useLocation: () => ({
    pathname: "/assistant/conversations/c1",
    search: "",
    hash: "",
    state: null,
    key: "test-key",
  }),
}));

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

async function openBell(): Promise<void> {
  render(<NotificationsBell />);
  fireEvent.click(screen.getByRole("button", { name: /^Notifications/ }));
  // Radix measures and positions the panel after the click, off a promise.
  await act(async () => {});
}

beforeEach(() => {
  isMobileRef.value = false;
  feedRef.items = [];
});

afterEach(() => {
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
    expect(screen.getByRole("button", { name: "View all" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Mark all as read" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeTruthy();
  });
});
