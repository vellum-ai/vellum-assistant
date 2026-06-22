/**
 * Tests for `CollapsedGroupIcon` and `getGroupIndicatorState`.
 *
 * Uses `renderToStaticMarkup` for deterministic assertions on the rendered
 * output. (happy-dom is wired up via `bunfig.toml`, but Radix's popover/tooltip
 * overlays mount lazily on hover and never appear in static markup, so the
 * design-library primitives are mocked to surface their props inline instead.)
 */

import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Mock design library components
const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);
const mockTrigger = ({ children }: Record<string, unknown>) =>
  createElement("div", { "data-testid": "trigger" }, children as ReactNode);
// The real `Tooltip` portals its content and only mounts it on hover, so it
// never appears in static markup. Render the trigger inline and surface the
// `content` prop as an attribute so tests can assert what the tooltip says.
const mockTooltip = ({ content, children }: Record<string, unknown>) =>
  createElement(
    "div",
    { "data-testid": "tooltip", "data-tooltip-content": String(content) },
    children as ReactNode,
  );

mock.module("@vellumai/design-library", () => ({
  Popover: {
    Root: passthrough,
    Trigger: mockTrigger,
    Content: passthrough,
  },
  Tooltip: mockTooltip,
}));

import {
    CollapsedGroupIcon,
    getGroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import type { Conversation } from "@/types/conversation-types";
import { Pin } from "lucide-react";

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

  test("active icon's hover tooltip shows the group label", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState={null}>
        <div>content</div>
      </CollapsedGroupIcon>,
    );
    expect(html).toContain('data-tooltip-content="Pinned"');
  });
});

// ---------------------------------------------------------------------------
// CollapsedGroupIcon disabled (empty group) state
// ---------------------------------------------------------------------------

describe("CollapsedGroupIcon disabled state", () => {
  test("renders a non-interactive icon with no popover trigger", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState={null} disabled>
        <div data-testid="popover-body">Should not render</div>
      </CollapsedGroupIcon>,
    );
    // No clickable button and no popover content for an empty group.
    expect(html).not.toContain("<button");
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("Should not render");
    // Muted, disabled styling on the bare icon.
    expect(html).toContain("text-[var(--content-disabled)]");
    // Still labelled for assistive tech.
    expect(html).toContain('aria-label="Pinned"');
  });

  test("hover tooltip explains the group is empty rather than repeating the label", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState={null} disabled />,
    );
    // Regression: empty groups keep the "No conversations" affordance instead
    // of just echoing the group name back to the user.
    expect(html).toContain('data-tooltip-content="No conversations"');
    expect(html).not.toContain('data-tooltip-content="Pinned"');
  });

  test("never shows an indicator dot when disabled", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState="attention" disabled />,
    );
    expect(html).not.toContain("rounded-full");
  });
});
