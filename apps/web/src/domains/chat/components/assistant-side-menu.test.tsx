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
      makeConversation({
        conversationId: "s1",
        conversationType: "scheduled",
      }),
      makeConversation({
        conversationId: "b1",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({ conversationId: "r1", title: "Recent thread" }),
      makeConversation({
        conversationId: "rf1",
        conversationType: "background",
        source: "auto-analysis",
      }),
    ];

    const html = renderMenu({ conversations });

    expect(html).toContain(">Conversations<");
    expect(html).toContain(">Pinned<");
    expect(html).toContain(">Pinned thread<");
    expect(html).toContain(">Scheduled<");
    expect(html).toContain(">Background<");
    expect(html).toContain(">Recent thread<");
    expect(html).not.toContain(">Recents<");
    expect(html).not.toContain(">Slack<");

    expect(html.indexOf(">Pinned<")).toBeLessThan(
      html.indexOf(">Conversations<"),
    );
  });

  test("renders Slack as a conditional peer section between Recents and Scheduled", () => {
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
    const scheduledIndex = html.indexOf(">Scheduled<");
    const backgroundIndex = html.indexOf(">Background<");
    const slackIndex = html.indexOf(">Slack<");
    expect(recentThreadIndex).toBeGreaterThanOrEqual(0);
    expect(slackIndex).toBeGreaterThan(recentThreadIndex);
    expect(scheduledIndex).toBeGreaterThan(slackIndex);
    expect(backgroundIndex).toBeGreaterThan(scheduledIndex);
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

  test("omits chat count badges from category buckets and subgroups", () => {
    const conversations = [
      makeConversation({
        conversationId: "background-alpha",
        title: "Background Alpha",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({
        conversationId: "background-beta",
        title: "Background Beta",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({
        conversationId: "recent-alpha",
        title: "Recent Alpha",
      }),
    ];

    const html = renderMenu({ conversations });

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

  test("renders the pencil as a link when a href generator is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantSideMenu, {
        ...baseProps,
        onStartNewConversation: () => {},
        getNewConversationHref: () => "/assistant/conversations/draft-xyz",
      }),
    );

    expect(html).toContain('aria-label="New conversation"');
    expect(html).toContain('href="/assistant/conversations/draft-xyz"');
  });

  test("falls back to a plain button when no href generator is supplied", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantSideMenu, {
        ...baseProps,
        onStartNewConversation: () => {},
      }),
    );

    expect(html).toContain('aria-label="New conversation"');
    expect(html).not.toContain("/assistant/conversations/");
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


