/**
 * The All chats page never says "Archive".
 *
 * The page only exists with `sidebar-done` on, so its rows pin the done
 * wording rather than reading it off the flag. The regression this guards is
 * the shared row menu falling back to the archive copy on a surface that has
 * no archive to speak of, which is what a story of the page (where nothing
 * sets the flag) would have shown.
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
import { cleanup, render } from "@testing-library/react";

mock.module("@vellumai/design-library", () => ({
  Button: ({
    "aria-label": ariaLabel,
    onClick,
  }: {
    "aria-label"?: string;
    onClick?: () => void;
  }) =>
    createElement("button", {
      type: "button",
      "aria-label": ariaLabel,
      onClick,
    }),
  PanelItem: ({
    label,
    trailingAction,
  }: {
    label: string;
    trailingAction?: ReactNode;
  }) => createElement("div", null, label, trailingAction),
  ContextMenu: {
    Root: ({ children }: { children: ReactNode }) => children,
    Trigger: ({ children }: { children: ReactNode }) => children,
    Content: ({ children }: { children: ReactNode }) =>
      createElement("div", { "data-testid": "context-menu" }, children),
    Item: ({ children }: { children: ReactNode }) =>
      createElement("div", null, children),
    Separator: () => null,
    Sub: ({ children }: { children: ReactNode }) => children,
    SubTrigger: ({ children }: { children: ReactNode }) => children,
    SubContent: ({ children }: { children: ReactNode }) => children,
  },
  FilterChip: () => null,
  Input: () => null,
  VirtualList: () => null,
}));

import { AllChatsRow } from "@/domains/chat/pages/all-chats-page";
import { ConversationListProvider } from "@/domains/chat/components/conversation-list-context";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import type { Conversation } from "@/types/conversation-types";

/** A fixed clock, so the row's relative timestamp is not the thing under test. */
const NOW = Date.UTC(2026, 8, 18, 16, 30);

const CONVERSATION: Conversation = {
  conversationId: "conv-xyz",
  title: "Launch review brief",
};

function renderRow(conversation: Conversation) {
  return render(
    createElement(
      ConversationListProvider,
      {
        value: {
          onSelect: () => {},
          onArchive: () => {},
          onUnarchive: () => {},
          onRename: () => {},
          onDelete: () => {},
        },
      },
      createElement(AllChatsRow, { conversation, now: new Date(NOW) }),
    ),
  );
}

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === "(hover: hover)",
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

describe("AllChatsRow", () => {
  test("the right-click menu reads as completion even with the flag store off", () => {
    const { getByTestId } = renderRow(CONVERSATION);
    const menu = getByTestId("context-menu").textContent ?? "";
    expect(menu).toContain("Mark as done");
    expect(menu).not.toContain("Archive");
  });

  test("a done row's menu offers Reopen, never Unarchive", () => {
    const { getByTestId } = renderRow({
      ...CONVERSATION,
      archivedAt: 1_700_000_000_000,
    });
    const menu = getByTestId("context-menu").textContent ?? "";
    expect(menu).toContain("Reopen");
    expect(menu).not.toContain("Unarchive");
  });

  test("the row's own toggle is named the same way", () => {
    const { getByLabelText } = renderRow(CONVERSATION);
    expect(getByLabelText("Mark as done")).toBeDefined();
  });
});
