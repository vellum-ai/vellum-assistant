/**
 * Tests for `AssistantSideMenu`.
 *
 * Most tests render to the DOM and assert on the emitted markup. The client
 * render is what matters for anything that depends on the sidebar's layout
 * store: Zustand serves its *initial* state to `react-dom/server`, so a
 * server-rendered sidebar can only ever show the default view. Tests that
 * assert nothing view-dependent (the New Chat row) still use
 * `renderToStaticMarkup`.
 *
 * Interactive behavior (Show more, onSelect) is exercised by the SideMenu
 * primitive's own tests; here we verify the composition rules unique to
 * `AssistantSideMenu`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as reactRouter from "react-router";

// Shortcut hints follow the host OS; pin macOS so the glyph assertions below
// hold on Linux CI runners too.
Object.defineProperty(navigator, "platform", {
  value: "MacIntel",
  configurable: true,
});
import {
  SIDEBAR_SECTION_MAX_HEIGHT,
  SIDEBAR_STACK_GAP,
} from "@/components/sidebar-nav-geometry";

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

/* `AssistantSwitcher` (inside `SideMenuBuiltInNav`) reads the route and
   navigates after a successful switch, and its hooks run on every sidebar
   render; these tests mount no router, so hand it no-ops. */
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => () => {},
  useLocation: () => ({ pathname: "/assistant", search: "", hash: "" }),
}));

// The sidebar owns its Background/Scheduled lazy queries; stub both so static
// SSR rendering resolves without a QueryClient. These tests pass the full
// conversation list through `conversations` and assert the rendered buckets.
/* Every section asks the server for its own members, so the mock answers the
   way the server does: filter by `groupId`, which is single-valued per
   conversation. It MUST honor the filter. A mock that returned one fixed list
   would hand every section the same rows and quietly pass a sidebar that
   renders each conversation in every card. */
let sectionSource: Conversation[] = [];

function setSectionRows(conversations: Conversation[]) {
  sectionSource = conversations;
}

/**
 * Both filter axes, because a channel section constrains both: `system:all`
 * for "no group claimed it" AND its own `origin_channel`. Honoring only the
 * group would hand every channel card the whole ungrouped bucket.
 */
function rowsMatching(filter: ConversationListFilter): Conversation[] {
  if (filter.groupId === "system:pinned") {
    return sectionSource.filter((c) => c.isPinned);
  }
  return sectionSource.filter((c) => {
    if (c.isPinned) {
      return false;
    }
    const inGroup =
      filter.groupId === "system:all"
        ? c.groupId == null || c.groupId === "system:all"
        : c.groupId === filter.groupId;
    if (!inGroup) {
      return false;
    }
    if (filter.originChannel === undefined) {
      return true;
    }
    // "vellum" also claims rows that were never attributed, matching the
    // daemon's tolerant predicate.
    return filter.originChannel === "vellum"
      ? c.originChannel == null || c.originChannel === "vellum"
      : c.originChannel === filter.originChannel;
  });
}

mock.module(
  "@/hooks/conversation-queries",
  (): Partial<typeof ConversationQueries> => ({
    /* Feature-off: these tests exercise the derived-discovery path. */
    useSidebarSectionsQuery: () => null,
    useSectionConversationListQuery: (
      _assistantId: string | null,
      filter: ConversationListFilter | null,
    ): ConversationQueries.ConversationListQueryResult => ({
      conversations: filter === null ? [] : rowsMatching(filter),
      isLoading: false,
      isPending: false,
      isError: false,
      error: null,
      // A resolved query. Omitting this reads as falsy, which would send every
      // section back to its derived rows and pass these tests for the wrong
      // reason: green because nothing is filtered, not because it is.
      hasData: true,
      // A complete list: these tests exercise section rendering, not the
      // load-more path, and a stub window would mount sentinels under every
      // section.
      hasMore: false,
      refetch: () => {},
    }),
  }),
);

// Each section gates its fetch on the pod being reachable, which polls
// operational status through React Query; stub it so static SSR rendering
// resolves without a QueryClient. Open, because these tests are about what the
// sidebar draws from the rows it is handed, not about the gate. The gate's own
// behavior is covered in `assistant/operational-status.test.tsx`.
mock.module(
  "@/assistant/operational-status",
  (): Partial<typeof OperationalStatus> => ({
    useAssistantIsServing: () => true,
  }),
);

/* Pinned apps come from the daemon's app list. The pin list is a plain
   variable rather than seeded query data because `SideMenuUnderTest` builds its
   own QueryClient per render, so a test has nothing to seed. */
let pinnedAppsFixture: AppSummary[] = [];

mock.module(
  "@/hooks/use-pinned-apps",
  (): Partial<typeof UsePinnedApps> => ({
    usePinnedApps: () => ({
      pinnedApps: pinnedAppsFixture,
      pinnedAppIds: new Set(pinnedAppsFixture.map((app) => app.id)),
      source: "daemon" as const,
      togglePin: () => {},
      unpin: () => {},
      setColor: () => {},
    }),
  }),
);

// The assistant nav item reads the avatar through React Query; stub it so
// static SSR rendering resolves without a QueryClient.
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

import type * as ConversationQueries from "@/hooks/conversation-queries";
import type * as OperationalStatus from "@/assistant/operational-status";
import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import type { ConversationListFilter } from "@/utils/conversation-list-keys";
import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { CONVERSATION_LIST_VIRTUALIZE_THRESHOLD } from "@/domains/chat/components/conversation-nav-section";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";
import type * as UsePinnedApps from "@/hooks/use-pinned-apps";
import { makeAppSummary } from "@/types/app-summary.test-helper";
import type { AppSummary } from "@/types/app-types";

// Most of what follows describes the Grouped view's composition: the Chats
// section, the per-channel sections, and the peer treatment they share with
// Pinned and the custom groups. The layout store is a module singleton, so
// each test declares the view it exercises rather than inheriting one.
beforeEach(() => {
  // Per-assistant sidebar preferences (view, collapse, section order) all
  // live in localStorage, so a test that seeds one would otherwise carry it
  // into every test after it.
  localStorage.clear();
  localStorage.setItem("vellum:sidebar-view-mode:asst-1", "grouped");
  useSidebarLayoutStore.setState({
    assistantId: null,
    sectionOrder: [],
    openCategories: [],
    openCustomGroups: [],
  });
});

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    conversationId: overrides.conversationId ?? "k",
    ...overrides,
  };
}

/**
 * The component under test behind a QueryClientProvider.
 * `useSectionConversations` reads the query client for load-more and the
 * bulk-path drain, so every render needs the context even though the query
 * hooks themselves are mocked; a per-render client keeps tests isolated,
 * and hooks resolve under `renderToStaticMarkup` too.
 */
function SideMenuUnderTest(
  props: Parameters<typeof AssistantSideMenu>[0],
): ReturnType<typeof AssistantSideMenu> {
  return createElement(
    QueryClientProvider,
    {
      client: new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
    },
    createElement(AssistantSideMenu, props),
  );
}

function renderMenu(props: {
  conversations: Conversation[];
  conversationGroups?: ConversationGroup[];
  activeConversationId?: string;
  collapsed?: boolean;
  variant?: "rail" | "overlay";
  includeFooterAction?: boolean;
  includeTipCard?: boolean;
  isLoadingConversations?: boolean;
  conversationsFailed?: boolean;
  onRetryConversations?: () => void;
  onWidthChange?: (width: number) => void;
  includeNotificationsAction?: boolean;
}): string {
  setSectionRows(props.conversations);
  const includeFooterAction = props.includeFooterAction ?? true;
  const { container } = render(
    createElement(SideMenuUnderTest, {
      assistantId: "asst-1",
      collapsed: props.collapsed ?? false,
      variant: props.variant ?? "rail",
      conversations: props.conversations,
      isLoadingConversations: props.isLoadingConversations,
      conversationsFailed: props.conversationsFailed,
      onRetryConversations: props.onRetryConversations,
      conversationGroups: props.conversationGroups,
      activeConversationId: props.activeConversationId,
      width: props.onWidthChange ? 280 : undefined,
      onWidthChange: props.onWidthChange,
      onSelectConversation: () => {},
      footerAction: includeFooterAction
        ? createElement("span", null, "Preferences")
        : undefined,
      tipCard: props.includeTipCard
        ? createElement("span", null, "TipSentinel")
        : undefined,
      notificationsAction: props.includeNotificationsAction
        ? createElement("span", { "data-testid": "bell-stub" }, "Bell")
        : undefined,
    }),
  );
  const html = container.innerHTML;
  cleanup();
  return html;
}

