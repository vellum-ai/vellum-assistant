/**
 * Touch long-press behavior for `ConversationRow`.
 *
 * On coarse pointers the row opens the actions BottomSheet on long-press
 * instead of Radix's ContextMenu popover, and the compatibility click that
 * the browser emits after a long-press must NOT reach `PanelItem.onSelect`
 * (which would navigate to the conversation behind the sheet).
 *
 * The web workspace lacks a coarse-pointer environment, so we mock
 * `use-long-press` to expose its activation callback and mock the design
 * library so `PanelItem` is a plain clickable element wired to `onSelect`.
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
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

// Capture the long-press activation callback so tests can fire it directly.
let longPressActivate: (() => void) | null = null;
mock.module("@/hooks/use-long-press", () => ({
  useLongPress: (cb: () => void) => {
    longPressActivate = cb;
    return {
      onTouchStart: () => {},
      onTouchMove: () => {},
      onTouchEnd: () => {},
      onTouchCancel: () => {},
    };
  },
}));

// Minimal design-library mocks. PanelItem renders a button wired to onSelect
// so a click exercises the real selection path.
mock.module("@vellumai/design-library", () => ({
  PanelItem: ({ label, onSelect }: { label: string; onSelect?: () => void }) =>
    createElement(
      "button",
      { type: "button", "data-testid": "panel-item", onClick: onSelect },
      label,
    ),
  ContextMenu: {
    Root: ({ children }: { children: ReactNode }) => children,
    Trigger: ({ children }: { children: ReactNode }) => children,
    Content: ({ children }: { children: ReactNode }) => children,
    Item: ({ children }: { children: ReactNode }) => children,
    Separator: () => null,
  },
}));

mock.module("@vellumai/design-library/utils/cn", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

mock.module("@/components/swipe-action-reveal", () => ({
  SwipeActionReveal: ({ children }: { children: ReactNode }) => children,
}));

let sheetActionSpy: (() => void) | null = null;
mock.module("@/domains/chat/components/conversation-actions-menu", () => ({
  ConversationActionsMenu: () =>
    createElement("div", { "data-testid": "ellipsis" }),
  ConversationActionsSheet: ({ open }: { open: boolean }) =>
    open
      ? createElement(
          "div",
          { "data-testid": "actions-sheet" },
          createElement(
            "button",
            {
              type: "button",
              "data-testid": "sheet-action",
              onClick: () => sheetActionSpy?.(),
            },
            "Pin",
          ),
        )
      : null,
  renderConversationMenuItems: () => null,
}));

mock.module("@/domains/chat/components/thread-status-indicator", () => ({
  hasThreadStatus: () => false,
  ThreadStatusIndicator: () => null,
}));

import { ConversationRow } from "@/domains/chat/components/conversation-row";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import type { ConversationListContextValue } from "@/domains/chat/components/conversation-list-context";
import type { UseDragReorderResult } from "@/domains/chat/hooks/use-drag-reorder";
import type { Conversation } from "@/types/conversation-types";

const stubDragReorder: UseDragReorderResult<Conversation> = {
  getItemProps: () => ({
    draggable: true,
    onDragStart: () => {},
    onDragOver: () => {},
    onDragLeave: () => {},
    onDrop: () => {},
    onDragEnd: () => {},
  }),
  draggingId: null,
  dropIndicator: null,
};

function renderRow(onSelect: (id: string) => void) {
  const ctx: ConversationListContextValue = {
    onSelect,
    dragReorder: stubDragReorder,
    canReorder: false,
  };
  return render(
    createElement(
      ConversationListProvider,
      { value: ctx },
      createElement(ConversationRow, {
        conversation: { conversationId: "c1", title: "Chat" } as Conversation,
      }),
    ),
  );
}

const originalMatchMedia = window.matchMedia;

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
  longPressActivate = null;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});
beforeEach(() => {
  longPressActivate = null;
  sheetActionSpy = null;
  // Drive the coarse-pointer branch via matchMedia (what isPointerCoarse
  // reads) rather than mocking the module — module mocks are process-global
  // in bun and would leak into sibling suites' fine-pointer assertions.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

describe("ConversationRow — touch long-press", () => {
  test("a plain tap selects the conversation", () => {
    const onSelect = mock(() => {});
    const { getByTestId } = renderRow(onSelect);
    fireEvent.click(getByTestId("panel-item"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("long-press opens the actions sheet", () => {
    const { getByTestId, queryByTestId } = renderRow(() => {});
    expect(queryByTestId("actions-sheet")).toBeNull();
    act(() => longPressActivate?.());
    expect(getByTestId("actions-sheet")).not.toBeNull();
  });

  test("the compatibility click after a long-press does not select the conversation", () => {
    const onSelect = mock(() => {});
    const { getByTestId } = renderRow(onSelect);

    // Long-press fires, then the browser emits a compat click on touchend.
    act(() => longPressActivate?.());
    fireEvent.click(getByTestId("panel-item"));

    // The follow-up click is swallowed — no navigation behind the sheet.
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("a genuine tap after the long-press click is swallowed still selects", () => {
    const onSelect = mock(() => {});
    const { getByTestId } = renderRow(onSelect);

    act(() => longPressActivate?.());
    fireEvent.click(getByTestId("panel-item")); // swallowed compat click
    expect(onSelect).not.toHaveBeenCalled();

    // The guard is one-shot: the next real tap selects normally.
    fireEvent.click(getByTestId("panel-item"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("a tap on a sheet action is not swallowed by the row's compat-click guard", () => {
    const spy = mock(() => {});
    sheetActionSpy = spy;
    const { getByTestId } = renderRow(() => {});

    // Long-press opens the sheet and arms the compat-click guard. If the
    // post-long-press compat click is suppressed/rerouted by the browser, the
    // guard stays armed — but because the sheet is a sibling of the capture
    // wrapper (not a child), the user's tap on a sheet action still runs.
    act(() => longPressActivate?.());
    fireEvent.click(getByTestId("sheet-action"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
