/**
 * Tests for `ConversationActionsMenu`.
 *
 * The component swaps surfaces based on `useIsMobile()`:
 *   - Desktop → Radix dropdown menu (`Menu.Root`)
 *   - Mobile  → `BottomSheet` (Radix Dialog) with `PanelItem` rows
 *
 * The web workspace lacks `@testing-library/react` (no jsdom/happy-dom), so
 * we exercise behavior through `renderToStaticMarkup` for HTML surface checks
 * and mock `useIsMobile` per-test to drive each branch.
 *
 * We also test the pure `renderConversationMenuItems` helper directly since
 * it is the shared source of truth for both dropdown and context-menu
 * surfaces.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { fixedT } from "@/i18n";

// The builders take a namespace-bound `t`, the same thing
// `useTranslation("chat")` hands their component callers. The unbound `t`
// resolves against `common` and returns the key instead of the copy.
const t = fixedT("chat");
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let mockIsTouchMobile = false;
mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => mockIsTouchMobile,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));

let mockIsNativePlatform = false;
mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => mockIsNativePlatform,
  isNativePlatform: () => mockIsNativePlatform,
}));

// Mock design library compound components that require browser APIs (portals,
// Radix floating-ui) so renderToStaticMarkup can produce testable HTML.
const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);
const mockItem = ({
  children,
  onSelect: _onSelect,
  leftIcon,
  disabled,
  ...rest
}: Record<string, unknown>) =>
  createElement(
    "div",
    {
      "data-testid": "menu-item",
      "data-disabled": disabled || undefined,
      ...rest,
    },
    leftIcon as ReactNode,
    children as ReactNode,
  );
const mockSeparator = () => createElement("hr", { "data-testid": "separator" });
const mockSubTrigger = ({
  children,
  leftIcon,
  ...rest
}: Record<string, unknown>) =>
  createElement(
    "div",
    { "data-testid": "sub-trigger", ...rest },
    leftIcon as ReactNode,
    children as ReactNode,
  );
const mockTrigger = ({ children }: Record<string, unknown>) =>
  createElement("div", { "data-testid": "trigger" }, children as ReactNode);

mock.module("@vellumai/design-library", () => {
  const MenuMock = {
    Root: passthrough,
    Trigger: mockTrigger,
    Content: passthrough,
    Item: mockItem,
    Separator: mockSeparator,
    Sub: passthrough,
    SubTrigger: mockSubTrigger,
    SubContent: passthrough,
  };

  const BottomSheetMock = {
    Root: passthrough,
    Trigger: mockTrigger,
    Content: passthrough,
    Header: passthrough,
    Title: passthrough,
    Body: passthrough,
    Grabber: () => createElement("div", { "data-testid": "sheet-grabber" }),
    Close: ({ children, ...rest }: Record<string, unknown>) =>
      createElement(
        "button",
        { "data-testid": "sheet-close", ...rest },
        children as ReactNode,
      ),
  };

  // `leadingSlot` is rendered rather than spread: the sheet passes its icon
  // chip through it, and spreading a ReactNode onto a DOM node would both warn
  // and hide whether the chip was built at all.
  const PanelItemMock = ({
    label,
    icon: _icon,
    leadingSlot,
    ...rest
  }: Record<string, unknown>) =>
    createElement(
      "div",
      { "data-testid": "panel-item", ...rest },
      leadingSlot as ReactNode,
      label as string,
    );

  const ContextMenuMock = {
    Item: mockItem,
    Separator: mockSeparator,
    Sub: passthrough,
    SubTrigger: mockSubTrigger,
    SubContent: passthrough,
  };

  return {
    Menu: MenuMock,
    ContextMenu: ContextMenuMock,
    BottomSheet: BottomSheetMock,
    PanelItem: PanelItemMock,
  };
});

import {
  ConversationActionsMenu,
  ConversationActionsSheet,
  renderConversationMenuItems,
  renderConversationMenuItemsAsPanelItems,
  type ConversationMenuPrimitive,
} from "@/domains/chat/components/conversation-actions-menu";
import { Menu } from "@vellumai/design-library";

beforeEach(() => {
  mockIsTouchMobile = false;
  mockIsNativePlatform = false;
});

// ---------------------------------------------------------------------------
// renderConversationMenuItems (pure helper)
// ---------------------------------------------------------------------------

describe("renderConversationMenuItems", () => {
  test("renders Pin and Rename when handlers are provided", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          onPinToggle: () => {},
          onRename: () => {},
        })}
      </>,
    );
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });

  test("renders Unpin when isPinned is true", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          isPinned: true,
          onPinToggle: () => {},
        })}
      </>,
    );
    expect(html).toContain("Unpin");
    expect(html).not.toContain(">Pin<");
  });

  test("renders Archive when onArchive is provided", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          onArchive: () => {},
        })}
      </>,
    );
    expect(html).toContain("Archive");
  });

  test("renders Delete when onDelete is provided", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          onDelete: () => {},
        })}
      </>,
    );
    expect(html).toContain("Delete");
  });

  test("omits Delete when onDelete is not provided", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          onArchive: () => {},
        })}
      </>,
    );
    expect(html).toContain("Archive");
    expect(html).not.toContain("Delete");
  });

  test("renders Delete for read-only conversations when wired", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          isReadonly: true,
          onArchive: () => {},
          onDelete: () => {},
          onMarkUnread: () => {},
        })}
      </>,
    );
    expect(html).toContain("Archive");
    expect(html).toContain("Delete");
    expect(html).not.toContain("Mark as unread");
  });

  test("renders Unarchive when isArchived and onUnarchive are provided", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          isArchived: true,
          onUnarchive: () => {},
        })}
      </>,
    );
    expect(html).toContain("Unarchive");
  });

  test("hides Mark as unread when isReadonly", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          isReadonly: true,
          onArchive: () => {},
          onMarkUnread: () => {},
        })}
      </>,
    );
    expect(html).toContain("Archive");
    expect(html).not.toContain("Mark as unread");
  });

  test("renders the channel source link item when provided", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          variant: "header",
          channelSourceLink: {
            href: "https://slack.com/archives/C01ABC/p1700000000000100",
            label: "Open in Slack",
          },
          onPinToggle: () => {},
        })}
      </>,
    );
    expect(html).toContain("Open in Slack");
  });

  test("omits the channel source link item when absent", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          variant: "header",
          onPinToggle: () => {},
        })}
      </>,
    );
    expect(html).not.toContain("Open in Slack");
  });

  test("renders header variant with correct item order", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          variant: "header",
          onCopyConversation: () => {},
          onForkConversation: () => {},
          onInspect: () => {},
          onRefresh: () => {},
          onPinToggle: () => {},
          onRename: () => {},
          onArchive: () => {},
          onDelete: () => {},
        })}
      </>,
    );
    // Order, not just presence: the mobile sheet renders the same sequence
    // from a parallel builder, so a reshuffle here that the sheet does not
    // follow is exactly the drift both surfaces exist to avoid.
    const order = [
      "Copy Full Conversation",
      "Fork Conversation",
      "Analyze Conversation",
      "Refresh",
      "Pin",
      "Rename",
      "Archive",
      "Delete",
    ];
    const positions = order.map((label) => html.indexOf(label));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("renders Copy conversation ID in both variants when wired", () => {
    for (const variant of ["sidebar", "header"] as const) {
      const html = renderToStaticMarkup(
        <>
          {renderConversationMenuItems({
            Primitive: Menu as unknown as ConversationMenuPrimitive,
            t,
            variant,
            onCopyConversationId: () => {},
          })}
        </>,
      );
      expect(html).toContain("Copy conversation ID");
    }
  });

  test("omits Copy conversation ID when not wired", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          onRename: () => {},
        })}
      </>,
    );
    expect(html).not.toContain("Copy conversation ID");
  });
});

// ---------------------------------------------------------------------------
// "Move to group" submenu
// ---------------------------------------------------------------------------

describe("renderConversationMenuItems — Move to group submenu", () => {
  test("omitted entirely when move/create handlers are not wired", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          onPinToggle: () => {},
        })}
      </>,
    );
    expect(html).not.toContain("Move to group");
  });

  test("shows the submenu with New group… even when there are no groups", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          moveToGroups: [],
          onMoveToGroup: () => {},
          onCreateGroupInto: () => {},
        })}
      </>,
    );
    expect(html).toContain("Move to group");
    expect(html).toContain("New group…");
  });

  test("lists existing custom groups as targets", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          moveToGroups: [
            { id: "g_research", name: "Research" },
            { id: "g_ideas", name: "Ideas" },
          ],
          onMoveToGroup: () => {},
          onCreateGroupInto: () => {},
        })}
      </>,
    );
    expect(html).toContain("Research");
    expect(html).toContain("Ideas");
    expect(html).toContain("New group…");
  });

  test("appends Remove from group only when onRemoveFromGroup is provided", () => {
    const withRemove = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          moveToGroups: [{ id: "g_research", name: "Research" }],
          onMoveToGroup: () => {},
          onCreateGroupInto: () => {},
          onRemoveFromGroup: () => {},
        })}
      </>,
    );
    expect(withRemove).toContain("Remove from group");

    const withoutRemove = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          moveToGroups: [{ id: "g_research", name: "Research" }],
          onMoveToGroup: () => {},
          onCreateGroupInto: () => {},
        })}
      </>,
    );
    expect(withoutRemove).not.toContain("Remove from group");
  });

  test("mobile bottom sheet renders the flattened Move to group block", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItemsAsPanelItems({
          t,
          moveToGroups: [{ id: "g_research", name: "Research" }],
          onMoveToGroup: () => {},
          onCreateGroupInto: () => {},
          onClose: () => {},
        })}
      </>,
    );
    expect(html).toContain("Move to group");
    expect(html).toContain("Research");
    expect(html).toContain("New group…");
  });
});

// ---------------------------------------------------------------------------
// ConversationActionsMenu component
// ---------------------------------------------------------------------------

describe("ConversationActionsMenu — desktop branch", () => {
  test("renders the default ellipsis trigger with aria-label", () => {
    mockIsTouchMobile = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu onPinToggle={() => {}} onRename={() => {}} />,
    );
    expect(html).toContain('aria-label="Conversation actions"');
    expect(html).toContain("<button");
  });

  test("renders Pin and Rename items in the menu content", () => {
    mockIsTouchMobile = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu onPinToggle={() => {}} onRename={() => {}} />,
    );
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });
});

describe("ConversationActionsMenu — mobile branch", () => {
  test("renders BottomSheet surface on mobile", () => {
    mockIsTouchMobile = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu onPinToggle={() => {}} onRename={() => {}} />,
    );
    expect(html).toContain("Conversation actions");
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });

  test("renders Archive on mobile when provided", () => {
    mockIsTouchMobile = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu onArchive={() => {}} />,
    );
    expect(html).toContain("Archive");
  });
});

describe("renderConversationMenuItems — mark read/unread exclusivity", () => {
  test("onMarkRead takes precedence when both onMarkRead and onMarkUnread are provided", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItems({
          Primitive: Menu as unknown as ConversationMenuPrimitive,
          t,
          onMarkRead: () => {},
          onMarkUnread: () => {},
        })}
      </>,
    );
    expect(html).toContain("Mark as read");
    expect(html).not.toContain("Mark as unread");
  });
});

describe("renderConversationMenuItems: read-state iconography", () => {
  // The glyph names the conversation's current state: a conversation offering
  // "Mark as read" is unread, so it shows the sealed envelope. `lucide-mail`
  // is a prefix of `lucide-mail-open`, so that case rules the open glyph out
  // explicitly.
  function menuHtml(props: Parameters<typeof renderConversationMenuItems>[0]) {
    return renderToStaticMarkup(<>{renderConversationMenuItems(props)}</>);
  }

  test("an unread conversation shows the sealed envelope", () => {
    const html = menuHtml({
      Primitive: Menu as unknown as ConversationMenuPrimitive,
      t,
      onMarkRead: () => {},
    });
    expect(html).toContain("Mark as read");
    expect(html).toContain('lucide-mail"');
    expect(html).not.toContain("lucide-mail-open");
  });

  test("a read conversation shows the opened envelope", () => {
    const html = menuHtml({
      Primitive: Menu as unknown as ConversationMenuPrimitive,
      t,
      onMarkUnread: () => {},
    });
    expect(html).toContain("Mark as unread");
    expect(html).toContain("lucide-mail-open");
  });
});

describe("ConversationActionsMenu — mobile panel details", () => {
  test("isMarkUnreadDisabled renders disabled panel item on mobile", () => {
    mockIsTouchMobile = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu onMarkUnread={() => {}} isMarkUnreadDisabled />,
    );
    expect(html).toContain("Mark as unread");
    // Disabled is expressed through PanelItem's own `disabled` prop, which
    // keeps the row's button semantics, plus the dim styling the design
    // library's menu surfaces use.
    expect(html).toContain('disabled=""');
    expect(html).toContain("cursor-not-allowed");
    expect(html).toContain("text-[var(--content-disabled)]");
    // The chip dims with the label. The sheet's own brighter label colour is
    // conditional for this reason, so this guards against it being made
    // unconditional again and merging over the dim treatment above.
    expect(html).toContain("[--panel-item-icon-fg:var(--content-disabled)]");
    expect(html).not.toContain("text-[var(--content-default)]");
  });

  test("hides Open in New Window on native iOS bottom sheet", () => {
    mockIsTouchMobile = true;
    mockIsNativePlatform = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        variant="header"
        onOpenInNewWindow={() => {}}
        onPinToggle={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).not.toContain("Open in new window");
    expect(html).not.toContain("Open in New Window");
    // Other actions remain.
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });

  test("shows Open in New Window on web bottom sheet", () => {
    mockIsTouchMobile = true;
    mockIsNativePlatform = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        variant="header"
        onOpenInNewWindow={() => {}}
        onPinToggle={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("Open in New Window");
  });

  test("variant header renders header-order items on mobile", () => {
    mockIsTouchMobile = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        variant="header"
        onCopyConversation={() => {}}
        onForkConversation={() => {}}
        onInspect={() => {}}
        onRefresh={() => {}}
        onPinToggle={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />,
    );
    // The sheet's sequence has to track the dropdown's; see the matching
    // order assertion over `renderConversationMenuItems` above.
    const order = [
      "Copy Full Conversation",
      "Fork Conversation",
      "Analyze Conversation",
      "Refresh",
      "Pin",
      "Rename",
      "Archive",
    ];
    const positions = order.map((label) => html.indexOf(label));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// ConversationActionsSheet — shared controlled sheet (row long-press + ellipsis)
// ---------------------------------------------------------------------------

describe("ConversationActionsSheet", () => {
  test("renders the actions title and the provided items", () => {
    const html = renderToStaticMarkup(
      <ConversationActionsSheet
        open
        onOpenChange={() => {}}
        onPinToggle={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("Conversation Actions");
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });

  test("renders the sheet's grabber and an explicit close control", () => {
    const html = renderToStaticMarkup(
      <ConversationActionsSheet
        open
        onOpenChange={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain('data-testid="sheet-grabber"');
    // Both strings come from the `chat` catalog.
    expect(html).toContain('data-testid="sheet-close"');
    expect(html).toContain('aria-label="Close"');
  });

  test("gives every action row a leading chip", () => {
    const html = renderToStaticMarkup(
      <ConversationActionsSheet
        open
        onOpenChange={() => {}}
        onPinToggle={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />,
    );
    // One chip per action row. Counting them, rather than asserting the class
    // appears at all, is what catches a row added through the plain
    // `buildPanelMenuItem` and left bare beside its chipped neighbours.
    const chips = html.match(/rounded-full bg-\[var\(--border-hover\)\]/g);
    expect(chips).toHaveLength(3);
  });

  test("renders a trigger when one is provided (ellipsis path)", () => {
    const html = renderToStaticMarkup(
      <ConversationActionsSheet
        open={false}
        onOpenChange={() => {}}
        onArchive={() => {}}
        trigger={<button aria-label="Conversation actions" />}
      />,
    );
    expect(html).toContain('aria-label="Conversation actions"');
    expect(html).toContain("Archive");
  });

  test("omits a trigger when none is provided (row long-press path)", () => {
    const html = renderToStaticMarkup(
      <ConversationActionsSheet
        open
        onOpenChange={() => {}}
        onArchive={() => {}}
      />,
    );
    // The header always carries a close button, so absence of a trigger is
    // asserted against the trigger's own marker rather than `<button`.
    expect(html).not.toContain('data-testid="trigger"');
    expect(html).toContain("Archive");
  });

  test("hides Open in New Window on native iOS", () => {
    mockIsNativePlatform = true;
    const html = renderToStaticMarkup(
      <ConversationActionsSheet
        open
        onOpenChange={() => {}}
        variant="header"
        onOpenInNewWindow={() => {}}
        onPinToggle={() => {}}
      />,
    );
    expect(html).not.toContain("Open in New Window");
    expect(html).toContain("Pin");
  });
});

describe("renderConversationMenuItemsAsPanelItems", () => {
  test("flattens the item set into panel rows with a close handler", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItemsAsPanelItems({
          t,
          onPinToggle: () => {},
          onRename: () => {},
          onArchive: () => {},
          onDelete: () => {},
          onClose: () => {},
        })}
      </>,
    );
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
    expect(html).toContain("Archive");
    expect(html).toContain("Delete");
  });

  test("renders the channel source link row when provided", () => {
    const html = renderToStaticMarkup(
      <>
        {renderConversationMenuItemsAsPanelItems({
          t,
          variant: "header",
          channelSourceLink: {
            href: "https://slack.com/archives/C01ABC/p1700000000000100",
            label: "Open in Slack",
          },
          onPinToggle: () => {},
          onClose: () => {},
        })}
      </>,
    );
    expect(html).toContain("Open in Slack");
  });
});

describe("ConversationActionsMenu — read-only conversations", () => {
  test("Archive renders when read-only (organizational action)", () => {
    mockIsTouchMobile = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        isReadonly
        onArchive={() => {}}
        onMarkUnread={() => {}}
      />,
    );
    expect(html).toContain("Archive");
    expect(html).not.toContain("Mark as unread");
  });

  test("Unarchive renders when archived and read-only", () => {
    mockIsTouchMobile = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu isReadonly isArchived onUnarchive={() => {}} />,
    );
    expect(html).toContain("Unarchive");
  });
});