describe("AssistantSideMenu · Chats category rows", () => {
  test("renders Pinned above Chats with bucket rows after recents", () => {
    const conversations = [
      makeConversation({ conversationId: "p1", isPinned: true }),
      makeConversation({
        conversationId: "p2",
        title: "Pinned thread",
        isPinned: true,
      }),
      makeConversation({ conversationId: "r1", title: "Recent thread" }),
    ];

    const html = renderMenu({ conversations });

    expect(html).toContain(">Chats<");
    expect(html).toContain(">Pinned<");
    expect(html).toContain(">Pinned thread<");
    expect(html).not.toContain(">Scheduled<");
    expect(html).not.toContain(">Background<");
    expect(html).toContain(">Recent thread<");
    expect(html).not.toContain(">Recents<");
    expect(html).not.toContain(">Slack<");

    expect(html.indexOf(">Pinned<")).toBeLessThan(html.indexOf(">Chats<"));
  });

  test("renders Slack as a conditional peer section after Recents", () => {
    const conversations = [
      makeConversation({ conversationId: "regular", title: "Regular thread" }),
      makeConversation({
        conversationId: "slack",
        title: "Slack thread",
        originChannel: "slack",
        groupId: "system:all",
      }),
    ];

    const html = renderMenu({ conversations });
    expect(html).toContain(">Slack<");
    expect(html).not.toContain(">Pinned<");

    const recentThreadIndex = html.indexOf(">Regular thread<");
    const slackIndex = html.indexOf(">Slack<");
    expect(recentThreadIndex).toBeGreaterThanOrEqual(0);
    expect(slackIndex).toBeGreaterThan(recentThreadIndex);
  });

  test("renders Pinned as a top-level section when non-empty", () => {
    const conversations = [
      makeConversation({ conversationId: "regular", title: "Regular thread" }),
      makeConversation({
        conversationId: "pinned",
        title: "Pinned thread",
        isPinned: true,
      }),
    ];

    const expandedHtml = renderMenu({ conversations });

    expect(expandedHtml).toContain(">Pinned<");
    expect(expandedHtml).toContain(">Pinned thread<");
    expect(expandedHtml.indexOf(">Pinned<")).toBeLessThan(
      expandedHtml.indexOf(">Chats<"),
    );
  });

  test("hides Pinned when there are no pinned conversations", () => {
    const conversations = [
      makeConversation({ conversationId: "regular", title: "Regular thread" }),
    ];

    const expandedHtml = renderMenu({ conversations });
    const collapsedHtml = renderMenu({ conversations, collapsed: true });

    expect(expandedHtml).not.toContain(">Pinned<");
    expect(collapsedHtml).not.toContain('aria-label="Pinned"');
  });

  test("omits chat count badges from the Chats section rows", () => {
    const conversations = [
      makeConversation({
        conversationId: "recent-alpha",
        title: "Recent Alpha",
      }),
      makeConversation({
        conversationId: "recent-beta",
        title: "Recent Beta",
      }),
    ];

    const html = renderMenu({ conversations });

    expect(html).toContain(">Chats<");
    expect(html).not.toContain(">2<");
    expect(html).not.toContain(">1<");
  });
});

describe("AssistantSideMenu · All view", () => {
  beforeEach(() => {
    localStorage.setItem("vellum:sidebar-view-mode:asst-1", "all");
    useSidebarLayoutStore.setState({ assistantId: null });
  });

  const conversations = [
    makeConversation({
      conversationId: "p1",
      title: "Pin one",
      isPinned: true,
    }),
    makeConversation({ conversationId: "r1", title: "Recent one" }),
    makeConversation({
      conversationId: "s1",
      title: "Slack one",
      originChannel: "slack",
    }),
  ];

  test("carries no 'Show more' affordance", () => {
    const html = renderMenu({
      conversations: Array.from({ length: 40 }, (_, index) =>
        makeConversation({
          conversationId: `r${index}`,
          title: `Recent ${index}`,
        }),
      ),
    });

    expect(html).not.toContain(">Show more<");
    expect(html).toContain('data-slot="virtual-list"');
  });

  // The grouping toggle used to be asserted here, because the "Conversations"
  // header that carried it was on screen in every view. It now belongs to the
  // Chats section's own menu, so it is asserted against both views together;
  // see the "channel grouping toggle" block below.

  test("the collapsed rail reaches the flat list through a Chats icon", () => {
    const html = renderMenu({ conversations, collapsed: true });

    expect(html).toContain('aria-label="Chats"');
    expect(html).toContain('aria-label="Pinned"');
  });
});

describe("AssistantSideMenu · drawer inset", () => {
  /* The rail is surfaceless - the cards and pills carry the surface - so the
     panel padding `SideMenu` gives a bordered rail would be a second inset
     stacked on the page layout's own, reading as bare space around the whole
     drawer. The overlay is a full-bleed sheet and keeps it. */
  test("the rail hands its horizontal inset to the cards, not the panel", () => {
    for (const collapsed of [false, true]) {
      const container = parse(
        renderMenu({
          conversations: [makeConversation({ conversationId: "r1" })],
          collapsed,
        }),
      );
      const nav = container.querySelector<HTMLElement>("nav");
      const body = container.querySelector<HTMLElement>(
        '[data-slot="side-menu-body"]',
      );
      if (!nav || !body) {
        throw new Error("expected the side menu root and body");
      }

      expect(nav.className).toContain("p-0");
      /* A bleeding scrollport would overhang a rail with no inset of its own
         and clip the cards against it. */
      expect(body.className).not.toContain("-mx-4");
    }
  });

  /* The handle occupies the rail's last 6px, and a section card is its own
     drag handle, so a card running under it would resize the rail on a grab
     meant to reorder the section. */
  test("a resizable rail holds the handle's strip clear of the cards", () => {
    const container = parse(
      renderMenu({
        conversations: [makeConversation({ conversationId: "r1" })],
        onWidthChange: () => {},
      }),
    );
    const nav = container.querySelector<HTMLElement>("nav");
    if (!nav) {
      throw new Error("expected the side menu root");
    }

    expect(nav.className).toContain("pr-[6px]");
  });

  test("the overlay keeps the sheet's own padding", () => {
    const container = parse(
      renderMenu({
        conversations: [makeConversation({ conversationId: "r1" })],
        variant: "overlay",
      }),
    );
    const nav = container.querySelector<HTMLElement>("nav");
    if (!nav) {
      throw new Error("expected the side menu root");
    }

    expect(nav.className).not.toContain("p-0");
  });
});

describe("AssistantSideMenu · scrollport top inset", () => {
  // The rail's scrollport carries no top padding of its own; the overlay
  // needs one though, because its first body child is the assistant cluster
  // and without it the cluster collides with the floating close and search
  // glyphs. So the inset lives on the cluster rather than the scrollport.
  test("the rail's scrollport carries no top inset", () => {
    const container = parse(
      renderMenu({
        conversations: [makeConversation({ conversationId: "r1" })],
      }),
    );
    const body = container.querySelector<HTMLElement>(
      '[data-slot="side-menu-body"]',
    );
    if (!body) {
      throw new Error("expected the side menu body");
    }

    expect(body.className).not.toContain("pt-3");
    expect(body.className).not.toContain("pt-4");
  });

  test("the overlay's assistant cluster keeps its inset off the glyph row", () => {
    const container = parse(
      renderMenu({
        conversations: [makeConversation({ conversationId: "r1" })],
        variant: "overlay",
      }),
    );
    const body = container.querySelector<HTMLElement>(
      '[data-slot="side-menu-body"]',
    );
    if (!body) {
      throw new Error("expected the side menu body");
    }

    // Not on the scrollport itself.
    expect(body.className).not.toContain(" pt-3");
    // On its first child, the assistant cluster.
    const cluster = body.firstElementChild;
    expect(cluster?.className).toContain("pt-3");
    expect(cluster?.textContent).toContain("Your Assistant");
  });
});

