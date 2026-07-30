/**
 * Tests for {@link SidebarListContextMenu} - the sidebar's own right-click
 * menu, and the standalone group-creation entry point.
 *
 * The interesting property is that it layers over rows and section headers
 * that already own context menus, so most of what's asserted here is about
 * *not* firing when something more specific should.
 */

import { describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

mock.module("@/utils/pointer", () => ({
  isPointerCoarse: () => false,
}));

import { ContextMenu } from "@vellumai/design-library";

import { SidebarListContextMenu } from "@/domains/chat/components/sidebar-list-context-menu";

function rightClick(el: Element) {
  act(() => {
    el.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, button: 2 }),
    );
  });
}

describe("SidebarListContextMenu", () => {
  test("right-clicking the list offers New group…", async () => {
    const { container } = render(
      createElement(SidebarListContextMenu, {
        onCreateGroup: () => {},
        children: createElement("div", { "data-testid": "sections" }, "sections"),
      }),
    );
    try {
      rightClick(container.querySelector('[data-testid="sections"]')!);

      await waitFor(() => {
        expect(document.querySelector('[role="menu"]')?.textContent).toContain(
          "New group",
        );
      });
    } finally {
      cleanup();
    }
  });

  test("selecting New group… requests a group with no conversation", async () => {
    let created = 0;
    const { container } = render(
      createElement(SidebarListContextMenu, {
        onCreateGroup: () => (created += 1),
        children: createElement("div", { "data-testid": "sections" }, "sections"),
      }),
    );
    try {
      rightClick(container.querySelector('[data-testid="sections"]')!);

      await waitFor(() => {
        expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
      });
      act(() => {
        document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
      });

      await waitFor(() => expect(created).toBe(1));
    } finally {
      cleanup();
    }
  });

  // The whole reason `ContextMenu.Trigger` stops propagation: a row inside the
  // list has its own menu, and a right-click there must open that one only -
  // not both.
  test("a nested row menu wins; the list menu stays closed", async () => {
    const { container } = render(
      createElement(SidebarListContextMenu, {
        onCreateGroup: () => {},
        children: createElement(
          ContextMenu.Root,
          null,
          createElement(
            ContextMenu.Trigger,
            null,
            createElement("div", { "data-testid": "row" }, "a row"),
          ),
          createElement(
            ContextMenu.Content,
            null,
            createElement(ContextMenu.Item, null, "Row action"),
          ),
        ),
      }),
    );
    try {
      rightClick(container.querySelector('[data-testid="row"]')!);

      await waitFor(() => {
        expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
      });
      expect(document.querySelector('[role="menu"]')?.textContent).toContain(
        "Row action",
      );
      expect(
        document.querySelector('[role="menu"]')?.textContent,
      ).not.toContain("New group");
    } finally {
      cleanup();
    }
  });

  test("renders children unwrapped when group creation isn't available", () => {
    const { container } = render(
      createElement(SidebarListContextMenu, {
        children: createElement("div", { "data-testid": "sections" }, "sections"),
      }),
    );
    try {
      expect(
        container.querySelector('[data-slot="sidebar-list-context-target"]'),
      ).toBeNull();
      expect(container.querySelector('[data-testid="sections"]')).not.toBeNull();
    } finally {
      cleanup();
    }
  });
});
