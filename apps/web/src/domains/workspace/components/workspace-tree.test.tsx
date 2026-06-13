/**
 * Tests for `WorkspaceTreeCreateMenu`.
 *
 * Verifies the mobile vs desktop branch — desktop renders a Radix dropdown
 * Menu with the New File / New Folder rows; mobile renders a BottomSheet
 * (Radix Dialog). Selecting either row forwards `onSelectKind(kind)` to the
 * parent.
 *
 * Uses `renderToStaticMarkup` + `mock.module` for design library compounds
 * (same pattern as conversation-actions-menu.test.tsx).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let mockIsMobile = false;
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => mockIsMobile,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);

mock.module("@vellumai/design-library/components/bottom-sheet", () => ({
  BottomSheet: {
    Root: passthrough,
    Trigger: ({ children }: Record<string, unknown>) =>
      createElement("div", { "data-testid": "bs-trigger" }, children as ReactNode),
    Content: passthrough,
    Header: passthrough,
    Title: ({ children }: Record<string, unknown>) =>
      createElement("span", null, children as ReactNode),
    Body: passthrough,
  },
}));

mock.module("@vellumai/design-library/components/menu", () => ({
  Menu: {
    Root: passthrough,
    Trigger: ({ children }: Record<string, unknown>) =>
      createElement("div", { "data-testid": "menu-trigger" }, children as ReactNode),
    // Mirror the roles the real Radix menu primitives render with.
    Content: ({ children }: Record<string, unknown>) =>
      createElement("div", { role: "menu" }, children as ReactNode),
    Item: ({ children, onSelect, leftIcon: _leftIcon }: Record<string, unknown>) =>
      createElement(
        "button",
        { role: "menuitem", onClick: onSelect as () => void },
        children as ReactNode,
      ),
  },
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    role,
    onClick,
    iconOnly: _iconOnly,
    tintColor: _tintColor,
    leftIcon: _leftIcon,
    ...rest
  }: Record<string, unknown>) =>
    createElement(
      "button",
      { role, onClick, "data-testid": "button", ...rest },
      children as ReactNode,
    ),
}));

mock.module("@vellumai/design-library/components/panel-item", () => ({
  PanelItem: ({ label, onSelect }: Record<string, unknown>) =>
    createElement(
      "button",
      { "data-testid": "panel-item", onClick: onSelect as () => void },
      label as string,
    ),
}));

import { WorkspaceTreeCreateMenu } from "./workspace-tree";

beforeEach(() => {
  mockIsMobile = false;
});

describe("WorkspaceTreeCreateMenu", () => {
  test("desktop branch renders Menu with New File / New Folder items", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      createElement(WorkspaceTreeCreateMenu, {
        open: true,
        onOpenChange: () => {},
        onSelectKind: () => {},
      }),
    );
    expect(html).toContain("New File");
    expect(html).toContain("New Folder");
    expect(html).toContain('role="menu"');
    expect(html).toContain('role="menuitem"');
  });

  test("mobile branch renders BottomSheet with PanelItem rows", () => {
    mockIsMobile = true;
    const html = renderToStaticMarkup(
      createElement(WorkspaceTreeCreateMenu, {
        open: true,
        onOpenChange: () => {},
        onSelectKind: () => {},
      }),
    );
    expect(html).toContain("New File");
    expect(html).toContain("New Folder");
    expect(html).toContain('data-testid="panel-item"');
  });

  test("desktop branch includes menuitem roles for accessibility", () => {
    mockIsMobile = false;
    const html = renderToStaticMarkup(
      createElement(WorkspaceTreeCreateMenu, {
        open: true,
        onOpenChange: () => {},
        onSelectKind: () => {},
      }),
    );
    const menuitemCount = (html.match(/role="menuitem"/g) ?? []).length;
    expect(menuitemCount).toBe(2);
  });
});
