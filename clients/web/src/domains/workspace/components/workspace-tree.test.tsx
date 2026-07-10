/**
 * Tests for `WorkspaceTreeCreateMenu` and `searchWorkspaceTree`.
 *
 * Menu tests verify the mobile vs desktop branch — desktop renders a Radix
 * dropdown Menu with the New File / New Folder rows; mobile renders a
 * BottomSheet (Radix Dialog). Selecting either row forwards
 * `onSelectKind(kind)` to the parent.
 *
 * Search tests drive the recursive tree walk against a fake directory
 * listing, verifying that matches and their ancestors are surfaced and that
 * matched directories are not descended into.
 *
 * Uses `renderToStaticMarkup` + `mock.module` for design library compounds
 * (same pattern as conversation-actions-menu.test.tsx).
 */

import { QueryClient } from "@tanstack/react-query";
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
      createElement(
        "div",
        { "data-testid": "bs-trigger" },
        children as ReactNode,
      ),
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
      createElement(
        "div",
        { "data-testid": "menu-trigger" },
        children as ReactNode,
      ),
    // Mirror the roles the real Radix menu primitives render with.
    Content: ({ children }: Record<string, unknown>) =>
      createElement("div", { role: "menu" }, children as ReactNode),
    Item: ({
      children,
      onSelect,
      leftIcon: _leftIcon,
    }: Record<string, unknown>) =>
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

const listedPaths: string[] = [];

const makeEntry = (path: string, type: "directory" | "file") => ({
  name: path.split("/").pop() ?? "",
  path,
  type,
  size: type === "file" ? 1 : null,
  mimeType: type === "file" ? "text/plain" : null,
  modifiedAt: "2026-01-01T00:00:00.000Z",
});

const FAKE_TREE: Record<string, ReturnType<typeof makeEntry>[]> = {
  "": [
    makeEntry("archive", "directory"),
    makeEntry("bin", "directory"),
    makeEntry("readme.md", "file"),
  ],
  archive: [
    makeEntry("archive/projects", "directory"),
    makeEntry("archive/notes.md", "file"),
  ],
  "archive/projects": [
    makeEntry("archive/projects/AgentWatch", "directory"),
    makeEntry("archive/projects/log.txt", "file"),
  ],
  "archive/projects/AgentWatch": [
    makeEntry("archive/projects/AgentWatch/main.ts", "file"),
  ],
  bin: [makeEntry("bin/tool.sh", "file")],
};

mock.module("@/generated/daemon/sdk.gen", () => ({
  workspaceTreeGet: async ({ query }: { query?: { path?: string } }) => {
    const path = query?.path ?? "";
    listedPaths.push(path);
    const entries = FAKE_TREE[path];
    return entries
      ? { data: { path, entries }, error: undefined }
      : { data: undefined, error: "not found" };
  },
  workspaceDeletePost: async () => ({}),
  workspaceMkdirPost: async () => ({}),
  workspaceRenamePost: async () => ({}),
  workspaceWritePost: async () => ({}),
}));

import { searchWorkspaceTree, WorkspaceTreeCreateMenu } from "./workspace-tree";

beforeEach(() => {
  mockIsMobile = false;
  listedPaths.length = 0;
});

describe("searchWorkspaceTree", () => {
  const search = (searchLower: string) =>
    searchWorkspaceTree(new QueryClient(), {
      assistantId: "a1",
      includeDirSizes: false,
      searchLower,
      showHidden: false,
    });

  test("surfaces a nested matching folder and expands its ancestors", async () => {
    const result = await search("agentwatch");
    expect([...result.visiblePaths].sort()).toEqual([
      "archive",
      "archive/projects",
      "archive/projects/AgentWatch",
    ]);
    expect([...result.expandedPaths].sort()).toEqual([
      "archive",
      "archive/projects",
    ]);
    expect(result.truncated).toBe(false);
  });

  test("does not descend into a matched directory", async () => {
    await search("agentwatch");
    expect(listedPaths).not.toContain("archive/projects/AgentWatch");
  });

  test("finds files nested in non-matching directories", async () => {
    const result = await search("main");
    expect(result.visiblePaths.has("archive/projects/AgentWatch/main.ts")).toBe(
      true,
    );
    expect(result.expandedPaths.has("archive/projects/AgentWatch")).toBe(true);
    expect(result.visiblePaths.has("bin")).toBe(false);
  });

  test("returns empty sets when nothing matches", async () => {
    const result = await search("zzz-no-such-entry");
    expect(result.visiblePaths.size).toBe(0);
    expect(result.expandedPaths.size).toBe(0);
  });
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
