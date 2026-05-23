/**
 * Tests for `CollapsedConversationsButton`.
 *
 * The component renders a small badge-button showing the total conversation
 * count; clicking it opens a Popover with categorized sections (Pinned,
 * Scheduled, Background, Slack, Recents, custom groups). Background
 * conversations sub-group by source with collapsible rows.
 *
 * Uses `renderToStaticMarkup` since the workspace lacks jsdom.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement, type FC, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Mock design library components
const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);
const mockTrigger = ({ children }: Record<string, unknown>) =>
  createElement("div", { "data-testid": "trigger" }, children as ReactNode);
const mockPanelItem = ({
  label,
  icon: Icon,
  badge,
  active,
  trailingAction,
  className,
  ...rest
}: Record<string, unknown>) =>
  createElement(
    "div",
    {
      "data-testid": "panel-item",
      "data-active": active || undefined,
      className: className as string | undefined,
      ...rest,
    },
    Icon
      ? createElement(Icon as FC<Record<string, unknown>>, { size: 14 })
      : null,
    label as string,
    badge != null ? createElement("span", { "data-testid": "badge" }, String(badge)) : null,
    trailingAction as ReactNode,
  );

mock.module("@vellum/design-library", () => ({
  Popover: {
    Root: passthrough,
    Trigger: mockTrigger,
    Content: passthrough,
  },
  PanelItem: mockPanelItem,
}));

import type { Conversation } from "@/domains/chat/api/conversations.js";
import { CollapsedConversationsButton } from "@/domains/chat/components/collapsed-conversations-button.js";

function makeConversation(overrides: Partial<Conversation> & { conversationId: string }): Conversation {
  return {
    title: "Untitled",
    status: "active",
    lastMessageAt: null,
    channel: null,
    groupId: undefined,
    ...overrides,
  } as Conversation;
}

const noop = () => {};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("CollapsedConversationsButton", () => {
  test("returns null when all buckets are empty", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[]}
        slack={[]}
        recents={[]}
        onSelectConversation={noop}
      />,
    );
    expect(html).toBe("");
  });

  test("renders total count badge", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[makeConversation({ conversationId: "p1" })]}
        scheduled={[]}
        background={[]}
        slack={[]}
        recents={[
          makeConversation({ conversationId: "r1" }),
          makeConversation({ conversationId: "r2" }),
        ]}
        onSelectConversation={noop}
      />,
    );
    // 1 pinned + 2 recents = 3
    expect(html).toContain(">3<");
  });

  test("renders section headers for non-empty buckets", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[makeConversation({ conversationId: "p1", title: "My Pinned" })]}
        scheduled={[]}
        background={[]}
        slack={[makeConversation({ conversationId: "s1", title: "Slack Thread" })]}
        recents={[]}
        onSelectConversation={noop}
      />,
    );
    expect(html).toContain("Pinned");
    expect(html).toContain("Slack");
    expect(html).not.toContain("Scheduled");
    expect(html).not.toContain("Background");
    expect(html).not.toContain("Recents");
  });

  test("renders conversation titles as panel items", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[]}
        slack={[]}
        recents={[
          makeConversation({ conversationId: "r1", title: "Chat about dogs" }),
          makeConversation({ conversationId: "r2", title: "Chat about cats" }),
        ]}
        onSelectConversation={noop}
      />,
    );
    expect(html).toContain("Chat about dogs");
    expect(html).toContain("Chat about cats");
  });

  test("renders 'Untitled' for conversations without a title", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[]}
        slack={[]}
        recents={[makeConversation({ conversationId: "r1", title: null as unknown as string })]}
        onSelectConversation={noop}
      />,
    );
    expect(html).toContain("Untitled");
  });

  test("includes attention indicator in aria-label when attentionConversationKeys is non-empty", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[]}
        slack={[]}
        recents={[makeConversation({ conversationId: "r1" })]}
        onSelectConversation={noop}
        attentionConversationKeys={new Set(["r1"])}
      />,
    );
    expect(html).toContain("action needed");
  });

  test("renders custom groups", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[]}
        slack={[]}
        recents={[]}
        customGroups={[
          {
            id: "g1",
            name: "Work Projects",
            conversations: [makeConversation({ conversationId: "c1", title: "Project Alpha" })],
          },
        ]}
        onSelectConversation={noop}
      />,
    );
    expect(html).toContain("Work Projects");
    expect(html).toContain("Project Alpha");
  });

  test("includes custom group count in total", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[]}
        slack={[]}
        recents={[makeConversation({ conversationId: "r1" })]}
        customGroups={[
          {
            id: "g1",
            name: "Work",
            conversations: [
              makeConversation({ conversationId: "c1" }),
              makeConversation({ conversationId: "c2" }),
            ],
          },
        ]}
        onSelectConversation={noop}
      />,
    );
    // 1 recent + 2 custom = 3
    expect(html).toContain(">3<");
  });

  test("auto-expands background sub-groups containing attention conversations", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[
          makeConversation({ conversationId: "b1", title: "Needs Review", source: "heartbeat" }),
          makeConversation({ conversationId: "b2", title: "Other BG", source: "heartbeat" }),
        ]}
        slack={[]}
        recents={[]}
        onSelectConversation={noop}
        attentionConversationKeys={new Set(["b1"])}
      />,
    );
    // Sub-group should be auto-expanded because b1 needs attention
    expect(html).toContain("Needs Review");
    expect(html).toContain("Other BG");
  });

  test("renders single-source background conversations as flat leaf rows", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[
          makeConversation({ conversationId: "b1", title: "Solo BG" }),
        ]}
        slack={[]}
        recents={[]}
        onSelectConversation={noop}
      />,
    );
    // Single conversations without a source get __single__: prefix and
    // render as a flat leaf row, not a collapsible group header
    expect(html).toContain("Solo BG");
    expect(html).toContain("Background");
  });

  test("renders background conversations with sub-group labels", () => {
    const html = renderToStaticMarkup(
      <CollapsedConversationsButton
        pinned={[]}
        scheduled={[]}
        background={[
          makeConversation({ conversationId: "b1", title: "BG 1", source: "heartbeat" }),
          makeConversation({ conversationId: "b2", title: "BG 2", source: "heartbeat" }),
        ]}
        slack={[]}
        recents={[]}
        onSelectConversation={noop}
      />,
    );
    expect(html).toContain("Background");
    expect(html).toContain("Heartbeat");
  });
});
