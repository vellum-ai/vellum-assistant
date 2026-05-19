/**
 * Tests for the `WorkspaceTreeCreateMenu` extracted from `WorkspaceTree`.
 *
 * Verifies the mobile vs desktop branch — desktop renders a Radix Popover
 * with the New File / New Folder rows; mobile renders a Radix Dialog
 * (BottomSheet). Selecting either row forwards `onSelectKind(kind)` to the
 * parent.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@/test-utils.js";

import { WorkspaceTreeCreateMenu } from "@/components/app/intelligence/WorkspaceTree.js";

let isMobileMock = false;
mock.module("@/lib/hooks/useIsMobile.js", () => ({
  useIsMobile: () => isMobileMock,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

beforeEach(() => {
  isMobileMock = false;
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(cleanup);

describe("WorkspaceTreeCreateMenu", () => {
  test("desktop branch renders Radix Popover content with New File / New Folder rows", () => {
    isMobileMock = false;
    const onSelectKind = mock((_kind: "file" | "folder") => {});
    render(
      <WorkspaceTreeCreateMenu
        open
        onOpenChange={() => {}}
        onSelectKind={onSelectKind}
      />,
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const newFile = screen.getByRole("menuitem", { name: "New File" });
    fireEvent.click(newFile);
    expect(onSelectKind).toHaveBeenCalledWith("file");
  });

  test("mobile branch renders BottomSheet (role=dialog) with New File / New Folder rows", () => {
    isMobileMock = true;
    const onSelectKind = mock((_kind: "file" | "folder") => {});
    render(
      <WorkspaceTreeCreateMenu
        open
        onOpenChange={() => {}}
        onSelectKind={onSelectKind}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-state")).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "New Folder" }));
    expect(onSelectKind).toHaveBeenCalledWith("folder");
  });
});
