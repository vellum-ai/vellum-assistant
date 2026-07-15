/**
 * Tests for `AssistantSideMenu`.
 *
 * Rendering goes through `react-dom/server` — assertions look at the
 * emitted markup. Interactive behavior (Show more, onSelect) is exercised
 * by the SideMenu primitive's own tests; here we verify the composition
 * rules unique to `AssistantSideMenu`.
 */

import { describe, expect, mock, test } from "bun:test";
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

import type { Conversation } from "@/types/conversation-types";
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

describe("AssistantSideMenu · Conversations category rows", () => {
  test("renders Pinned above Conversations with bucket rows after recents", () => {
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

    expect(html).toContain(">Conversations<");
    expect(html).toContain(">Pinned<");
    expect(html).toContain(">Pinned thread<");
    expect(html).not.toContain(">Scheduled<");
    expect(html).not.toContain(">Background<");
    expect(html).toContain(">Recent thread<");
    expect(html).not.toContain(">Recents<");
    expect(html).not.toContain(">Slack<");

    expect(html.indexOf(">Pinned<")).toBeLessThan(
      html.indexOf(">Conversations<"),
    );
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
      expandedHtml.indexOf(">Conversations<"),
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

  test("omits chat count badges from the Conversations section rows", () => {
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

    expect(html).toContain(">Conversations<");
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

  test("renders the tip card in the rail footer above the footer action", () => {
    const html = renderMenu({ conversations, includeTipCard: true });

    const footerIndex = html.indexOf('data-slot="side-menu-footer"');
    const tipIndex = html.indexOf("TipSentinel");
    const actionIndex = html.indexOf("Preferences");
    expect(footerIndex).toBeGreaterThanOrEqual(0);
    expect(tipIndex).toBeGreaterThan(footerIndex);
    expect(actionIndex).toBeGreaterThan(tipIndex);
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

describe("AssistantSideMenu · new conversation affordance", () => {
  const baseProps = {
    assistantId: "asst-1",
    collapsed: false,
    variant: "rail" as const,
    conversations: [makeConversation({ conversationId: "a", title: "Alpha" })],
    onSelectConversation: () => {},
  };

  test("renders the new-conversation pencil button when onStartNewConversation is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantSideMenu, {
        ...baseProps,
        onStartNewConversation: () => {},
      }),
    );

    expect(html).toContain('aria-label="New conversation"');
    // It is a plain icon button, not a navigation link.
    expect(html).not.toContain('<a aria-label="New conversation"');
  });

  test("omits the new-conversation button when onStartNewConversation is absent", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantSideMenu, { ...baseProps }),
    );

    expect(html).not.toContain('aria-label="New conversation"');
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
});


