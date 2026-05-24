/**
 * Tests for `AssistantSideMenu`.
 *
 * Rendering goes through `react-dom/server` — assertions look at the
 * emitted markup. Interactive behavior (Show more, onSelect) is exercised
 * by the SideMenu primitive's own tests; here we verify the composition
 * rules unique to `AssistantSideMenu`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/hooks/use-is-mobile.js", () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));


import type { Conversation } from "@/domains/chat/api/conversations.js";
import {
  ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT,
  AssistantSideMenu,
} from "@/domains/chat/components/assistant-side-menu.js";
import { SIDEBAR_CONVERSATION_LIMIT } from "@/domains/chat/use-sidebar-state.js";

function makeConversation(overrides: Partial<Conversation>): Conversation {
  return {
    conversationId: overrides.conversationId ?? "k",
    ...overrides,
  };
}

function renderMenu(props: {
  conversations: Conversation[];
  activeConversationId?: string;
  variant?: "rail" | "overlay";
  includeFooterAction?: boolean;
}): string {
  const includeFooterAction = props.includeFooterAction ?? true;
  return renderToStaticMarkup(
    createElement(AssistantSideMenu, {
      assistantId: "asst-1",
      collapsed: false,
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
  test("renders a Conversations section header with all four category rows", () => {
    const conversations = [
      makeConversation({ conversationId: "p1", isPinned: true }),
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
    expect(html).toContain(">Scheduled<");
    expect(html).toContain(">Background<");
    expect(html).toContain(">Recents<");
    expect(html).not.toContain(">Slack<");
  });

  test("renders Slack as a conditional peer section after Background", () => {
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

    const pinnedIndex = html.indexOf(">Pinned<");
    const recentsIndex = html.indexOf(">Recents<");
    const scheduledIndex = html.indexOf(">Scheduled<");
    const backgroundIndex = html.indexOf(">Background<");
    const slackIndex = html.indexOf(">Slack<");
    expect(pinnedIndex).toBeGreaterThanOrEqual(0);
    expect(recentsIndex).toBeGreaterThan(pinnedIndex);
    expect(scheduledIndex).toBeGreaterThan(recentsIndex);
    expect(backgroundIndex).toBeGreaterThan(scheduledIndex);
    expect(slackIndex).toBeGreaterThan(backgroundIndex);
  });

  test("renders a count badge only for non-empty category buckets", () => {
    const conversations = [
      makeConversation({
        conversationId: "b1",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({
        conversationId: "b2",
        conversationType: "background",
        source: "heartbeat",
      }),
      makeConversation({ conversationId: "r1" }),
    ];

    const html = renderMenu({ conversations });

    expect(html).toContain(">2<");
    expect(html).toContain(">1<");
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

  test("wires the same 'Show more' affordance for Slack conversations", () => {
    const src = readFileSync(
      new URL("../use-sidebar-state.ts", import.meta.url).pathname,
      "utf8",
    );

    expect(src).toContain(
      "slack.slice(0, SIDEBAR_CONVERSATION_LIMIT)",
    );
    expect(src).toContain(
      "slack.length > SIDEBAR_CONVERSATION_LIMIT",
    );
    expect(src).toContain("showAllSlack");
    expect(src).toContain("setShowAllSlack");
    expect(SIDEBAR_CONVERSATION_LIMIT).toBe(ASSISTANT_SIDE_MENU_CONVERSATION_LIMIT);
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

