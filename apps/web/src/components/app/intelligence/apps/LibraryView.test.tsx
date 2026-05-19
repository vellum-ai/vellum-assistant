/**
 * Tests for the `LibraryAppCardActionsMenu` extracted from `LibraryView`.
 *
 * Verifies the mobile vs desktop branch — desktop renders a Radix dropdown
 * (`role="menu"`); mobile renders a Radix Dialog (BottomSheet). Selecting
 * Pin / Delete forwards the corresponding callback to the parent.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@/test-utils.js";

import { LibraryAppCardActionsMenu } from "@/components/app/intelligence/apps/LibraryView.js";

function resetBodyLockAttributes() {
  document.body.removeAttribute("style");
  document.body.removeAttribute("data-scroll-locked");
}

beforeEach(() => {
  cleanup();
  resetBodyLockAttributes();
});

afterEach(() => {
  cleanup();
  resetBodyLockAttributes();
});

describe("LibraryAppCardActionsMenu", () => {
  test("desktop branch renders Radix dropdown menu with Pin and Delete rows", () => {
    const onPin = mock(() => {});
    const onDelete = mock(() => {});
    render(
      <LibraryAppCardActionsMenu
        appName="My App"
        isPinned={false}
        open
        onOpenChange={() => {}}
        onPin={onPin}
        onDelete={onDelete}
        isMobile={false}
      />,
    );
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const pinItem = screen.getByRole("menuitem", { name: "Pin" });
    fireEvent.click(pinItem);
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  test("mobile branch renders BottomSheet (role=dialog) with Pin and Delete rows", () => {
    const onPin = mock(() => {});
    const onDelete = mock(() => {});
    const onOpenChange = mock((_next: boolean) => {});
    render(
      <LibraryAppCardActionsMenu
        appName="My App"
        isPinned
        open
        onOpenChange={onOpenChange}
        onPin={onPin}
        onDelete={onDelete}
        isMobile
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute("data-state")).toBe("open");
    // Pinned state shows "Unpin"
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  test("mobile branch omits Delete row when onDelete is not provided", () => {
    render(
      <LibraryAppCardActionsMenu
        appName="My App"
        isPinned={false}
        open
        onOpenChange={() => {}}
        onPin={() => {}}
        isMobile
      />,
    );
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });
});
