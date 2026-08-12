/**
 * Tests for `CollapsedGroupIcon` and `getGroupIndicatorState`.
 *
 * `CollapsedGroupIcon` is a wiring component: it picks the section's icon and
 * tooltip, decides whether the tile opens a popover at all, and hands the rest
 * to `SideMenu.Item`. So these tests assert the wiring, with `SideMenu.Item`
 * mocked to surface the props it receives. How those props actually render
 * (the circle, the muted `aria-disabled` treatment that keeps the tooltip
 * hoverable, the indicator overlay) is the design library's contract and is
 * covered in `side-menu.test.tsx`.
 *
 * Uses `renderToStaticMarkup` for deterministic assertions. (happy-dom is
 * wired up via `bunfig.toml`, but Radix's popover overlays mount lazily and
 * never appear in static markup.)
 */

import { describe, expect, mock, test } from "bun:test";
import type { LucideIcon } from "lucide-react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Mock design library components
const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);
const mockTrigger = ({ children }: Record<string, unknown>) =>
  createElement("div", { "data-testid": "trigger" }, children as ReactNode);

/**
 * Stands in for `SideMenu.Item`, surfacing the props this component is
 * responsible for choosing as attributes. `data-tooltip-content` resolves
 * `tooltip` / `showCollapsedTooltip` the same way the real component does, so
 * a test can assert the text a user would actually hover.
 */
const mockSideMenuItem = ({
  icon,
  label,
  tooltip,
  showCollapsedTooltip,
  shape,
  disabled,
  indicator,
  active,
  ...props
}: Record<string, unknown>) => {
  const tooltipContent =
    tooltip ?? (showCollapsedTooltip === true ? label : undefined);
  return createElement(
    "button",
    {
      "data-slot": "side-menu-item",
      "aria-label": String(label),
      "data-tooltip-content":
        tooltipContent == null ? undefined : String(tooltipContent),
      "data-shape": shape == null ? "default" : String(shape),
      "data-active": active === true ? "true" : undefined,
      "aria-disabled": disabled === true ? "true" : undefined,
      tabIndex: disabled === true ? -1 : undefined,
      ...props,
    },
    icon ? createElement(icon as LucideIcon, { key: "icon", size: 14 }) : null,
    (indicator as ReactNode) ?? null,
  );
};

