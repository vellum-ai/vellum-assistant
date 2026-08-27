/**
 * Tests for `HomeFeedList`, focused on the empty state.
 *
 * An empty Activity feed is not a waiting state: notifications come from
 * schedules and reminders, so nothing arrives until one exists. These pin the
 * two properties that make the surface an entry point rather than a dead end:
 * the recipes hand the assistant a prompt that builds the schedule, and the
 * secondary action reaches the schedules page.
 *
 * Assertions target roles and text, never class strings, so restyling the
 * scene does not turn these into styling tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { routes } from "@/utils/routes";
import type { CharacterComponents } from "@/types/avatar";
import type { FeedItem } from "@vellumai/assistant-api";

import { feedItem } from "./feed-test-fixtures";

const avatarRef: {
  components: CharacterComponents | null;
  customImageUrl: string | null;
} = { components: null, customImageUrl: null };

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: avatarRef.components,
    traits: null,
    customImageUrl: avatarRef.customImageUrl,
    state: null,
    isLoading: false,
    isSuccess: true,
    invalidate: () => {},
  }),
}));

mock.module("@/stores/resolved-assistants-store", () => {
  const store = () => null;
  store.use = {
    activeAssistantId: () => "assistant-1",
  };
  return { useResolvedAssistantsStore: store };
});

const navigateMock = mock((..._args: unknown[]) => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

// Mocked at the boundary the recipe cards call: the real helper drives the
// conversation, subagent, workflow, and viewer stores plus haptics and the
// sound manager, none of which an empty-state test has anything to say about.
const navigateToNewConversationMock = mock((..._args: unknown[]) => "draft-1");

mock.module("@/utils/conversation-navigation", () => ({
  navigateToNewConversation: navigateToNewConversationMock,
}));

import { HomeFeedList } from "./home-feed-list";

/** The prompt the Nth recipe launch handed to the assistant. */
function launchedPrompt(index: number): string {
  const call = navigateToNewConversationMock.mock.calls[index];
  return (call?.[1] as { prompt?: string } | undefined)?.prompt ?? "";
}

function renderList(items: FeedItem[] = []) {
  render(
    <HomeFeedList
      items={items}
      onSelectItem={() => {}}
      onDismissItem={() => {}}
      onRestoreItem={() => {}}
    />,
  );
}

beforeEach(() => {
  avatarRef.components = null;
  avatarRef.customImageUrl = null;
  navigateMock.mockClear();
  navigateToNewConversationMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("HomeFeedList empty state", () => {
  test("explains where notifications come from", () => {
    renderList();

    expect(screen.getByText("Nothing to report yet.")).toBeTruthy();
    expect(
      screen.getByText(
        "I'll post here when a schedule runs, a reminder fires, or something needs your attention.",
      ),
    ).toBeTruthy();
  });

  test("previews the shape of a populated feed", () => {
    renderList();

    // The preview is aria-hidden, so it is reachable by text but not by role.
    expect(screen.getByText("Example")).toBeTruthy();
    expect(
      screen.getByText(
        "Three meetings today, two emails waiting on a reply, and rain from 16:00.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Four emails need a reply. The drafts are ready for you to review.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "You asked me to remind you before the team sync at 16:00.",
      ),
    ).toBeTruthy();
  });

  test("the morning briefing recipe seeds a conversation with its prompt", () => {
    renderList();

    fireEvent.click(screen.getByRole("button", { name: /^Morning briefing/ }));

    expect(navigateToNewConversationMock).toHaveBeenCalledTimes(1);
    expect(launchedPrompt(0)).toContain("morning briefing");
    expect(launchedPrompt(0)).toContain("8:00");
  });

  test("the inbox triage recipe seeds a conversation with its prompt", () => {
    renderList();

    fireEvent.click(screen.getByRole("button", { name: /^Inbox triage/ }));

    expect(navigateToNewConversationMock).toHaveBeenCalledTimes(1);
    expect(launchedPrompt(0)).toContain("every 2 hours");
  });

  test("the secondary action reaches the schedules page", () => {
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "See all schedules" }));

    expect(navigateMock).toHaveBeenCalledWith(routes.schedules.root);
  });

  test("falls back to the bell icon when the assistant has no avatar", () => {
    renderList();

    expect(screen.queryByRole("img", { name: "Assistant avatar" })).toBeNull();
  });

  test("leads with the assistant's own avatar when it has one", () => {
    avatarRef.customImageUrl = "blob:avatar";
    renderList();

    expect(screen.getByRole("img", { name: "Assistant avatar" })).toBeTruthy();
  });

  test("gives way to the feed as soon as a notification exists", () => {
    renderList([
      feedItem({
        id: "a",
        category: "email",
        title: "An email arrived",
        summary: "One message is waiting on a reply.",
      }),
    ]);

    expect(screen.getByText("An email arrived")).toBeTruthy();
    expect(screen.queryByText("Nothing to report yet.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "See all schedules" }),
    ).toBeNull();
  });
});