describe("AssistantSideMenu · section scrolling", () => {
  // Every section behaves like the flat list: no "Show more", the rows just
  // keep going inside a bounded, scrollable area. Without the cap one busy
  // section would push the ones under it off the screen.
  test("no section offers a Show more affordance", () => {
    const html = renderMenu({
      conversations: Array.from({ length: 40 }, (_, index) =>
        makeConversation({
          conversationId: `r${index}`,
          title: `Recent ${index}`,
        }),
      ),
    });

    expect(html).not.toContain(">Show more<");
    expect(html).not.toContain(">Show less<");
  });

  test("a long section scrolls within its own cap", () => {
    const container = parse(
      renderMenu({
        conversations: Array.from({ length: 40 }, (_, index) =>
          makeConversation({
            conversationId: `r${index}`,
            title: `Recent ${index}`,
          }),
        ),
      }),
    );

    const scrollport = container.querySelector<HTMLElement>(
      '[data-slot="collapsible"] .overflow-y-auto, [data-slot="collapsible"] [data-slot="virtual-list"]',
    );
    expect(scrollport).not.toBeNull();
  });
});

describe("AssistantSideMenu · active thread accessibility", () => {
  test("active conversation row sets aria-current=page", () => {
    const conversations = [
      makeConversation({
        conversationId: "a",
        title: "Alpha thread title",
      }),
      makeConversation({
        conversationId: "b",
        title: "Beta thread title",
      }),
    ];

    const html = renderMenu({
      conversations,
      activeConversationId: "b",
    });

    const sliceButtonAround = (title: string): string => {
      const titleIndex = html.indexOf(title);
      expect(titleIndex).toBeGreaterThanOrEqual(0);
      const buttonOpen = html.lastIndexOf("<button", titleIndex);
      expect(buttonOpen).toBeGreaterThanOrEqual(0);
      return html.slice(buttonOpen, titleIndex);
    };

    expect(sliceButtonAround("Beta thread title")).toContain(
      'aria-current="page"',
    );
    expect(sliceButtonAround("Alpha thread title")).not.toContain(
      "aria-current",
    );
  });
});

describe("AssistantSideMenu · footer slot behavior", () => {
  test("renders the footer slot when `footerAction` is provided", () => {
    const conversations = [
      makeConversation({ conversationId: "a", title: "Alpha" }),
    ];

    const html = renderMenu({ conversations });

    expect(html).toContain("Preferences");
  });

  test("omits the footer entirely when `footerAction` is undefined", () => {
    const conversations = [
      makeConversation({ conversationId: "a", title: "Alpha" }),
    ];

    const html = renderMenu({ conversations, includeFooterAction: false });

    expect(html).not.toContain("Preferences");
    expect(html).not.toContain('data-slot="side-menu-footer"');
  });
});

describe("AssistantSideMenu · tipCard slot", () => {
  const conversations = [
    makeConversation({ conversationId: "a", title: "Alpha" }),
  ];

  test("renders the rail footer as tip card, then footer action", () => {
    const html = renderMenu({ conversations, includeTipCard: true });

    const footerIndex = html.indexOf('data-slot="side-menu-footer"');
    const tipIndex = html.indexOf("TipSentinel");
    const actionIndex = html.indexOf("Preferences");
    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(tipIndex).toBeGreaterThan(footerIndex);
    expect(actionIndex).toBeGreaterThan(tipIndex);
  });

  /* The footer carries no rule, in either direction: not over the tip card
     and not between it and the action. Scoped to the footer rather than the
     whole tree so a separator elsewhere in the sidebar cannot mask a rule
     reappearing here. */
  test("the rail footer carries no separator", () => {
    const container = parse(
      renderMenu({ conversations, includeTipCard: true }),
    );

    const footer = container.querySelector<HTMLElement>(
      '[data-slot="side-menu-footer"]',
    );
    if (!footer) {
      throw new Error("expected the rail footer");
    }
    expect(
      footer.querySelectorAll('[data-slot="side-menu-separator"]'),
    ).toHaveLength(0);
  });

  test("hides the tip card on the collapsed rail", () => {
    const html = renderMenu({
      conversations,
      collapsed: true,
      includeTipCard: true,
    });

    expect(html).not.toContain("TipSentinel");
    // The footer action still renders when collapsed.
    expect(html).toContain("Preferences");
  });

  test("renders the footer when only the tip card is provided", () => {
    const html = renderMenu({
      conversations,
      includeFooterAction: false,
      includeTipCard: true,
    });

    expect(html).toContain('data-slot="side-menu-footer"');
    expect(html).toContain("TipSentinel");
    expect(html).not.toContain("Preferences");
  });

  test("renders the tip card in the overlay floating container above the action pills", () => {
    const html = renderMenu({
      conversations,
      variant: "overlay",
      includeTipCard: true,
    });

    const tipIndex = html.indexOf("TipSentinel");
    const actionIndex = html.indexOf("Preferences");
    expect(tipIndex).toBeGreaterThanOrEqual(0);
    expect(actionIndex).toBeGreaterThan(tipIndex);
    // The wrapper re-enables pointer events inside the pointer-events-none
    // container and collapses when the tip card renders null.
    const wrapperOpen = html.lastIndexOf("<div", tipIndex);
    const wrapper = html.slice(wrapperOpen, tipIndex);
    expect(wrapper).toContain("pointer-events-auto");
    expect(wrapper).toContain("empty:hidden");
  });

  test("omits the tip wrapper from the overlay when no tip card is provided", () => {
    const html = renderMenu({ conversations, variant: "overlay" });

    expect(html).not.toContain('data-slot="tip-card-wrapper"');
  });
});

describe("AssistantSideMenu · overlay bottom scroll reserve", () => {
  const conversations = [
    makeConversation({ conversationId: "a", title: "Alpha" }),
  ];

  const sliceBodyOpeningTag = (html: string): string => {
    const slotIndex = html.indexOf('data-slot="side-menu-body"');
    expect(slotIndex).toBeGreaterThanOrEqual(0);
    const open = html.lastIndexOf("<div", slotIndex);
    const close = html.indexOf(">", slotIndex);
    return html.slice(open, close + 1);
  };

  test("rail body reserves no bottom padding", () => {
    const tag = sliceBodyOpeningTag(renderMenu({ conversations }));

    expect(tag).not.toContain("pb-24");
    expect(tag).not.toContain("padding-bottom");
  });

  test("reserves the measured floating-column height once mounted", async () => {
    const originalGetBoundingClientRect =
      HTMLElement.prototype.getBoundingClientRect;
    const originalResizeObserver = globalThis.ResizeObserver;
    let measuredHeight = 132;
    let resizeCallback: ResizeObserverCallback | null = null;

    // Only the floating-column ref is measured by the reserve effect, so
    // matching by tip descendant is safe — ancestors are never measured.
    HTMLElement.prototype.getBoundingClientRect =
      function getBoundingClientRect() {
        if (this.querySelector('[data-testid="overlay-tip"]')) {
          return {
            bottom: measuredHeight,
            height: measuredHeight,
            left: 0,
            right: 0,
            top: 0,
            width: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          };
        }
        return originalGetBoundingClientRect.call(this);
      };
    // Other components in the tree construct their own ResizeObservers, so
    // capture the callback of the one observing the floating column rather
    // than whichever was constructed last.
    globalThis.ResizeObserver = class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        if (target.querySelector('[data-testid="overlay-tip"]')) {
          resizeCallback = this.callback;
        }
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const { container } = render(
        createElement(SideMenuUnderTest, {
          assistantId: "asst-1",
          collapsed: false,
          variant: "overlay",
          conversations,
          onSelectConversation: () => {},
          onStartNewConversation: () => {},
          footerAction: createElement("span", null, "Preferences"),
          tipCard: createElement(
            "span",
            { "data-testid": "overlay-tip" },
            "TipSentinel",
          ),
        }),
      );

      // happy-dom's CSSStyleDeclaration drops values containing `env()`,
      // so the composed `padding-bottom` calc is unobservable here; the
      // measured height feeding it is asserted via its custom property,
      // which happy-dom stores verbatim.
      const measuredReserve = () => {
        const body = container.querySelector<HTMLElement>(
          '[data-slot="side-menu-body"]',
        );
        return body?.style.getPropertyValue("--overlay-bottom-column-h") ?? "";
      };

      await waitFor(() => {
        expect(measuredReserve()).toBe("132px");
      });

      // Tip dismissal / copy-length changes resize the column; the
      // reserve tracks the new height through the ResizeObserver.
      measuredHeight = 56;
      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
      });
      await waitFor(() => {
        expect(measuredReserve()).toBe("56px");
      });
    } finally {
      HTMLElement.prototype.getBoundingClientRect =
        originalGetBoundingClientRect;
      globalThis.ResizeObserver = originalResizeObserver;
      cleanup();
    }
  });
});

