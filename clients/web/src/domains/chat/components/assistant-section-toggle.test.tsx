/**
 * Tests for `AssistantSectionToggle`: the round control beside the assistant
 * pill that opens her section beneath it. What it says (name, expanded
 * state), what it wears (the chat glyph in both states, the avatar colour),
 * and when it carries the section's activity dot.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ConversationListProvider,
  type ConversationListContextValue,
} from "@/domains/chat/components/conversation-list-context";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import type { Conversation } from "@/types/conversation-types";

let accentHex: string | null = "#0e9b8b";
let conversations: Conversation[] = [];
let attention = new Set<string>();

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    accentHex,
    accent: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

mock.module("@/domains/chat/use-section-conversations", () => ({
  useSectionConversations: () => ({
    conversations,
    hasMore: false,
    loadMore: () => {},
    getAllRows: async () => conversations,
  }),
}));

const { AssistantSectionToggle } =
  await import("@/domains/chat/components/assistant-section-toggle");

const SECTION: SidebarSection = {
  type: "assistant",
  key: "assistant",
  label: "From me",
  all: [],
  unread: 0,
};

function renderToggle(open: boolean, onToggle = () => {}) {
  const ctx = {
    processingConversationIds: new Set<string>(),
    attentionConversationIds: attention,
  } as unknown as ConversationListContextValue;
  return render(
    <ConversationListProvider value={ctx}>
      <AssistantSectionToggle
        assistantId="a1"
        section={SECTION}
        assistantName="Haze II"
        open={open}
        onToggle={onToggle}
      />
    </ConversationListProvider>,
  );
}

beforeEach(() => {
  accentHex = "#0e9b8b";
  conversations = [];
  attention = new Set();
});

afterEach(() => {
  cleanup();
});

describe("AssistantSectionToggle", () => {
  test("closed: a chat glyph, named for showing the threads", () => {
    const { container } = renderToggle(false);
    const button = screen.getByRole("button", {
      name: "Show threads from Haze II",
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".lucide-message-square")).not.toBeNull();
  });

  test("open: the same chat glyph, named for hiding them", () => {
    const { container } = renderToggle(true);
    const button = screen.getByRole("button", {
      name: "Hide threads from Haze II",
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".lucide-message-square")).not.toBeNull();
    expect(container.querySelector(".lucide-chevron-up")).toBeNull();
  });

  test("wears the avatar colour, and the plain surface without one", () => {
    const { container, unmount } = renderToggle(false);
    const teal = container.querySelector<HTMLElement>("button")!;
    expect(teal.style.backgroundColor).toBe("#0e9b8b");
    // White ink on a dark colour; no shadow, the disc sits flat like the
    // pill's own.
    expect(teal.style.color.toLowerCase()).toBe("#ffffff");
    expect(teal.className).not.toContain("shadow");
    unmount();

    accentHex = "#f5c518";
    const yellow = renderToggle(false);
    expect(
      yellow.container
        .querySelector<HTMLElement>("button")!
        .style.color.toLowerCase(),
    ).toBe("#1a1a1a");
    yellow.unmount();

    accentHex = null;
    const plain = renderToggle(false);
    const button = plain.container.querySelector<HTMLElement>("button")!;
    expect(button.style.backgroundColor).toBe("");
    expect(button.className).toContain("bg-[var(--surface-active)]");
  });

  test("a thread waiting on the user puts the dot on the closed toggle", () => {
    conversations = [{ conversationId: "c1" } as Conversation];
    attention = new Set(["c1"]);
    const closed = renderToggle(false);
    expect(
      closed.container.querySelector("[data-slot='group-indicator-dot']"),
    ).not.toBeNull();
    closed.unmount();

    // Open, the rows carry their own state and the dot steps aside.
    const open = renderToggle(true);
    expect(
      open.container.querySelector("[data-slot='group-indicator-dot']"),
    ).toBeNull();
  });

  test("clicking toggles", () => {
    const onToggle = mock(() => {});
    renderToggle(false, onToggle);
    fireEvent.click(screen.getByRole("button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
