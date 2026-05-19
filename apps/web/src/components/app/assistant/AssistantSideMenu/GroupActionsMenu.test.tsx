/**
 * Tests for `GroupActionsMenu` (custom-conversation-group rename/delete
 * menu) — the mobile vs desktop branch.
 *
 * Desktop renders a Radix Popover; mobile renders a Radix Dialog
 * (BottomSheet). Both surfaces include Rename and Delete rows when the
 * corresponding callback is supplied.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@/test-utils.js";

let isMobileMock = false;
mock.module("@/lib/hooks/useIsMobile.js", () => ({
  useIsMobile: () => isMobileMock,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

import { GroupActionsMenu } from "@/components/app/assistant/AssistantSideMenu/AssistantSideMenu.js";

beforeEach(() => {
  isMobileMock = false;
  document.body.innerHTML = "";
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
});

afterEach(cleanup);

describe("GroupActionsMenu", () => {
  test("desktop branch: renders Popover content with Rename and Delete rows", () => {
    isMobileMock = false;
    const onRename = mock((_id: string) => {});
    const onDelete = mock((_id: string) => {});
    render(
      <GroupActionsMenu groupId="grp-1" onRename={onRename} onDelete={onDelete} />,
    );
    // Open the menu
    fireEvent.click(screen.getByRole("button", { name: "Group actions" }));
    // The popover's content is rendered into the document; rows are PanelItems
    // (rendered as <button>).
    const renameRow = screen.getByRole("button", { name: "Rename" });
    fireEvent.click(renameRow);
    expect(onRename).toHaveBeenCalledWith("grp-1");
  });

  test("mobile branch: renders BottomSheet (role=dialog) with Rename and Delete rows", () => {
    isMobileMock = true;
    const onRename = mock((_id: string) => {});
    const onDelete = mock((_id: string) => {});
    render(
      <GroupActionsMenu groupId="grp-2" onRename={onRename} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Group actions" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-state")).toBe("open");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("grp-2");
  });
});