describe("AssistantSideMenu · new conversation affordance", () => {
  const baseProps = {
    assistantId: "asst-1",
    collapsed: false,
    variant: "rail" as const,
    conversations: [makeConversation({ conversationId: "a", title: "Alpha" })],
    onSelectConversation: () => {},
  };

  test("renders the New Chat row (below the assistant row) when onStartNewConversation is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(SideMenuUnderTest, {
        ...baseProps,
        onStartNewConversation: () => {},
      }),
    );

    expect(html).toContain(">New Chat<");
    // It is a button row, not a navigation link.
    expect(html).not.toContain('<a aria-label="New Chat"');
    // The identity leads and the action hangs off it.
    expect(html.indexOf("Your Assistant")).toBeLessThan(
      html.indexOf(">New Chat<"),
    );
  });

  test("omits the New Chat row when onStartNewConversation is absent", () => {
    const html = renderToStaticMarkup(
      createElement(SideMenuUnderTest, { ...baseProps }),
    );

    expect(html).not.toContain(">New Chat<");
  });

  test("the overlay drawer omits the New Chat row — its floating pill owns the action", () => {
    const html = renderToStaticMarkup(
      createElement(SideMenuUnderTest, {
        ...baseProps,
        variant: "overlay" as const,
        onStartNewConversation: () => {},
      }),
    );

    // Exactly one "New Chat" — the floating pill (the overlay's only
    // new-chat affordance); a nav-row duplicate would add label + title.
    expect(html.match(/New Chat/g) ?? []).toHaveLength(1);
  });
});

describe("AssistantSideMenu · overlay close affordance", () => {
  test("renders an X close button on overlay variant only", () => {
    const conversations = [
      makeConversation({ conversationId: "a", title: "Alpha" }),
    ];
    const overlayHtml = renderMenu({ conversations, variant: "overlay" });
    const railHtml = renderMenu({ conversations, variant: "rail" });
    expect(overlayHtml).toContain('aria-label="Close navigation"');
    expect(railHtml).not.toContain('aria-label="Close navigation"');
  });

  test("keeps the search affordance in the overlay header", () => {
    const overlayHtml = renderMenu({ conversations: [], variant: "overlay" });
    expect(overlayHtml).toContain('aria-label="Search (⌘K)"');
  });
});

describe("AssistantSideMenu · native mobile floating glyph row", () => {
  // Class-presence pins only: they assert the markup still carries the
  // `native-mobile:` utilities, not that anything floats or composites.
  const conversations = [
    makeConversation({ conversationId: "a", title: "Alpha" }),
  ];

  const overlayDom = (): HTMLElement => {
    // A detached node, not a testing-library render: this only inspects
    // static markup, and mounting it would leave React's cleanup with a tree
    // it doesn't own.
    const container = document.createElement("div");
    container.innerHTML = renderMenu({ conversations, variant: "overlay" });
    return container;
  };

  const glyph = (container: HTMLElement, label: string): HTMLElement => {
    const match = container.querySelector<HTMLElement>(
      `[aria-label="${label}"]`,
    );
    if (!match) {
      throw new Error(`No overlay header glyph labelled "${label}"`);
    }
    return match;
  };

  // Whole class tokens, so an assertion matches a utility rather than a prefix
  // of one: `top-4` must not be satisfied by `top-40`.
  const classTokens = (element: Element | null): string[] =>
    element ? Array.from(element.classList) : [];

  test("the glyph row carries the floating placement utilities", () => {
    const container = overlayDom();
    // Queried by its own marker rather than walked up from a glyph, so the
    // row keeps its contract when the clusters inside it are regrouped.
    const row = classTokens(
      container.querySelector('[data-slot="side-menu-glyph-row"]'),
    );

    expect(row).toContain("native-mobile:absolute");
    expect(row).toContain("native-mobile:inset-x-3");
    expect(row).toContain("native-mobile:top-4");
    expect(row).toContain("native-mobile:z-10");
    expect(row).toContain("native-mobile:pointer-events-none");
  });

  test("both glyphs opt back into pointer events", () => {
    const container = overlayDom();

    expect(classTokens(glyph(container, "Close navigation"))).toContain(
      "pointer-events-auto",
    );
    expect(classTokens(glyph(container, "Search (⌘K)"))).toContain(
      "pointer-events-auto",
    );
  });

  test("search sits in the right cluster beside the notifications bell", () => {
    const container = document.createElement("div");
    container.innerHTML = renderMenu({
      conversations,
      variant: "overlay",
      includeNotificationsAction: true,
    });

    // Mirrors the chat header's right cluster: search directly left of the
    // bell, with the close glyph alone on the other side of the row.
    const cluster = glyph(container, "Search (⌘K)").parentElement;
    expect(cluster?.querySelector('[data-testid="bell-stub"]')).not.toBeNull();
    expect(
      cluster?.querySelector('[aria-label="Close navigation"]'),
    ).toBeNull();
  });

  test("the scroll body reserves the glyph band and carries both mask declarations", () => {
    const body = classTokens(
      overlayDom().querySelector('[data-slot="side-menu-body"]'),
    );

    // The reserve is the glyph row's own extent, measured off the 40px touch
    // target an icon-only Button takes on a coarse pointer (its 16px offset
    // plus that height, less the overlay inset this scrollport already sits
    // behind). Sizing it off the mock's 32px box instead leaves the bottom
    // 8px of each glyph over fully opaque content.
    expect(body).toContain("native-mobile:pt-11");
    // Complete declarations, so the fade geometry is pinned too: a different
    // stop or gradient direction is a different token. The stop tracks the
    // reserve, so a row is clear of the glyphs exactly when it is opaque.
    expect(body).toContain(
      "native-mobile:[mask-image:linear-gradient(to_bottom,transparent,black_2.75rem)]",
    );
    expect(body).toContain(
      "native-mobile:[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_2.75rem)]",
    );
  });
});

describe("AssistantSideMenu · overlay section card geometry", () => {
  // Class-presence pins: 12px vertical inset + 20px header row put the
  // collapsed section pill at the overlay tile size (44px), level with the
  // assistant pill.
  test("the overlay card and its header carry the 44px pill geometry", () => {
    const container = document.createElement("div");
    container.innerHTML = renderMenu({
      conversations: [makeConversation({ conversationId: "a", title: "Alpha" })],
      variant: "overlay",
    });

    const card = container.querySelector('[data-slot="card"]');
    const cardTokens = card ? Array.from(card.classList) : [];
    expect(cardTokens).toContain("rounded-[16px]");
    expect(cardTokens).toContain("pt-3");
    expect(cardTokens).toContain("pb-3");
    // Without this the Card's default transparent 1px border grows the
    // border-box to 46px.
    expect(cardTokens).toContain("border-0");

    const header = container.querySelector(
      '[data-slot="collapsible-nav-section-header"]',
    );
    const headerTokens = header ? Array.from(header.classList) : [];
    expect(headerTokens).toContain("h-5");
  });
});

