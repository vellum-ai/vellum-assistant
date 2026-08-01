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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// The sidebar owns its Background/Scheduled lazy queries; stub both so static
// SSR rendering resolves without a QueryClient. These tests pass the full
// conversation list through `conversations` and assert the rendered buckets.
mock.module("@/hooks/conversation-queries", () => ({
  useBackgroundConversationListQuery: () => ({
    conversations: [],
    isPending: false,
  }),
  useScheduledConversationListQuery: () => ({
    conversations: [],
    isPending: false,
  }),
}));

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

import type {
  Conversation,
  ConversationGroup,
} from "@/types/conversation-types";
import { AssistantSideMenu } from "@/domains/chat/components/assistant-side-menu";
import { useSidebarLayoutStore } from "@/domains/chat/sidebar-layout-store";

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

function renderMenu(props: {
  conversations: Conversation[];
  conversationGroups?: ConversationGroup[];
  activeConversationId?: string;
  collapsed?: boolean;
  variant?: "rail" | "overlay";
  includeFooterAction?: boolean;
  includeTipCard?: boolean;
}): string {
  const includeFooterAction = props.includeFooterAction ?? true;
  const { container } = render(
    createElement(AssistantSideMenu, {
      assistantId: "asst-1",
      collapsed: props.collapsed ?? false,
      variant: props.variant ?? "rail",
      conversations: props.conversations,
      conversationGroups: props.conversationGroups,
      activeConversationId: props.activeConversationId,
      onSelectConversation: () => {},
      footerAction: includeFooterAction
        ? createElement("span", null, "Preferences")
        : undefined,
      tipCard: props.includeTipCard
        ? createElement("span", null, "TipSentinel")
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
    makeConversation({ conversationId: "p1", title: "Pin one", isPinned: true }),
    makeConversation({ conversationId: "r1", title: "Recent one" }),
    makeConversation({
      conversationId: "s1",
      title: "Slack one",
      originChannel: "slack",
    }),
  ];

  // Short lists mount their rows directly, so this can assert what actually
  // renders. The windowed path is covered below, where virtuoso emits no rows
  // without real layout and only its presence can be asserted.
  test("drops the Chats and channel headers in favour of one flat list", () => {
    const html = renderMenu({ conversations });

    expect(html).not.toContain(">Chats<");
    expect(html).not.toContain(">Slack<");
    expect(html).toContain(">Pinned<");
    expect(html).not.toContain('data-slot="virtual-list"');
    // The channel conversation is in the flat list, not a channel section.
    expect(html).toContain("Slack one");
    expect(html).toContain("Recent one");
  });

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

  // A stored order that would lift Chats above the curated layer is pulled
  // back, so the tiers hold however the order was arrived at.
  test("a stored order that lifts Chats above a group is pulled back", () => {
    localStorage.setItem("vellum:sidebar-view-mode:asst-1", "grouped");
    localStorage.setItem(
      "vellum:sidebar-section-order:asst-1",
      JSON.stringify(["recents", "grp-a", "channel:slack"]),
    );
    useSidebarLayoutStore.setState({ assistantId: null });

    const container = parse(
      renderMenu({
        conversations: [
          makeConversation({ conversationId: "r1", title: "Recent one" }),
          makeConversation({
            conversationId: "g1",
            title: "Group one",
            groupId: "grp-a",
          }),
        ],
        conversationGroups: [
          { id: "grp-a", name: "Alpha", isSystemGroup: false },
        ] as unknown as ConversationGroup[],
      }),
    );

    const root = container.querySelector<HTMLElement>(
      '[data-slot="collapsible"]',
    );
    if (!root) {
      throw new Error("expected the section list's accordion root");
    }
    const children = Array.from(root.children);
    const indexOfText = (text: string) =>
      children.findIndex((el) => (el.textContent ?? "").includes(text));

    expect(indexOfText("Alpha")).toBeLessThan(indexOfText("Chats"));
  });

  test("offers the view switch", () => {
    const html = renderMenu({ conversations });

    expect(html).toContain('aria-label="Conversation list view"');
    expect(html).toContain(">All<");
    expect(html).toContain(">Groups<");
  });

  test("the collapsed rail reaches the flat list through a Chats icon", () => {
    const html = renderMenu({ conversations, collapsed: true });

    expect(html).toContain('aria-label="Chats"');
    expect(html).toContain('aria-label="Pinned"');
  });
});

describe("AssistantSideMenu · scrollport top inset", () => {
  // The sticky view switch sticks to the scrollport's *content* box, so the
  // body carries no top padding: any there would park the switch that far
  // down and open a strip above it for rows to scroll through. The overlay
  // still needs the inset though, because its first body child is the
  // assistant cluster rather than the switch, and without it the cluster
  // collides with the floating close and search glyphs. So the inset moves
  // onto the cluster rather than disappearing.
  test("the rail's scrollport carries no top inset", () => {
    const container = parse(
      renderMenu({ conversations: [makeConversation({ conversationId: "r1" })] }),
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

  test("renders the rail footer as tip card, then divider, then footer action", () => {
    const html = renderMenu({ conversations, includeTipCard: true });

    const footerIndex = html.indexOf('data-slot="side-menu-footer"');
    const tipIndex = html.indexOf("TipSentinel");
    const separatorIndex = html.indexOf(
      'data-slot="side-menu-separator"',
      tipIndex,
    );
    const actionIndex = html.indexOf("Preferences");
    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(tipIndex).toBeGreaterThan(footerIndex);
    // The divider sits BETWEEN the tip card and the footer action, never
    // above the tip.
    expect(separatorIndex).toBeGreaterThan(tipIndex);
    expect(actionIndex).toBeGreaterThan(separatorIndex);
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

    expect(html).not.toContain("empty:hidden");
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
        createElement(AssistantSideMenu, {
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
      createElement(AssistantSideMenu, {
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
      createElement(AssistantSideMenu, { ...baseProps }),
    );

    expect(html).not.toContain(">New Chat<");
  });

  test("the overlay drawer omits the New Chat row — its floating pill owns the action", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantSideMenu, {
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

describe("AssistantSideMenu · overlay iOS floating glyph row", () => {
  // Class-presence pins only: they assert the markup still carries the
  // `native-ios:` utilities, not that anything floats or composites.
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
    const row = classTokens(glyph(container, "Close navigation").parentElement);

    expect(row).toContain("native-ios:absolute");
    expect(row).toContain("native-ios:inset-x-4");
    expect(row).toContain("native-ios:top-4");
    expect(row).toContain("native-ios:z-10");
    expect(row).toContain("native-ios:pointer-events-none");
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

  test("the scroll body reserves the glyph band and carries both mask declarations", () => {
    const body = classTokens(
      overlayDom().querySelector('[data-slot="side-menu-body"]'),
    );

    expect(body).toContain("native-ios:pt-14");
    // Complete declarations, so the fade geometry is pinned too: a different
    // stop or gradient direction is a different token.
    expect(body).toContain(
      "native-ios:[mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)]",
    );
    expect(body).toContain(
      "native-ios:[-webkit-mask-image:linear-gradient(to_bottom,transparent,black_3.5rem)]",
    );
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

  function renderWithGroupActions() {
    return render(
      createElement(AssistantSideMenu, {
        assistantId: "asst-1",
        collapsed: false,
        variant: "rail" as const,
        conversations,
        onSelectConversation: () => {},
        onMarkAllReadInGroup: () => {},
        onArchiveAllInGroup: () => {},
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

  // Every section header carries the same bulk actions, Pinned and Chats
  // included — not just the channel sections.
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
  makeConversation({ conversationId: "g1", title: "Group one", groupId: "grp-a" }),
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

    const sections = sectionElements(container);
    expect(sectionLabels(container)).toEqual([
      "Pinned",
      "Alpha",
      "Chats",
      "Slack",
    ]);

    // All four are siblings - one shared parent, so one shared gap.
    const parents = new Set(sections.map((s) => s.parentElement));
    expect(parents.size).toBe(1);
    expect([...parents][0]?.className).toContain("gap-3");
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

describe("AssistantSideMenu · equal section treatment", () => {
  // Custom groups are peers of Pinned, Chats, and the channel sections - not
  // a separate class. Nothing in the list may imply a grouping the user
  // didn't create, because they order these however they like.
  // One rule in the list, and it is not a section break: it marks where the
  // user's curation ends and the conversations begin. Two sections never have
  // a rule between them, whatever their type.
  test("the only rule follows the curated sections", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    const root = container.querySelector<HTMLElement>(
      '[data-slot="collapsible"]',
    );
    if (!root) {
      throw new Error("expected the section list's accordion root");
    }
    const children = Array.from(root.children);
    const indexOfText = (text: string) =>
      children.findIndex((el) => (el.textContent ?? "").includes(text));
    const ruleIndex = children.findIndex((el) =>
      el.matches('[data-slot="sidebar-section-resize-handle"]'),
    );

    expect(
      root.querySelectorAll('[data-slot="sidebar-section-resize-handle"]'),
    ).toHaveLength(1);
    // Pinned and Alpha above it, Chats and Slack below.
    expect(indexOfText("Pinned")).toBeLessThan(ruleIndex);
    expect(indexOfText("Alpha")).toBeLessThan(ruleIndex);
    expect(indexOfText("Chats")).toBeGreaterThan(ruleIndex);
    expect(indexOfText("Slack")).toBeGreaterThan(ruleIndex);
    // Pinned is present and open by default, so the rule drags.
    expect(children[ruleIndex]?.hasAttribute("data-resizable")).toBe(true);
  });

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
      root.querySelectorAll('[data-slot="sidebar-section-resize-handle"]'),
    ).toHaveLength(0);
  });

  // The rule only drags while there is a Pinned section to resize; a custom
  // group alone still earns the rule, but an inert one.
  test("the rule is inert when groups are curated without pins", () => {
    const container = parse(
      renderMenu({
        conversations: [
          makeConversation({ conversationId: "r1" }),
          makeConversation({
            conversationId: "g1",
            title: "Group one",
            groupId: "grp-a",
          }),
        ],
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    const rule = container.querySelector<HTMLElement>(
      '[data-slot="sidebar-section-resize-handle"]',
    );
    if (!rule) {
      throw new Error("expected the curated block's rule");
    }

    expect(rule.hasAttribute("data-resizable")).toBe(false);
  });

  // The switch sits outside the section list, ahead of it: a sticky element
  // only holds while its own containing block is on screen, and the section
  // list ends where the flat list begins.
  test("the view switch leads the whole list and sticks", () => {
    const html = renderMenu({
      conversations: LAYOUT_CONVERSATIONS,
      conversationGroups: LAYOUT_GROUPS,
    });

    expect(html.indexOf('data-slot="segment-control"')).toBeLessThan(
      html.indexOf('data-slot="collapsible"'),
    );

    const container = parse(html);
    const wrapper = container
      .querySelector('[data-slot="segment-control"]')
      ?.closest("div.sticky");
    expect(wrapper).not.toBeNull();
  });

  test("every section renders through the same component with the same affordances", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    const sections = sectionElements(container);
    expect(sections).toHaveLength(4);

    for (const section of sections) {
      const header = section.querySelector<HTMLElement>(
        '[data-slot="collapsible-nav-section-header"]',
      );
      // Draggable header (the reorder handle) and a leading icon, on all four.
      expect(header?.getAttribute("draggable")).toBe("true");
      expect(header?.querySelector("svg")).not.toBeNull();
    }
  });
});

describe("AssistantSideMenu · section reordering", () => {
  test("section headers are drag handles", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    const headers = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="collapsible-nav-section-header"]',
      ),
    );
    expect(headers).toHaveLength(4);
    expect(headers.every((h) => h.getAttribute("draggable") === "true")).toBe(
      true,
    );
  });

  test("a lone section isn't draggable - there's nothing to reorder against", () => {
    const container = parse(
      renderMenu({
        conversations: [makeConversation({ conversationId: "r1" })],
      }),
    );

    const headers = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="collapsible-nav-section-header"]',
      ),
    );
    expect(headers).toHaveLength(1);
    expect(headers[0]?.getAttribute("draggable")).toBeNull();
  });

  // Regression guard. The handlers first sat on the section root, where
  // `dragleave` bubbling up from the section's own conversation rows cleared
  // the indicator every time the pointer crossed one - so dragging over an
  // expanded section showed no drop target at all. Keeping them on the header
  // is what fixes it, and only an event-level test can tell the difference.
  test("dragging over a section header marks it as the drop target", async () => {
    const { container } = render(
      createElement(AssistantSideMenu, {
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

      // Minimal DataTransfer stand-in: `onDragStart` only sets an effect and
      // a payload (Firefox needs the latter to begin a drag at all).
      const dataTransfer = { effectAllowed: "", dropEffect: "", setData: () => {} };
      const fire = (el: HTMLElement, type: string) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { dataTransfer, clientY: 10 });
        act(() => {
          el.dispatchEvent(event);
        });
      };

      fire(headerFor("Alpha"), "dragstart");
      fire(headerFor("Chats"), "dragover");

      const chatsSection = headerFor("Chats").closest(
        '[data-slot="collapsible-nav-section-section"]',
      );
      // A zero-height rect in the test DOM puts the pointer past the midpoint,
      // so the insertion line lands on the trailing edge.
      expect(chatsSection?.className).toContain("inset_0_-2px");

      // The dragged section dims - deferred one tick past `dragstart` on
      // purpose, because re-rendering the dragged node inside the dragstart
      // dispatch cancels the drag in Chromium.
      await waitFor(() => {
        const dimmed = Array.from(
          container.querySelectorAll(
            '[data-slot="collapsible-nav-section-section"]',
          ),
        ).filter((el) => el.className.includes("opacity-50"));
        expect(dimmed).toHaveLength(1);
        expect(dimmed[0]?.textContent).toContain("Alpha");
      });
    } finally {
      cleanup();
    }
  });

  // Drag events fire on neither touch nor the keyboard, so the header menu
  // carries the same reordering.
  // The layout is Pinned, Alpha, Chats, Slack: two curated sections then two
  // governed ones. A section is offered only the moves that stay inside its
  // own tier, so the pair at the boundary (Alpha, Chats) each offer one
  // direction just like the pair at the ends (Pinned, Slack).
  test.each([
    ["Pinned", ["Move Section Down"]],
    ["Alpha", ["Move Section Up"]],
    ["Chats", ["Move Section Down"]],
    ["Slack", ["Move Section Up"]],
  ])(
    "%s offers the move actions its position allows",
    async (label, expected) => {
      const { container } = render(
        createElement(AssistantSideMenu, {
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
