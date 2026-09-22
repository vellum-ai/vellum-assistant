/**
 * Tests for `AssistantSectionToggle`: the round control beside the assistant
 * pill that opens her section beneath it, and its rail form. What it says
 * (name, expanded state), what it is (the accent `Button` with the chat
 * glyph, whose colour the app maps from the avatar), and when it carries the
 * section's activity dot.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  ConversationListProvider,
  type ConversationListContextValue,
} from "@/domains/chat/components/conversation-list-context";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import type { Conversation } from "@/types/conversation-types";
import { SIDEBAR_ASSISTANT_DISC_SIZE } from "@/components/sidebar-nav-geometry";
import { SIDE_MENU_TILE_SIZE } from "@vellumai/design-library";

let conversations: Conversation[] = [];
let attention = new Set<string>();

mock.module("@/domains/chat/use-section-conversations", () => ({
  useSectionConversations: () => ({
    conversations,
    hasMore: false,
    loadMore: () => {},
    getAllRows: async () => conversations,
  }),
}));

/* The flyout's rows need the whole conversation-row stack; what the rail
   toggle owns is which rows reach it. */
mock.module("@/domains/chat/components/conversation-rail-flyout", () => ({
  CollapsedGroupFlyout: ({
    conversations: rows,
  }: {
    conversations: Conversation[];
  }) => <div data-testid="rail-flyout">{rows.length} rows</div>,
}));

const { AssistantSectionRailToggle, AssistantSectionToggle } = await import(
  "@/domains/chat/components/assistant-section-toggle"
);

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

  test("is the design library's accent Button at the assistant row's disc size", () => {
    renderToggle(false);
    const button = screen.getByRole("button", {
      name: "Show threads from Haze II",
    });
    expect(button.getAttribute("data-slot")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("accent");
    expect(button.style.width).toBe(`${SIDEBAR_ASSISTANT_DISC_SIZE}px`);
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

describe("AssistantSectionRailToggle", () => {
  function renderRail() {
    const ctx = {
      processingConversationIds: new Set<string>(),
      attentionConversationIds: attention,
    } as unknown as ConversationListContextValue;
    return render(
      <ConversationListProvider value={ctx}>
        <AssistantSectionRailToggle assistantId="a1" section={SECTION} />
      </ConversationListProvider>,
    );
  }

  test("the same accent Button at the rail's tile size, named for the section", () => {
    renderRail();
    const button = screen.getByRole("button", { name: "From me" });
    expect(button.getAttribute("data-variant")).toBe("accent");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.style.width).toBe(`${SIDE_MENU_TILE_SIZE}px`);
  });

  test("a press opens the threads in a flyout, and the dot steps aside", () => {
    conversations = [{ conversationId: "c1" } as Conversation];
    attention = new Set(["c1"]);
    const { container } = renderRail();
    expect(
      container.querySelector("[data-slot='group-indicator-dot']"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "From me" }));
    expect(screen.getByTestId("rail-flyout").textContent).toBe("1 rows");
    expect(
      container.querySelector("[data-slot='group-indicator-dot']"),
    ).toBeNull();
  });

  test("at zero the flyout says what the card would", () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "From me" }));
    expect(screen.queryByTestId("rail-flyout")).toBeNull();
    expect(screen.getByText("Nothing on my mind yet.")).toBeTruthy();
  });
});