mock.module("@vellumai/design-library", () => ({
  Popover: {
    Root: passthrough,
    Trigger: mockTrigger,
    Content: passthrough,
  },
  SideMenu: { Item: mockSideMenuItem },
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
  test("an index count shows unread when no loaded row is unread", () => {
    // The index counts the whole section; the loaded rows are a window.
    const conversations = [makeConversation({ conversationId: "c1" })];

    expect(getGroupIndicatorState(conversations, undefined, undefined, 2)).toBe(
      "unread",
    );
  });

  test("an index count of zero suppresses the row scan", () => {
    // The index also wins in the quiet direction: a loaded row the server
    // has already settled as seen must not keep the dot lit.
    const conversations = [
      makeConversation({
        conversationId: "c1",
        hasUnseenLatestAssistantMessage: true,
      }),
    ];

    expect(
      getGroupIndicatorState(conversations, undefined, undefined, 0),
    ).toBeNull();
  });

  test("attention outranks an index unread count", () => {
    const conversations = [makeConversation({ conversationId: "c1" })];

    expect(
      getGroupIndicatorState(conversations, undefined, new Set(["c1"]), 5),
    ).toBe("attention");
  });

  test("processing outranks an index unread count", () => {
    const conversations = [makeConversation({ conversationId: "c1" })];

    expect(
      getGroupIndicatorState(conversations, new Set(["c1"]), undefined, 5),
    ).toBe("processing");
  });

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
      makeConversation({
        conversationId: "c1",
        hasUnseenLatestAssistantMessage: true,
      }),
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
    expect(getGroupIndicatorState(convos, processing, undefined)).toBe(
      "processing",
    );
  });

  test("returns 'attention' when a conversation needs attention", () => {
    const convos = [
      makeConversation({ conversationId: "c1" }),
      makeConversation({ conversationId: "c2" }),
    ];
    const attention = new Set(["c1"]);
    expect(getGroupIndicatorState(convos, undefined, attention)).toBe(
      "attention",
    );
  });

  test("attention takes priority over processing and unread", () => {
    const convos = [
      makeConversation({
        conversationId: "c1",
        hasUnseenLatestAssistantMessage: true,
      }),
      makeConversation({ conversationId: "c2" }),
      makeConversation({ conversationId: "c3" }),
    ];
    const processing = new Set(["c1"]);
    const attention = new Set(["c2"]);
    expect(getGroupIndicatorState(convos, processing, attention)).toBe(
      "attention",
    );
  });

  test("processing takes priority over unread", () => {
    const convos = [
      makeConversation({
        conversationId: "c1",
        hasUnseenLatestAssistantMessage: true,
      }),
      makeConversation({ conversationId: "c2" }),
    ];
    const processing = new Set(["c2"]);
    expect(getGroupIndicatorState(convos, processing, undefined)).toBe(
      "processing",
    );
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
    expect(html).toContain('data-slot="group-indicator-dot"');
    expect(html).toContain("bg-[var(--system-mid-strong)]");
  });

  /* `data-shape` is written by this file's own `SideMenu.Item` stand-in, so
     it says only that this component asked for the tile shape - not that the
     tile renders as a circle, which is asserted against the real component in
     `side-menu.test.tsx`. Worth keeping at that strength: dropping the prop
     here would square the tile, and nothing else would catch it. */
  test("asks for the tile shape, and the dot rides it as an overlay", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon icon={Pin} label="Pinned" indicatorState="unread">
        <div>content</div>
      </CollapsedGroupIcon>,
    );
    // Asks for the shared tile shape rather than drawing its own radius.
    expect(html).toContain('data-shape="tile"');
    // The dot goes through `indicator`, the collapsed overlay slot, not
    // through `badge` (which a collapsed row suppresses) and not as a sibling
    // of the tile (which would put it outside the circle's box).
    expect(html).toContain('data-slot="group-indicator-dot"');
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
    expect(html).not.toContain('data-slot="group-indicator-dot"');
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
      <CollapsedGroupIcon
        icon={Pin}
        label="Pinned"
        indicatorState={null}
        disabled
      >
        <div data-testid="popover-body">Should not render</div>
      </CollapsedGroupIcon>,
    );
    /* Nothing to open, expressed through the row's `disabled` prop, which
       renders as `aria-disabled` and never as the native attribute. (That
       distinction is the design library's to keep: a natively disabled
       control dispatches no pointer events, so the "No conversations" hint
       would be the one thing unreachable. `side-menu.test.tsx` holds it.) */
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('tabindex="-1"');
    // No popover: neither the trigger's semantics nor its body.
    expect(html).not.toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("Should not render");
    // Still labelled for assistive tech, and still asking for the same tile
    // shape as its populated neighbours rather than a rounded square.
    expect(html).toContain('aria-label="Pinned"');
    expect(html).toContain('data-shape="tile"');
  });

  test("hover tooltip explains the group is empty rather than repeating the label", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon
        icon={Pin}
        label="Pinned"
        indicatorState={null}
        disabled
      />,
    );
    // Regression: empty groups keep the "No conversations" affordance instead
    // of just echoing the group name back to the user.
    expect(html).toContain('data-tooltip-content="No conversations"');
    expect(html).not.toContain('data-tooltip-content="Pinned"');
  });

  test("never shows an indicator dot when disabled", () => {
    const html = renderToStaticMarkup(
      <CollapsedGroupIcon
        icon={Pin}
        label="Pinned"
        indicatorState="attention"
        disabled
      />,
    );
    expect(html).not.toContain('data-slot="group-indicator-dot"');
  });
});
