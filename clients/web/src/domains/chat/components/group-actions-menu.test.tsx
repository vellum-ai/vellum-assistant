/**
 * Tests for the shared section-header ("group") menu.
 *
 * The same {@link GroupMenuItemsProps} shape feeds three surfaces — the
 * desktop right-click ContextMenu, the "…" Popover, and the mobile
 * BottomSheet — so the assertions here are mostly about parity: whatever
 * actions are wired must show up on whichever surface the user reaches for.
 */

import { describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

let mockIsTouchMobile = false;
mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => mockIsTouchMobile,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));

import {
  GroupActionsMenu,
  hasAnyGroupMenuAction,
  renderGroupMenuItemsAsPanelItems,
} from "@/domains/chat/components/group-actions-menu";
import { fixedT } from "@/i18n";

// The renderers take a namespace-bound `t`, the same thing
// `useTranslation("chat")` hands their component callers.
const t = fixedT("chat");

const allActions = {
  onMarkAllRead: () => {},
  hasUnreadConversations: true,
  onArchiveAll: () => {},
  hasConversations: true,
  onRename: () => {},
  onDelete: () => {},
  onCopyGroupId: () => {},
};

async function openMenu(label = "Group actions") {
  const trigger = document.querySelector<HTMLElement>(
    `[aria-label="${label}"]`,
  );
  expect(trigger).not.toBeNull();
  act(() => {
    trigger?.click();
  });
  await waitFor(() => {
    expect(document.body.textContent).toContain("Mark All as Read");
  });
}

describe("hasAnyGroupMenuAction", () => {
  test("false when no callback is wired", () => {
    // `hasConversations` alone describes state, not an available action —
    // it must not be enough to mount an empty menu surface.
    expect(hasAnyGroupMenuAction({ hasConversations: true })).toBe(false);
  });

  test("true as soon as one callback is wired", () => {
    expect(hasAnyGroupMenuAction({ onMarkAllRead: () => {} })).toBe(true);
    expect(hasAnyGroupMenuAction({ onDelete: () => {} })).toBe(true);
    expect(hasAnyGroupMenuAction({ onCopyGroupId: () => {} })).toBe(true);
  });
});

describe("GroupActionsMenu", () => {
  test("desktop branch: the Popover carries the bulk actions, not just Rename/Delete", async () => {
    mockIsTouchMobile = false;
    render(createElement(GroupActionsMenu, { label: "Work", ...allActions }));
    try {
      await openMenu("Work actions");
      // The "…" menu and the header's right-click menu render from the same
      // item set, so both carry the bulk actions, not just Rename/Delete.
      expect(document.body.textContent).toContain("Mark All as Read");
      expect(document.body.textContent).toContain("Archive All");
      expect(document.body.textContent).toContain("Rename");
      expect(document.body.textContent).toContain("Delete group");
      expect(document.body.textContent).toContain("Copy group ID");
    } finally {
      cleanup();
    }
  });

  test("mobile branch: renders a BottomSheet with the same item set", async () => {
    mockIsTouchMobile = true;
    render(createElement(GroupActionsMenu, { label: "Work", ...allActions }));
    try {
      await openMenu("Work actions");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.body.textContent).toContain("Archive All");
      expect(document.body.textContent).toContain("Rename");
    } finally {
      mockIsTouchMobile = false;
      cleanup();
    }
  });

  test("renders nothing when no action is wired", () => {
    mockIsTouchMobile = false;
    const { container } = render(
      createElement(GroupActionsMenu, { label: "Work" }),
    );
    try {
      expect(container.innerHTML).toBe("");
    } finally {
      cleanup();
    }
  });

  test("running an action closes the surface", async () => {
    mockIsTouchMobile = false;
    let renamed = 0;
    render(
      createElement(GroupActionsMenu, {
        label: "Work",
        ...allActions,
        onRename: () => {
          renamed += 1;
        },
      }),
    );
    try {
      await openMenu("Work actions");
      const rename = Array.from(
        document.querySelectorAll<HTMLElement>('[role="button"]'),
      ).find((el) => el.textContent?.trim() === "Rename");
      act(() => {
        rename?.click();
      });
      expect(renamed).toBe(1);
      await waitFor(() => {
        expect(document.body.textContent).not.toContain("Mark All as Read");
      });
    } finally {
      cleanup();
    }
  });
});

describe("renderGroupMenuItemsAsPanelItems", () => {
  test("a disabled bulk action is inert and announced as disabled", () => {
    const { container } = render(
      createElement(
        "div",
        null,
        renderGroupMenuItemsAsPanelItems({
          onMarkAllRead: () => {
            throw new Error("disabled item must not run");
          },
          hasUnreadConversations: false,
          onClose: () => {},
          t,
        }),
      ),
    );
    try {
      const row = container.querySelector<HTMLElement>(
        '[aria-disabled="true"]',
      );
      expect(row).not.toBeNull();
      expect(row?.textContent).toContain("Mark All as Read");
      // PanelItem's own `disabled` blocks activation while keeping the row's
      // button semantics, so clicking is a no-op rather than throwing.
      act(() => {
        row?.click();
      });
    } finally {
      cleanup();
    }
  });
});
