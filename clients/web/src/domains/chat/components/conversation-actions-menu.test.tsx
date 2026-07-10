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
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
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
    { "data-testid": "menu-item", "data-disabled": disabled || undefined, ...rest },
    leftIcon as ReactNode,
    children as ReactNode,
  );
const mockSeparator = () => createElement("hr", { "data-testid": "separator" });
const mockSubTrigger = ({ children, leftIcon, ...rest }: Record<string, unknown>) =>
  createElement("div", { "data-testid": "sub-trigger", ...rest }, leftIcon as ReactNode, children as ReactNode);
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
  };

  const PanelItemMock = ({ label, icon: _icon, ...rest }: Record<string, unknown>) =>
    createElement("div", { "data-testid": "panel-item", ...rest }, label as string);

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
    renderConversationMenuItems,
    type ConversationMenuPrimitive,
} from "@/domains/chat/components/conversation-actions-menu";
import { Menu } from "@vellumai/design-library";

beforeEach(() => {
  mockIsMobile = false;
  mockIsNativePlatform = false;
});

// ---------------------------------------------------------------------------
// renderConversationMenuItems (pure helper)
// ---------------------------------------------------------------------------

describe("renderConversationMenuItems", () => {
  test("renders Pin and Rename when handlers are provided", () => {
    const html = renderToStaticMarkup(
      <>{renderConversationMenuItems({
        Primitive: Menu as unknown as ConversationMenuPrimitive,
        onPinToggle: () => {},
        onRename: () => {},
      })}</>,
    );
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });

  test("renders Unpin when isPinned is true", () => {
    const html = renderToStaticMarkup(
      <>{renderConversationMenuItems({
        Primitive: Menu as unknown as ConversationMenuPrimitive,
        isPinned: true,
        onPinToggle: () => {},
      })}</>,
    );
    expect(html).toContain("Unpin");
    expect(html).not.toContain(">Pin<");
  });

  test("renders Archive when onArchive is provided", () => {
    const html = renderToStaticMarkup(
      <>{renderConversationMenuItems({
        Primitive: Menu as unknown as ConversationMenuPrimitive,
        onArchive: () => {},
      })}</>,
    );
    expect(html).toContain("Archive");
  });

  test("renders Unarchive when isArchived and onUnarchive are provided", () => {
    const html = renderToStaticMarkup(
      <>{renderConversationMenuItems({
        Primitive: Menu as unknown as ConversationMenuPrimitive,
        isArchived: true,
        onUnarchive: () => {},
      })}</>,
    );
    expect(html).toContain("Unarchive");
  });

  test("hides Mark as unread when isReadonly", () => {
    const html = renderToStaticMarkup(
      <>{renderConversationMenuItems({
        Primitive: Menu as unknown as ConversationMenuPrimitive,
        isReadonly: true,
        onArchive: () => {},
        onMarkUnread: () => {},
      })}</>,
    );
    expect(html).toContain("Archive");
    expect(html).not.toContain("Mark as unread");
  });

  test("renders header variant with correct item order", () => {
    const html = renderToStaticMarkup(
      <>{renderConversationMenuItems({
        Primitive: Menu as unknown as ConversationMenuPrimitive,
        variant: "header",
        onCopyConversation: () => {},
        onForkConversation: () => {},
        onPinToggle: () => {},
        onRename: () => {},
      })}</>,
    );
    expect(html).toContain("Copy full conversation");
    expect(html).toContain("Fork conversation");
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });
});

// ---------------------------------------------------------------------------
// ConversationActionsMenu component
// ---------------------------------------------------------------------------

describe("ConversationActionsMenu — desktop branch", () => {
  test("renders the default ellipsis trigger with aria-label", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        onPinToggle={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Conversation actions"');
    expect(html).toContain("<button");
  });

  test("renders Pin and Rename items in the menu content", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        onPinToggle={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });
});

describe("ConversationActionsMenu — mobile branch", () => {
  test("renders BottomSheet surface on mobile", () => {
    mockIsMobile = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        onPinToggle={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("Conversation actions");
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });

  test("renders Archive on mobile when provided", () => {
    mockIsMobile = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu onArchive={() => {}} />,
    );
    expect(html).toContain("Archive");
  });
});

describe("renderConversationMenuItems — mark read/unread exclusivity", () => {
  test("onMarkRead takes precedence when both onMarkRead and onMarkUnread are provided", () => {
    const html = renderToStaticMarkup(
      <>{renderConversationMenuItems({
        Primitive: Menu as unknown as ConversationMenuPrimitive,
        onMarkRead: () => {},
        onMarkUnread: () => {},
      })}</>,
    );
    expect(html).toContain("Mark as read");
    expect(html).not.toContain("Mark as unread");
  });
});

describe("ConversationActionsMenu — mobile panel details", () => {
  test("isMarkUnreadDisabled renders disabled panel item on mobile", () => {
    mockIsMobile = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        onMarkUnread={() => {}}
        isMarkUnreadDisabled
      />,
    );
    expect(html).toContain("Mark as unread");
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("opacity-50");
  });

  test("hides Open in New Window on native iOS bottom sheet", () => {
    mockIsMobile = true;
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
    mockIsMobile = true;
    mockIsNativePlatform = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        variant="header"
        onOpenInNewWindow={() => {}}
        onPinToggle={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("Open in new window");
  });

  test("variant header renders header-order items on mobile", () => {
    mockIsMobile = true;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        variant="header"
        onCopyConversation={() => {}}
        onForkConversation={() => {}}
        onPinToggle={() => {}}
        onRename={() => {}}
      />,
    );
    expect(html).toContain("Copy full conversation");
    expect(html).toContain("Fork conversation");
    expect(html).toContain("Pin");
    expect(html).toContain("Rename");
  });
});

describe("ConversationActionsMenu — read-only conversations", () => {
  test("Archive renders when read-only (organizational action)", () => {
    mockIsMobile = false;
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
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      <ConversationActionsMenu
        isReadonly
        isArchived
        onUnarchive={() => {}}
      />,
    );
    expect(html).toContain("Unarchive");
  });
});