describe("AssistantSideMenu · section header menus", () => {
  const conversations = [
    makeConversation({
      conversationId: "p1",
      title: "Pin one",
      isPinned: true,
    }),
    makeConversation({
      conversationId: "r1",
      title: "Recent one",
      hasUnseenLatestAssistantMessage: true,
    }),
    makeConversation({
      conversationId: "s1",
      title: "Slack one",
      originChannel: "slack",
    }),
  ];

  function renderWithGroupActions(capture?: {
    markAllRead?: (conversations: Conversation[]) => void;
    archiveAll?: (label: string, conversations: Conversation[]) => void;
  }) {
    return render(
      createElement(SideMenuUnderTest, {
        assistantId: "asst-1",
        collapsed: false,
        variant: "rail" as const,
        conversations,
        onSelectConversation: () => {},
        onMarkAllReadInGroup: capture?.markAllRead ?? (() => {}),
        onArchiveAllInGroup: capture?.archiveAll ?? (() => {}),
      }),
    );
  }

  function headerFor(container: HTMLElement, label: string): HTMLElement {
    const headers = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="collapsible-nav-section-header"]',
      ),
    );
    const match = headers.find((h) => h.textContent?.includes(label));
    if (!match) {
      throw new Error(`No section header for "${label}"`);
    }
    return match;
  }

  /**
   * Fire a header's Archive All and return the conversation ids it was handed.
   *
   * Asserting on the payload rather than the menu's text is the point: a
   * presence check passes whether the action covers the right conversations,
   * none of them, or the entire database. Archive All rather than Mark All as
   * Read because it is enabled for any non-empty section, so the assertion
   * turns on scope alone.
   */
  async function archiveScopeOf(
    container: HTMLElement,
    label: string,
    received: Array<[string, Conversation[]]>,
  ): Promise<string[]> {
    act(() => {
      headerFor(container, label).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
      );
    });
    let item: HTMLElement | undefined;
    await waitFor(() => {
      item = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((el) => el.textContent?.includes("Archive All"));
      expect(item).toBeDefined();
    });
    const before = received.length;
    act(() => {
      item!.click();
    });
    /* The handler fires after getAllRows() resolves (the section's full
       membership, LUM-2444), one microtask after the click; wait for it
       rather than reading synchronously. */
    await waitFor(() => {
      expect(received.length).toBeGreaterThan(before);
    });
    const last = received.at(-1);
    if (!last) {
      throw new Error(`Archive All under "${label}" fired no handler`);
    }
    return last[1].map((c) => c.conversationId).sort();
  }

  test("a section header covers only that section", async () => {
    localStorage.setItem("vellum:sidebar-view-mode:asst-1", "grouped");
    const received: Array<[string, Conversation[]]> = [];
    const { container } = renderWithGroupActions({
      archiveAll: (label, c) => received.push([label, c]),
    });
    try {
      expect(await archiveScopeOf(container, "Slack", received)).toEqual([
        "s1",
      ]);
      expect(await archiveScopeOf(container, "Pinned", received)).toEqual([
        "p1",
      ]);
    } finally {
      cleanup();
    }
  });

  test.each(["Pinned", "Chats", "Slack"])(
    "%s exposes the same bulk actions on right-click",
    async (label) => {
      const { container } = renderWithGroupActions();
      try {
        act(() => {
          headerFor(container, label).dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
          );
        });

        await waitFor(() => {
          const menu = document.querySelector('[role="menu"]');
          expect(menu?.textContent).toContain("Mark All as Read");
          expect(menu?.textContent).toContain("Archive All");
        });
      } finally {
        cleanup();
      }
    },
  );

  test("Mark All as Read is disabled for a section with nothing unread", async () => {
    const { container } = renderWithGroupActions();
    try {
      // Only the Chats conversation is unread; Pinned has none.
      act(() => {
        headerFor(container, "Pinned").dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
        );
      });

      await waitFor(() => {
        const items = Array.from(
          document.querySelectorAll('[role="menuitem"]'),
        );
        const markAllRead = items.find((el) =>
          el.textContent?.includes("Mark All as Read"),
        );
        const archiveAll = items.find((el) =>
          el.textContent?.includes("Archive All"),
        );
        expect(markAllRead).toBeDefined();
        expect(markAllRead?.getAttribute("aria-disabled")).toBe("true");
        // Pinned has a conversation, so the other bulk action stays enabled —
        // the disabled state tracks each action's own precondition.
        expect(archiveAll?.getAttribute("aria-disabled")).not.toBe("true");
      });
    } finally {
      cleanup();
    }
  });
});

/**
 * The channel-grouping toggle, which no longer has a home of its own.
 *
 * It used to sit behind a persistent "Conversations" header, so it was on
 * screen in every view and "can the user reach it?" was never a question. That
 * header is gone: the toggle now rides in the menu of the sections the switch
 * reshapes, which makes reachability a property of one section's menu in one
 * view, and something that can silently stop being true.
 *
 * It stopped being true twice on this PR, each time caught in review rather
 * than here: unreachable in All view, and later present on the header's
 * right-click menu but missing from the "…" popover and the mobile sheet,
 * which are built by a second function. So both views and both surfaces are
 * asserted, and by activation rather than presence: an item that is rendered
 * but wired to nothing is not reachable either (LUM-3120).
 *
 * The mobile sheet renders the popover's item set verbatim (one
 * `renderGroupMenuItemsAsPanelItems` call inside `GroupActionsMenu`), and
 * `group-actions-menu.test.tsx` holds that surface to the same items, so the
 * popover standing in for it here is not a gap.
 */
describe("AssistantSideMenu · channel grouping toggle", () => {
  const conversations = [
    makeConversation({ conversationId: "r1", title: "Recent one" }),
    makeConversation({
      conversationId: "s1",
      title: "Slack one",
      originChannel: "slack",
    }),
  ];

  /**
   * The label names the view the toggle *leaves for*, so asserting it also
   * asserts the section knows which view it is in. A toggle stuck on one label
   * is the failure this catches: it would still be present and still fire, but
   * would only ever describe one direction.
   */
  const LEAVES_FOR: Record<string, string> = {
    all: "Group by channel",
    grouped: "Ungroup",
  };

  const OTHER_VIEW: Record<string, string> = { all: "grouped", grouped: "all" };

  function renderInView(viewMode: string) {
    localStorage.setItem("vellum:sidebar-view-mode:asst-1", viewMode);
    // The layout store is a module singleton keyed by assistant; clearing the
    // id makes the next render re-read the view from localStorage.
    useSidebarLayoutStore.setState({ assistantId: null });
    setSectionRows(conversations);
    return render(
      createElement(SideMenuUnderTest, {
        assistantId: "asst-1",
        collapsed: false,
        variant: "rail" as const,
        conversations,
        onSelectConversation: () => {},
      }),
    );
  }

  function chatsHeader(container: HTMLElement): HTMLElement {
    const header = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="collapsible-nav-section-header"]',
      ),
    ).find((h) => h.textContent?.includes("Chats"));
    if (!header) {
      throw new Error("No Chats section header, so no menu to reach it from");
    }
    return header;
  }

  test.each(["all", "grouped"])(
    "right-clicking the Chats header reaches the toggle in %s view",
    async (viewMode) => {
      const { container } = renderInView(viewMode);
      try {
        act(() => {
          chatsHeader(container).dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
          );
        });

        let item: HTMLElement | undefined;
        await waitFor(() => {
          item = Array.from(
            document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
          ).find((el) => el.textContent?.includes(LEAVES_FOR[viewMode]!));
          expect(item).toBeDefined();
        });

        act(() => {
          item!.click();
        });
        // The switch is a persisted per-assistant preference, so the stored
        // value is where "it actually did something" is observable.
        expect(localStorage.getItem("vellum:sidebar-view-mode:asst-1")).toBe(
          OTHER_VIEW[viewMode],
        );
      } finally {
        cleanup();
      }
    },
  );

  test.each(["all", "grouped"])(
    "the Chats header's … menu reaches the toggle in %s view",
    async (viewMode) => {
      const { container } = renderInView(viewMode);
      try {
        /* The second surface, and the one that regressed: the popover and the
           mobile sheet are built from a different function than the
           right-click menu, so a new item added to one is not added to the
           other. Reached through the real trigger rather than by rendering
           the menu directly, because "the section has a … button at all" is
           part of what has to hold. */
        const trigger = container.querySelector<HTMLElement>(
          '[aria-label="Chats actions"]',
        );
        expect(trigger).not.toBeNull();
        act(() => {
          trigger?.click();
        });

        let row: HTMLElement | undefined;
        await waitFor(() => {
          row = Array.from(
            document.querySelectorAll<HTMLElement>('[role="button"]'),
          ).find((el) => el.textContent?.trim() === LEAVES_FOR[viewMode]);
          expect(row).toBeDefined();
        });

        act(() => {
          row!.click();
        });
        expect(localStorage.getItem("vellum:sidebar-view-mode:asst-1")).toBe(
          OTHER_VIEW[viewMode],
        );
      } finally {
        cleanup();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Section layout (LUM-2909)
// ---------------------------------------------------------------------------

const LAYOUT_CONVERSATIONS = [
  makeConversation({ conversationId: "p1", title: "Pin one", isPinned: true }),
  makeConversation({ conversationId: "r1", title: "Recent one" }),
  makeConversation({
    conversationId: "s1",
    title: "Slack one",
    originChannel: "slack",
    groupId: "system:all",
  }),
  makeConversation({
    conversationId: "g1",
    title: "Group one",
    groupId: "grp-a",
  }),
];

const LAYOUT_GROUPS = [
  { id: "grp-a", name: "Alpha", isSystemGroup: false },
] as unknown as ConversationGroup[];

/**
 * Parse rendered markup into a detached node. Not a testing-library render:
 * these assertions only inspect static markup, and mounting would leave
 * React's cleanup with a tree it doesn't own.
 */
function parse(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container;
}

function sectionElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-slot="collapsible-nav-section-section"]',
    ),
  );
}

