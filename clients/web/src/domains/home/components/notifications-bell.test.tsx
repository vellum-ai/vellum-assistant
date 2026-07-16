/**
 * Tests for `NotificationsBell`.
 *
 * Uses `renderToStaticMarkup` (SSR) like `preferences-menu.test.tsx`: only
 * the trigger is exercisable — Radix Popover/BottomSheet content is not
 * rendered when `open={false}`. The unread dot lives on the trigger, so
 * that's exactly the surface these tests pin down.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
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

// The same amber dot HomeRecapRow puts on unread rows, top-left of the bell.
const UNREAD_DOT_CLASS = "-left-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--system-mid-strong)]";

function feedItem(overrides: Partial<FeedItem>): FeedItem {
  return {
    id: "item-1",
    type: "notification",
    priority: 50,
    summary: "Something happened",
    timestamp: "2026-07-16T10:00:00Z",
    createdAt: "2026-07-16T10:00:00Z",
    status: "new",
    ...overrides,
  };
}

function renderBell(): string {
  return renderToStaticMarkup(createElement(NotificationsBell));
}

beforeEach(() => {
  isMobileRef.value = false;
  feedRef.items = [];
});

describe("NotificationsBell unread dot", () => {
  test("shows the dot when an unread notification exists", () => {
    feedRef.items = [feedItem({ status: "new" })];
    const html = renderBell();
    expect(html).toContain(UNREAD_DOT_CLASS);
    expect(html).toContain("Notifications (unread)");
  });

  test("hides the dot when every notification has been read", () => {
    feedRef.items = [
      feedItem({ id: "a", status: "seen" }),
      feedItem({ id: "b", status: "acted_on" }),
    ];
    const html = renderBell();
    expect(html).not.toContain(UNREAD_DOT_CLASS);
    expect(html).toContain("Notifications");
    expect(html).not.toContain("(unread)");
  });

  test("hides the dot when the feed is empty", () => {
    const html = renderBell();
    expect(html).not.toContain(UNREAD_DOT_CLASS);
  });

  test("ignores unread items that the popover never shows", () => {
    // Dismissed and high-urgency items are filtered out of the list, so
    // they must not light a dot the panel can't explain.
    feedRef.items = [
      feedItem({ id: "a", status: "dismissed" }),
      feedItem({ id: "b", status: "new", urgency: "high" }),
    ];
    const html = renderBell();
    expect(html).not.toContain(UNREAD_DOT_CLASS);
  });

  test("mobile trigger carries the same dot", () => {
    isMobileRef.value = true;
    feedRef.items = [feedItem({ status: "new" })];
    const html = renderBell();
    expect(html).toContain(UNREAD_DOT_CLASS);
  });
});
