/**
 * The row's trailing control under `sidebar-done`.
 *
 * Two things have to hold at once and neither is visible from the other: the
 * check replaces the "…" outright (the product decision is that a row carries
 * one command), and the actions it displaced are still on the row's
 * right-click menu. So the ellipsis assertion and the Rename/Delete assertion
 * are the same test's two halves.
 *
 * The design library needs browser APIs its primitives assume, so the pieces
 * this file exercises are mocked down to plain elements: a `PanelItem` that
 * renders its own trailing slot, and a `ContextMenu` that renders its content
 * inline so the menu items are in the tree without a pointer gesture. The row
 * animates its exit on the elements its `PanelItem` and swipe box render, so
 * both mocks keep the ref.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { createElement, type ReactNode, type Ref } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

mock.module("@vellumai/design-library", () => ({
  PanelItem: ({
    label,
    onSelect,
    trailingAction,
    ref,
  }: {
    label: string;
    onSelect?: () => void;
    trailingAction?: ReactNode;
    ref?: Ref<HTMLDivElement>;
  }) =>
    createElement(
      "div",
      { "data-testid": "panel-item", ref },
      createElement("button", { type: "button", onClick: onSelect }, label),
      trailingAction,
    ),
  Tooltip: ({ children }: { children: ReactNode }) => children,
  ContextMenu: {
    Root: ({ children }: { children: ReactNode }) => children,
    Trigger: ({ children }: { children: ReactNode }) => children,
    Content: ({ children }: { children: ReactNode }) =>
      createElement("div", { "data-testid": "context-menu" }, children),
    Item: ({ children }: { children: ReactNode }) =>
      createElement("div", { "data-testid": "menu-item" }, children),
    Separator: () => null,
    Sub: ({ children }: { children: ReactNode }) => children,
    SubTrigger: ({ children }: { children: ReactNode }) => children,
    SubContent: ({ children }: { children: ReactNode }) => children,
  },
}));

mock.module("@vellumai/design-library/utils/cn", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

mock.module("@/components/swipe-action-reveal", () => ({
  SwipeActionReveal: ({
    children,
    ref,
  }: {
    children: ReactNode;
    ref?: Ref<HTMLDivElement>;
  }) => createElement("div", { ref }, children),
}));

mock.module("@/domains/chat/components/thread-status-indicator", () => ({
  hasThreadStatus: () => false,
  ThreadStatusIndicator: () => null,
}));

import { ConversationRow } from "@/domains/chat/components/conversation-row";
import {
  ConversationListProvider,
  type ConversationListContextValue,
} from "@/domains/chat/components/conversation-list-context";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type { Conversation } from "@/types/conversation-types";

const CONVERSATION: Conversation = {
  conversationId: "conv-xyz",
  title: "Launch review brief",
};

function renderRow(ctx: Partial<ConversationListContextValue>) {
  return render(
    createElement(
      ConversationListProvider,
      { value: { onSelect: () => {}, ...ctx } },
      createElement(ConversationRow, { conversation: CONVERSATION }),
    ),
  );
}

const originalMatchMedia = window.matchMedia;

/* A mouse: hover-capable, fine pointer, no reduced-motion preference. The
   row's trailing control exists at all only where the device can hover. */
function mouseMatchMedia(query: string) {
  return {
    matches: query === "(hover: hover)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: mouseMatchMedia,
  });
});

afterEach(() => {
  cleanup();
  useClientFeatureFlagStore.setState({ sidebarDone: false });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

afterAll(() => {
  mock.restore();
});

describe("ConversationRow: sidebar-done off", () => {
  test("the trailing control is the actions menu, not a check", () => {
    const { queryByLabelText, getByLabelText } = renderRow({
      onArchive: () => {},
      onRename: () => {},
    });
    expect(getByLabelText("Conversation actions")).toBeDefined();
    expect(queryByLabelText("Mark as done")).toBeNull();
  });

  test("the row menu keeps the archive wording", () => {
    const { getByTestId } = renderRow({
      onArchive: () => {},
      onRename: () => {},
      onDelete: () => {},
    });
    const menu = getByTestId("context-menu").textContent ?? "";
    expect(menu).toContain("Archive");
    expect(menu).not.toContain("Mark as done");
  });
});

describe("ConversationRow: sidebar-done on", () => {
  beforeEach(() => {
    useClientFeatureFlagStore.setState({ sidebarDone: true });
  });

  test("the trailing control is a Done check and the 3-dot is gone", () => {
    const { getByLabelText, queryByLabelText } = renderRow({
      onArchive: () => {},
      onRename: () => {},
    });
    expect(getByLabelText("Mark as done")).toBeDefined();
    expect(queryByLabelText("Conversation actions")).toBeNull();
  });

  test("the check is a focusable button that archives on activation", async () => {
    const archived: string[] = [];
    const { getByLabelText } = renderRow({
      onArchive: (conversation) => archived.push(conversation.conversationId),
    });
    const check = getByLabelText("Mark as done");
    expect(check.tagName).toBe("BUTTON");
    // A `<button>` answers Enter and Space as a click, so the pointer path
    // and the keyboard path are the same handler. The archive lands once the
    // row has left.
    fireEvent.click(check);
    await waitFor(() => expect(archived).toEqual(["conv-xyz"]));
  });

  test("selecting the row is unaffected by the check beside it", () => {
    const selected: string[] = [];
    const { getByText } = renderRow({
      onSelect: (id) => selected.push(id),
      onArchive: () => {},
    });
    fireEvent.click(getByText("Launch review brief"));
    expect(selected).toEqual(["conv-xyz"]);
  });

  test("Rename and Delete stay on the row's right-click menu", () => {
    const { getByTestId } = renderRow({
      onArchive: () => {},
      onRename: () => {},
      onDelete: () => {},
    });
    const menu = getByTestId("context-menu").textContent ?? "";
    expect(menu).toContain("Rename");
    expect(menu).toContain("Delete");
    // And the menu's own archive item reads as completion.
    expect(menu).toContain("Mark as done");
    expect(menu).not.toContain("Archive");
  });

  test("no check where the row cannot be archived", () => {
    const { queryByLabelText } = renderRow({});
    expect(queryByLabelText("Mark as done")).toBeNull();
  });

  /* The row menu is the only path to Rename and Delete now, and the
     context-menu key fires `contextmenu` on whatever holds focus. The check
     is the row's one focusable control, so an event swallowed there would
     take that path with it. */
  test("the check lets a contextmenu event through to the row's trigger", () => {
    const { getByLabelText } = renderRow({
      onArchive: () => {},
      onRename: () => {},
    });
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    getByLabelText("Mark as done").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  /* The collapse is a courtesy and the write is not: a row torn off the
     screen mid-animation (a navigation, a section remount) still has to
     send the archive the user asked for. */
  test("a row unmounted mid-collapse still archives", () => {
    const archived: string[] = [];
    const { getByLabelText, unmount } = renderRow({
      onArchive: (conversation) => archived.push(conversation.conversationId),
    });

    fireEvent.click(getByLabelText("Mark as done"));
    // The collapse is still running: nothing has been written yet.
    expect(archived).toEqual([]);

    unmount();
    expect(archived).toEqual(["conv-xyz"]);
  });
});
