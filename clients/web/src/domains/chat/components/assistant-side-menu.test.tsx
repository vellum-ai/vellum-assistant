/**
 * Tests for `AssistantSideMenu`.
 *
 * Rendering goes through `react-dom/server` — assertions look at the
 * emitted markup. Interactive behavior (Show more, onSelect) is exercised
 * by the SideMenu primitive's own tests; here we verify the composition
 * rules unique to `AssistantSideMenu`.
 */

import { describe, expect, mock, test } from "bun:test";
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
import {
  ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT,
  AssistantSideMenu,
} from "@/domains/chat/components/assistant-side-menu";
import { SIDEBAR_CONVERSATION_LIMIT } from "@/domains/chat/use-sidebar-state";

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
  return renderToStaticMarkup(
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

describe("AssistantSideMenu · Show more affordance", () => {
  test("hides 'Show more' when the recent count is at or below the limit", () => {
    const conversations = Array.from(
      { length: ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT },
      (_, index) =>
        makeConversation({
          conversationId: `k-${index}`,
          title: `Thread ${index}`,
        }),
    );

    const html = renderMenu({ conversations });

    expect(html).not.toContain("Show more");
  });

  test("renders 'Show more' when the recent count exceeds the limit", () => {
    const conversations = Array.from(
      { length: ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT + 1 },
      (_, index) =>
        makeConversation({
          conversationId: `k-${index}`,
          title: `Thread ${index}`,
        }),
    );

    const html = renderMenu({ conversations });

    expect(html).toContain("Show more");
  });

  test("shares the sidebar conversation page size constant", () => {
    expect(SIDEBAR_CONVERSATION_LIMIT).toBe(
      ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT,
    );
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

  test("renders the New Chat row (above the assistant row) when onStartNewConversation is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantSideMenu, {
        ...baseProps,
        onStartNewConversation: () => {},
      }),
    );

    expect(html).toContain(">New Chat<");
    // It is a button row, not a navigation link.
    expect(html).not.toContain('<a aria-label="New Chat"');
    // New Chat sits above the assistant row.
    expect(html.indexOf(">New Chat<")).toBeLessThan(
      html.indexOf("Your Assistant"),
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
  test("no dividers separate the sections", () => {
    const container = parse(
      renderMenu({
        conversations: LAYOUT_CONVERSATIONS,
        conversationGroups: LAYOUT_GROUPS,
      }),
    );

    const separatorsInList = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-slot="side-menu-separator"]',
      ),
    ).filter((hr) => hr.closest('[data-slot="collapsible"]'));

    expect(separatorsInList).toHaveLength(0);
  });

  // Same shell, same drag wiring, same header treatment for every type - a
  // group must not be distinguishable from a built-in section by its chrome.
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
  test.each([
    ["Alpha", ["Move Section Up", "Move Section Down"]],
    // Pinned leads and Slack trails, so each offers only one direction.
    ["Pinned", ["Move Section Down"]],
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