/**
 * Each section's own card.
 *
 * The card is a section's outer box: it draws the surface, and it is the drag
 * handle and the drop target. So anything about where a section sits in the
 * stack, or what state a drag has put it in, is a fact about the card rather
 * than about the section element inside it.
 */
function sectionCards(container: HTMLElement): HTMLElement[] {
  return sectionElements(container).map((section) => {
    const card = section.closest<HTMLElement>('[data-slot="card"]');
    if (!card) {
      throw new Error("A section rendered outside a card");
    }
    return card;
  });
}

function sectionLabels(container: HTMLElement): (string | undefined)[] {
  return sectionElements(container).map((s) =>
    s
      .querySelector('[data-slot="collapsible-nav-section-header"]')
      ?.textContent?.trim(),
  );
}

describe("AssistantSideMenu · section spacing", () => {
  // One accordion root holds every section, so its gap is the only thing
  // separating them - no boundary can pick up the Body's larger gap instead,
  // and a custom group can sit between two built-in sections.
  test("every section type shares a single accordion root", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    // Every section is a top-level sibling. There is no persistent
    // "Conversations" header nesting Chats and the channel sections under a
    // second tier, so nothing sits at a different depth from anything else.
    expect(sectionLabels(container)).toEqual([
      "Pinned",
      "Alpha",
      "Chats",
      "Slack",
    ]);

    /* One parent for all of them, at one gap. Two tiers meant two gaps, and
       adjacent sections landing at different distances depending on which
       tier they were in is exactly what `SIDEBAR_STACK_GAP` exists to stop.
       Asserting the shared parent as well as the gap, since a single gap
       value proves nothing if the sections are still split across tiers.

       The sections are cards now, so they are the cards' siblings that share
       a parent, not the sections'. Reading the gap off the section elements'
       immediate parent would find each section's own card wrapper: four
       parents, and a gap declared on none of them. */
    const cards = sectionCards(container);
    expect(cards).toHaveLength(4);
    const parents = new Set(cards.map((card) => card.parentElement));
    expect(parents.size).toBe(1);
    expect([...parents][0]?.className).toContain(SIDEBAR_STACK_GAP);
  });
});

describe("AssistantSideMenu · section card surface", () => {
  /* A conversation row rests transparent, so on touch the swipe layer wrapping
     it is what actually paints behind the label. Left to its own default that
     layer takes the panel surface, which is a different colour from the card,
     and every row in the card reads as a sunken band. The card publishes its
     own fill so the layer matches whatever the card is. */
  test("every section card names the fill its swipeable rows sit on", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    const cards = sectionCards(container);
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.className).toContain(
        "[--swipe-reveal-bg:var(--surface-lift)]",
      );
    }
  });
});

describe("AssistantSideMenu · default section order", () => {
  // The point of LUM-2909: groups are the deliberate organization layer, so
  // they lead rather than sitting under channel sections that come and go.
  test("custom groups render above Chats and the channel sections", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    const labels = sectionLabels(container);
    expect(labels.indexOf("Alpha")).toBeLessThan(labels.indexOf("Chats"));
    expect(labels.indexOf("Alpha")).toBeLessThan(labels.indexOf("Slack"));
  });

  test("the collapsed rail lists the same sections in the same order", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
        collapsed: true,
      }),
    );

    // The rail renders icon tiles, so the section identity is in the label.
    const railLabels = Array.from(
      container.querySelectorAll<HTMLElement>("[aria-label]"),
    )
      .map((el) => el.getAttribute("aria-label"))
      .filter((label): label is string =>
        ["Pinned", "Alpha", "Chats", "Slack"].includes(label ?? ""),
      );

    expect(railLabels).toEqual(["Pinned", "Alpha", "Chats", "Slack"]);
  });
});

/* Membership in `sidebar.sections` and what renders are decided by one
   predicate. Were they two, a section could be listed while drawing
   nothing, and the header menu's move-up/move-down nudges count listed
   entries: the menu would offer a move that swapped with a section the
   user cannot see. */
describe("AssistantSideMenu · a listed section is a rendered section", () => {
  test("a custom group with no conversations still renders its header", () => {
    const html = renderMenu({
      conversations: [
        makeConversation({ conversationId: "r1", title: "Solo" }),
      ],
      conversationGroups: [
        {
          id: "grp-empty",
          name: "Fernweh",
          sortPosition: 0,
          isSystemGroup: false,
        },
      ],
    });

    // The group the user created is on screen even before anything is in it.
    // "New group…" otherwise completes leaving nothing to show for it.
    expect(html).toContain(">Fernweh<");
  });

  test("an empty group draws no curated rule, because nothing precedes it", () => {
    const html = renderMenu({
      conversations: [
        makeConversation({ conversationId: "r1", title: "Solo" }),
      ],
      conversationGroups: [
        {
          id: "grp-empty",
          name: "Fernweh",
          sortPosition: 0,
          isSystemGroup: false,
        },
      ],
    });
    const container = parse(html);

    // One curated section renders, so the rule below it is legitimate. What
    // must never happen is a rule with an empty tier above it, which is what
    // a counted-but-invisible section produces.
    const curated = container.querySelectorAll(
      '[data-slot="sidebar-section-rule"]',
    );
    if (curated.length > 0) {
      expect(html.indexOf(">Fernweh<")).toBeLessThan(
        html.indexOf('data-slot="sidebar-section-rule"'),
      );
    }
  });
});

