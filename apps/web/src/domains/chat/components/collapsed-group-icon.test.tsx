/**
 * Tests for `CollapsedGroupIcon` and `getGroupIndicatorState`.
 *
 * Uses `renderToStaticMarkup` since the workspace lacks jsdom.
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Mock design library components
const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);
const mockTrigger = ({ children }: Record<string, unknown>) =>
  createElement("div", { "data-testid": "trigger" }, children as ReactNode);

mock.module("@vellum/design-library", () => ({
  Popover: {
    Root: passthrough,
    Trigger: mockTrigger,
    Content: passthrough,
  },
}));

import type { Conversation } from "@/domains/chat/api/conversations";
import { Pin } from "lucide-react";
import {
  CollapsedGroupIcon,
  getGroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";

function makeConversation(
  overrides: Partial<Conversation> & { conversationId: string },
): Conversation {
  return {
    title: "Untitled",
    status: "active",
    lastMessageAt: null,
    channel: null,
    groupId: undefined,
    hasUnseenLatestAssistantMessage: false,
    ...overrides,
  } as Conversation;
}

// ---------------------------------------------------------------------------
// getGroupIndicatorState
// ---------------------------------------------------------------------------

describe("getGroupIndicatorState", () => {
  test("returns null for empty conversations", () => {
    expect(getGroupIndicatorState([], undefined, undefined)).toBe(null);
  });

  test("returns null when no conversations have special state", () => {
    const convos = [
      makeConversation({ conversationId: "c1" }),
      makeConversation({ conversationId: "c2" }),
    ];
    expect(getGroupIndicatorState(convos, undefined, undefined)).toBe(null);
  });

  test("returns 'unread' when a conversation has unseen messages", () => {
    const convos = [
      makeConversation({ conversationId: "c1", hasUnseenLatestAssistantMessage: true }),
      makeConversation({ conversationId: "c2" }),
    ];
    expect(getGroupIndicatorState(convos, undefined, undefined)).toBe("unread");
  });

  test("returns 'processing' when a conversation is processing", () => {
    const convos = [
      makeConversation({ conversationId: "c1" }),
      makeConversation({ conversationId: "c2" }),
    ];
    const processing = new Set(["c2"]);
    expect(getGroupIndicatorState(convos, processing, undefined)).toBe("processing");
  });

  test("returns 'attention' when a conversation needs attention", () => {
    const convos = [
      makeConversation({ conversationId: "c1" }),
      makeConversation({ conversationId: "c2" }),
    ];
    const attention = new Set(["c1"]);
    expect(getGroupIndicatorState(convos, undefined, attention)).toBe("attention");
  });

  test("attention takes priority over processing and unread", () => {
    const convos = [
      makeConversation({ conversationId: "c1", hasUnseenLatestAssistantMessage: true }),
      makeConversation({ conversationId: "c2" }),
      makeConversation({ conversationId: "c3" }),
    ];
    const processing = new Set(["c1"]);
    const attention = new Set(["c2"]);
    expect(getGroupIndicatorState(convos, processing, attention)).toBe("attention");
  });

  test("processing takes priority over unread", () => {
    const convos = [
      makeConversation({ conversationId: "c1", hasUnseenLatestAssistantMessage: true }),
      makeConversation({ conversationId: "c2" }),
    ];
    const processing = new Set(["c2"]);
    expect(getGroupIndicatorState(convos, processing, undefined)).toBe("processing");
  });
});

// ---------------------------------------------------------------------------
// CollapsedGroupIcon rendering
// ---------------------------------------------------------------------------

describe("CollapsedGroupIcon", () => {
  test("renders the provided icon", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState={null}>
        <div>content</div>
      </CollapsedGroupIcon>,
    );
    // Pin icon renders as an SVG — check for the aria-label on the button
    expect(html).toContain('aria-label="Pinned"');
    // The SVG from lucide should be present
    expect(html).toContain("<svg");
  });

  test("renders indicator dot with attention class", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState="attention">
        <div>content</div>
      </CollapsedGroupIcon>,
    );
    expect(html).toContain("bg-[var(--system-mid-strong)]");
    expect(html).toContain("rounded-full");
  });

  test("renders indicator dot with processing class (pulsing)", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState="processing">
        <div>content</div>
      </CollapsedGroupIcon>,
    );
    expect(html).toContain("bg-[var(--primary-base)]");
    expect(html).toContain("animate-pulse");
  });

  test("renders indicator dot with unread class", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState="unread">
        <div>content</div>
      </CollapsedGroupIcon>,
    );
    expect(html).toContain("bg-[var(--system-mid-strong)]");
  });

  test("does not render indicator dot when state is null", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState={null}>
        <div>content</div>
      </CollapsedGroupIcon>,
    );
    // No rounded-full indicator dot should appear (the button itself has rounded-[6px])
    expect(html).not.toContain("rounded-full");
  });

  test("renders popover children", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState={null}>
        <div data-testid="popover-body">Hello world</div>
      </CollapsedGroupIcon>,
    );
    expect(html).toContain("Hello world");
    expect(html).toContain('data-testid="popover-body"');
  });
});