describe("AssistantSideMenu · equal section treatment", () => {
  test("the rule is absent until something is curated", () => {
    const container = parse(
      renderMenu({
        conversations: [makeConversation({ conversationId: "r1" })],
      }),
    );

    // Scoped to the section list: the rail footer carries its own separator.
    const root = container.querySelector<HTMLElement>(
      '[data-slot="collapsible"]',
    );
    if (!root) {
      throw new Error("expected the section list's accordion root");
    }

    expect(
      root.querySelectorAll('[data-slot="sidebar-section-rule"]'),
    ).toHaveLength(0);
  });

  // The rail is one column of identical circles on one step - identity, New
  // Chat, the pinned apps and the section tiles alike - so it carries no rule
  // anywhere in it. A separator here would divide two halves of a column that
  // is uniform by construction, and the expanded rail dropped its own for the
  // same reason. Asserted against both pinned-app states because the rule
  // used to be conditional on them.
  test("the collapsed rail's header carries no separator, pinned apps or not", () => {
    for (const pinnedApps of [
      [],
      [makeAppSummary({ id: "app-1", name: "Vex Ops", pinSortPosition: 1 })],
    ]) {
      pinnedAppsFixture = pinnedApps;

      const container = parse(
        renderMenu({
          conversations: LAYOUT_CONVERSATIONS,
          conversationGroups: LAYOUT_GROUPS,
          collapsed: true,
        }),
      );

      const header = container.querySelector<HTMLElement>(
        '[data-slot="side-menu-header"]',
      );
      if (!header) {
        throw new Error("expected the rail's non-scrolling header");
      }

      expect(
        header.querySelectorAll('[data-slot="side-menu-separator"]'),
      ).toHaveLength(0);
    }

    pinnedAppsFixture = [];
  });

  // Pinned is the one section that doesn't cap: it grows to fit its own
  // rows (user-curated, expected to stay short). Every derived section -
  // Chats and each channel section - claims whatever space is left and
  // scrolls within itself, so a busy section can never push its
  // neighbours out of reach. Regression guard: a polish pass once unbound
  // Chats onto the sidebar body, which parked the channel sections below
  // hundreds of rows.
  test("Chats and channel sections cap/scroll internally; Pinned doesn't", () => {
    // A real DOM render, not `parse`: `scrollParent` only takes effect once
    // the sidebar body's ref has mounted.
    const { container } = render(
      createElement(SideMenuUnderTest, {
        assistantId: "asst-1",
        collapsed: false,
        variant: "rail",
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
        onSelectConversation: () => {},
      }),
    );
    try {
      // Channel sections default closed (only Pinned/Chats default open),
      // so Slack's row list isn't mounted until its header opens it. Going
      // through the title also exercises the whole-header toggle.
      const slackTrigger = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-slot="collapsible-nav-section-title"]',
        ),
      ).find((el) => el.textContent?.includes("Slack"));
      act(() => {
        slackTrigger?.click();
      });

      const sections = sectionElements(container);
      const labels = sectionLabels(container);
      const pinned = sections[labels.indexOf("Pinned")];
      const chats = sections[labels.indexOf("Chats")];
      const slack = sections[labels.indexOf("Slack")];
      if (!pinned || !chats || !slack) {
        throw new Error("expected Pinned, Chats, and Slack sections");
      }

      expect(pinned.querySelector(".overflow-y-auto")).toBeNull();
      expect(chats.querySelector(".overflow-y-auto")).not.toBeNull();
      expect(slack.querySelector(".overflow-y-auto")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  /**
   * Renders the rail for real (not `parse`): the sizing is decided by
   * `isLast`, and a section that defaults closed has no row list to size
   * until its header mounts one. `openSections` clicks the named headers
   * first - only Pinned and Chats default open.
   */
  function renderRail(openSections: string[] = []) {
    const { container } = render(
      createElement(SideMenuUnderTest, {
        assistantId: "asst-1",
        collapsed: false,
        variant: "rail",
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
        onSelectConversation: () => {},
      }),
    );
    for (const label of openSections) {
      const trigger = Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-slot="collapsible-nav-section-title"]',
        ),
      ).find((el) => el.textContent?.includes(label));
      act(() => {
        trigger?.click();
      });
    }
    const sections = sectionElements(container);
    const labels = sectionLabels(container);
    return (label: string): HTMLElement => {
      const scroller =
        sections[labels.indexOf(label)]?.querySelector<HTMLElement>(
          ".overflow-y-auto",
        );
      if (!scroller) {
        throw new Error(`expected a scrolling row list in "${label}"`);
      }
      return scroller;
    };
  }

  /*
   * The test above asks only whether a section scrolls, and every sized
   * section does - so it passes whether the bottom-most one fills the rail or
   * caps at 300px like the rest. That is the difference users see: capping the
   * bottom-most section is what left the rail's lower half empty in 0.11.3,
   * since Chats sits there and holds everything whenever channel grouping is
   * off. These two pin the difference itself.
   */
  test("the bottom-most section fills the rail; the ones above it cap", () => {
    // Grouped: Pinned, Alpha, Chats, Slack. Slack is bottom-most.
    const scroller = renderRail(["Slack"]);
    try {
      expect(scroller("Chats").style.maxHeight).toBe(
        `${SIDEBAR_SECTION_MAX_HEIGHT}px`,
      );
      // Fills what the flex column has left rather than committing to a
      // height of its own, so it reaches the footer on a tall rail.
      expect(scroller("Slack").classList.contains("flex-1")).toBe(true);
      expect(scroller("Slack").style.maxHeight).toBe("");
    } finally {
      cleanup();
    }
  });

  test("ungrouped, Chats is bottom-most and fills instead of capping", () => {
    // The reported 0.11.3 case: no channel sections, so Chats sits last and
    // holds every conversation the curated sections didn't claim.
    localStorage.setItem("vellum:sidebar-view-mode:asst-1", "all");
    const scroller = renderRail(["Alpha"]);
    try {
      expect(scroller("Chats").classList.contains("flex-1")).toBe(true);
      expect(scroller("Chats").style.maxHeight).toBe("");
      // Still capped, since Chats sits under it - the fill is positional, not
      // "every section grows now".
      expect(scroller("Alpha").style.maxHeight).toBe(
        `${SIDEBAR_SECTION_MAX_HEIGHT}px`,
      );
    } finally {
      cleanup();
    }
  });

  /*
   * Past CONVERSATION_LIST_VIRTUALIZE_THRESHOLD the bottom-most section
   * windows its rows through virtuoso, and a windowed list renders only what
   * fits its viewport: unlike mounted rows, it has no natural height of its
   * own. Its box therefore needs two things, and losing either blanks the
   * whole list while the caches stay fully populated: the accordion root must
   * forward the sidebar body's height down to the card's flex-fill, and the
   * box itself must floor at the section cap so a squeezed (or broken) chain
   * still yields a scrollable section rather than a zero-height one.
   */
  test("past the virtualize threshold, Chats windows into a bounded, filling box", () => {
    localStorage.setItem("vellum:sidebar-view-mode:asst-1", "all");
    const container = parse(
      renderMenu({
        conversations: Array.from(
          { length: CONVERSATION_LIST_VIRTUALIZE_THRESHOLD + 1 },
          (_, index) =>
            makeConversation({
              conversationId: `r${index}`,
              title: `Recent ${index}`,
            }),
        ),
      }),
    );

    const sections = sectionElements(container);
    const labels = sectionLabels(container);
    const chats = sections[labels.indexOf("Chats")];
    if (!chats) {
      throw new Error("expected the Chats section");
    }

    // The windowed path: virtuoso owns the rows, no mounted scroller.
    expect(chats.querySelector(".overflow-y-auto")).toBeNull();
    const windowed = chats.querySelector<HTMLElement>(
      '[data-slot="virtual-list"]',
    );
    if (!windowed?.parentElement) {
      throw new Error("expected the windowed row list and its sizing box");
    }

    const box = windowed.parentElement;
    expect(box.classList.contains("flex-1")).toBe(true);
    expect(box.style.minHeight).toBe(`${SIDEBAR_SECTION_MAX_HEIGHT}px`);

    // The fill above the floor only resolves if the accordion root passes
    // the body's height to the card's flex-fill.
    const root = container.querySelector<HTMLElement>(
      '[data-slot="collapsible"]',
    );
    expect(root?.classList.contains("flex-1")).toBe(true);
    expect(root?.classList.contains("min-h-0")).toBe(true);
  });

  test("every section renders through the same component with the same affordances", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    /* No exception any more. "Conversations" used to be a wrapper that was
       not itself a section - it did not drag and carried no icon - so this
       had to carve it out. Every section here is a real member of
       `sidebar.sections` and answers to the same rules. */
    const sections = sectionElements(container);
    expect(sections).toHaveLength(4);

    for (const section of sections) {
      /* Asked for via `closest` rather than on a named element: the drag
         handle is the card, and which node carries `draggable` is an
         implementation detail this should survive. What matters is that the
         section is draggable at all. */
      expect(section.closest('[draggable="true"]')).not.toBeNull();
      const header = section.querySelector<HTMLElement>(
        '[data-slot="collapsible-nav-section-header"]',
      );
      // A disclosure chevron, on every one.
      expect(header?.querySelector("svg")).not.toBeNull();
    }
  });
});

describe("AssistantSideMenu · section reordering", () => {
  test("a lone section isn't draggable - there's nothing to reorder against", () => {
    const container = parse(
      renderMenu({
        conversations: [makeConversation({ conversationId: "r1" })],
      }),
    );

    /* One section now: "Chats". The persistent "Conversations" wrapper that
       used to sit above it is gone, so this is the whole list, and a list of
       one has nothing to reorder against. */
    const sections = sectionElements(container);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.closest('[draggable="true"]')).toBeNull();
  });

  /* The card is the drag unit: the handle, the thing that dims while it moves,
     and the edge the insertion line lands on. One test for all three, because
     they are one fact. A section is a card now, so grabbing one should pick
     the whole object up; with the handle on the header the drag image was a
     lone header strip, reading as a conversation row rather than as the
     section being moved, and the insertion line was drawn on a box that was
     not the one being inserted against.

     Also a regression guard, for a bug the handlers' position used to cause
     and no longer does. They first sat on the section root, where `dragleave`
     bubbling up from the section's own conversation rows cleared the indicator
     every time the pointer crossed one, so dragging over an expanded section
     showed no drop target at all. They are back on a root with children (the
     card) and it is safe, because `use-drag-reorder` ignores a `dragleave`
     whose `relatedTarget` is inside `currentTarget` (`use-drag-reorder.ts`,
     `onDragLeave`) - the guard, not the position, is what holds this. */
  test("the card is the drag handle, the drag image and the drop edge", async () => {
    const { container } = render(
      createElement(SideMenuUnderTest, {
        assistantId: "asst-1",
        collapsed: false,
        variant: "rail" as const,
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
        onSelectConversation: () => {},
      }),
    );
    try {
      const headerFor = (label: string) =>
        Array.from(
          container.querySelectorAll<HTMLElement>(
            '[data-slot="collapsible-nav-section-header"]',
          ),
        ).find((h) => h.textContent?.includes(label))!;
      const cardFor = (label: string) =>
        headerFor(label).closest<HTMLElement>('[data-slot="card"]')!;

      /* The handle, before any drag starts. Every section, with no exception:
         "Conversations" used to be a wrapper that never dragged, and it is
         gone. The header must not also be draggable, or the two handles fight
         over the same gesture and the drag image is whichever won. */
      const cards = sectionCards(container);
      expect(cards).toHaveLength(4);
      for (const card of cards) {
        expect(card.getAttribute("draggable")).toBe("true");
        expect(
          card
            .querySelector<HTMLElement>(
              '[data-slot="collapsible-nav-section-header"]',
            )
            ?.getAttribute("draggable"),
        ).not.toBe("true");
      }

      // Minimal DataTransfer stand-in: `onDragStart` only sets an effect and
      // a payload (Firefox needs the latter to begin a drag at all).
      const dataTransfer = {
        effectAllowed: "",
        dropEffect: "",
        setData: () => {},
      };
      const fire = (el: HTMLElement, type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { dataTransfer, clientY: 10 });
        act(() => {
          el.dispatchEvent(event);
        });
      };

      // Dispatched on the header, which is where the pointer actually is: the
      // events have to reach the card by bubbling, so this covers the wiring
      // rather than only the handler.
      fire(headerFor("Alpha"), "dragstart");
      fire(headerFor("Chats"), "dragover");

      /* A zero-height rect in the test DOM puts the pointer past the midpoint,
         so the insertion line lands on the trailing edge. On the card, and on
         the card only: the section box inside it is inset from the card's own
         edge, so a line drawn there reads as landing *inside* the section
         rather than after it. */
      expect(cardFor("Chats").className).toContain("inset_0_-2px");
      expect(
        headerFor("Chats").closest<HTMLElement>(
          '[data-slot="collapsible-nav-section-section"]',
        )?.className,
      ).not.toContain("inset_0_-2px");

      // The dragged card dims - deferred one tick past `dragstart` on
      // purpose, because re-rendering the dragged node inside the dragstart
      // dispatch cancels the drag in Chromium.
      await waitFor(() => {
        const dimmed = sectionCards(container).filter((card) =>
          card.className.includes("opacity-50"),
        );
        expect(dimmed).toHaveLength(1);
        expect(dimmed[0]?.textContent).toContain("Alpha");
      });
    } finally {
      cleanup();
    }
  });

  /* Drag events fire on neither touch nor the keyboard, so the header menu
     carries the same reordering.

     The layout is Pinned, Alpha, Chats, Slack, and the only thing that
     constrains a move now is the end of the list: the ends offer one direction
     and everything between them offers both. Alpha and Chats used to offer one
     each as well, because they straddled a curated/governed tier boundary that
     no move could cross - the constraint that made a custom group and the chat
     list different kinds of thing. It is gone, so any section can sit
     anywhere, and the menu says so.

     Absence is the disabled state here: a section at an end is offered no move
     in that direction rather than a greyed-out one, so these lists are
     exhaustive on purpose. */
  test.each([
    ["Pinned", ["Move Section Down"]],
    ["Alpha", ["Move Section Up", "Move Section Down"]],
    ["Chats", ["Move Section Up", "Move Section Down"]],
    ["Slack", ["Move Section Up"]],
  ])(
    "%s offers the move actions its position allows",
    async (label, expected) => {
      const { container } = render(
        createElement(SideMenuUnderTest, {
          assistantId: "asst-1",
          collapsed: false,
          variant: "rail" as const,
          conversations: LAYOUT_CONVERSATIONS,
          conversationGroups: LAYOUT_GROUPS,
          onSelectConversation: () => {},
        }),
      );
      try {
        const header = Array.from(
          container.querySelectorAll<HTMLElement>(
            '[data-slot="collapsible-nav-section-header"]',
          ),
        ).find((h) => h.textContent?.includes(label));

        act(() => {
          header?.dispatchEvent(
            new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
          );
        });

        await waitFor(() => {
          const items = Array.from(
            document.querySelectorAll('[role="menuitem"]'),
          ).map((el) => el.textContent);
          const moveItems = items.filter((text) =>
            text?.startsWith("Move Section"),
          );
          expect(moveItems).toEqual(expected);
        });
      } finally {
        cleanup();
      }
    },
  );
});

/**
 * The conversation list resolves only once every page of it has been fetched,
 * so "still loading" is a state the sidebar sits in for seconds on a cold
 * load. Its natural rendering is an empty scrollport, which is also what "this
 * assistant has no conversations" looks like. These assert the two stay
 * distinguishable, and that a refetch never blanks a sidebar that already has
 * rows.
 */
describe("AssistantSideMenu · conversation list loading state", () => {
  const SKELETON = 'data-slot="sidebar-conversation-skeleton"';

  test("draws placeholder rows while the first load is in flight", () => {
    const html = renderMenu({
      conversations: [],
      isLoadingConversations: true,
    });

    expect(html).toContain(SKELETON);
    // The section tree is what the placeholders stand in for, so it must not
    // render alongside them.
    expect(html).not.toContain(">Chats<");
  });

  test("draws no placeholders once an empty list has loaded", () => {
    // The sensitivity check on the test above: an assistant with genuinely no
    // conversations must not sit under placeholders forever. This is the
    // assertion that fails if the skeleton renders unconditionally.
    const html = renderMenu({
      conversations: [],
      isLoadingConversations: false,
    });

    expect(html).not.toContain(SKELETON);
  });

  test("keeps live rows during a refetch instead of reverting to placeholders", () => {
    // `isLoadingConversations` is true here, but the cache is already
    // populated, so the rows win. Guards against a background refresh
    // flashing the sidebar back to placeholders mid-session.
    const html = renderMenu({
      conversations: [
        makeConversation({ conversationId: "r1", title: "Recent thread" }),
      ],
      isLoadingConversations: true,
    });

    expect(html).not.toContain(SKELETON);
    expect(html).toContain(">Recent thread<");
  });
});

/**
 * A conversation list that failed before it ever loaded renders the same empty
 * scrollport as an assistant with no conversations: every section derives from
 * this list, and an empty section is dropped from the sidebar. These assert
 * the failure stays visible as a failure, and that it never displaces rows the
 * sidebar already holds.
 */
describe("AssistantSideMenu · conversation list failure state", () => {
  const ERROR = 'data-slot="sidebar-conversation-error"';
  const SKELETON = 'data-slot="sidebar-conversation-skeleton"';

  test("draws the failure instead of an empty section tree", () => {
    const html = renderMenu({
      conversations: [],
      conversationsFailed: true,
    });

    expect(html).toContain(ERROR);
    // The empty tree is what this stands in for, so it must not render too.
    expect(html).not.toContain(">Chats<");
  });

  test("offers a retry when one is wired", () => {
    const html = renderMenu({
      conversations: [],
      conversationsFailed: true,
      onRetryConversations: () => {},
    });

    expect(html).toContain("Try again");
  });

  test("draws no failure once an empty list has loaded", () => {
    // The sensitivity check: an assistant with genuinely no conversations must
    // not be told its list failed.
    const html = renderMenu({
      conversations: [],
      conversationsFailed: false,
    });

    expect(html).not.toContain(ERROR);
  });

  test("keeps live rows when a refetch fails", () => {
    // React Query holds the last successful data through a failed refetch, so
    // those rows are still the real list and must beat the failure state.
    const html = renderMenu({
      conversations: [
        makeConversation({ conversationId: "r1", title: "Recent thread" }),
      ],
      conversationsFailed: true,
    });

    expect(html).not.toContain(ERROR);
    expect(html).toContain(">Recent thread<");
  });

  test("prefers the failure over placeholders when both are set", () => {
    // A retry puts the query back in flight while it still holds the previous
    // failure. Reverting to placeholders would re-hide that the list failed.
    const html = renderMenu({
      conversations: [],
      conversationsFailed: true,
      isLoadingConversations: true,
    });

    expect(html).toContain(ERROR);
    expect(html).not.toContain(SKELETON);
  });
});
