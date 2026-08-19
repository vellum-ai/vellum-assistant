/**
 * Tests for `AssistantSwitcher`: the chevron's visibility matrix (gate,
 * entry count, collapsed rail), the expanded card's contents, and what a
 * row selection does on success and on failure. The switchable list and the
 * switch call are mocked; the identity pill renders for real around them.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as reactRouter from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

const CURRENT: ResolvedAssistant = {
  id: "a1",
  name: "Alice",
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
};
const OTHER: ResolvedAssistant = {
  id: "a2",
  name: "Bob",
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
};

const navigateMock = mock((_to: string, _opts?: { replace?: boolean }) => {});
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => navigateMock,
}));

let switchable: { assistants: ResolvedAssistant[]; canSwitch: boolean } = {
  assistants: [],
  canSwitch: false,
};
mock.module("@/assistant/use-switchable-assistants", () => ({
  useSwitchableAssistants: () => switchable,
}));

const switchMock = mock(async (_assistant: ResolvedAssistant) => {});
mock.module("@/assistant/switch-service", () => ({
  switchToResolvedAssistant: switchMock,
}));

const captureErrorMock = mock(
  (_error: unknown, _context?: Record<string, unknown>) => {},
);
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: () => ({
    components: null,
    traits: null,
    customImageUrl: null,
    isLoading: false,
    invalidate: () => {},
  }),
}));

const { AssistantSwitcher } = await import(
  "@/domains/chat/components/assistant-switcher"
);

function renderSwitcher(
  props: Partial<Parameters<typeof AssistantSwitcher>[0]> = {},
) {
  return render(
    <AssistantSwitcher
      assistantId="a1"
      label="Alice"
      active={false}
      onSelect={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  switchable = { assistants: [CURRENT, OTHER], canSwitch: true };
  switchMock.mockClear();
  switchMock.mockImplementation(async () => {});
  captureErrorMock.mockClear();
  navigateMock.mockClear();
  useConversationStore.setState({ activeConversationId: null });
});

afterEach(() => {
  cleanup();
});

describe("AssistantSwitcher chevron visibility", () => {
  test("no chevron when the gate is closed or the list is short", () => {
    switchable = { assistants: [CURRENT], canSwitch: false };
    const { queryByLabelText, getByText } = renderSwitcher();

    expect(queryByLabelText("Switch assistant")).toBeNull();
    expect(getByText("Alice")).toBeTruthy();
  });

  test("no chevron on the collapsed rail", () => {
    const { queryByLabelText } = renderSwitcher({ collapsed: true });

    expect(queryByLabelText("Switch assistant")).toBeNull();
  });

  test("two switchable assistants put the chevron on the pill", () => {
    const { getByLabelText } = renderSwitcher();

    const chevron = getByLabelText("Switch assistant");
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("AssistantSwitcher expanded card", () => {
  test("the chevron expands the card with the current entry checked and the rest listed", () => {
    const { getByLabelText, getByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));

    expect(getByLabelText("Alice, current assistant")).toBeTruthy();
    expect(getByText("Bob")).toBeTruthy();
    const collapse = getByLabelText("Hide assistants");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
  });

  test("the collapse control folds the card back to the pill", () => {
    const { getByLabelText, queryByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Hide assistants"));

    expect(queryByText("Bob")).toBeNull();
  });

  test("selecting a row switches, collapses, and lands on the assistant route", async () => {
    useConversationStore.setState({ activeConversationId: "conv-old" });
    const { getByLabelText, queryByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Bob"));

    expect(switchMock).toHaveBeenCalledTimes(1);
    expect(switchMock.mock.calls[0]?.[0]).toEqual(OTHER);
    await waitFor(() => {
      expect(queryByText("Bob")).toBeNull();
    });
    /* The old assistant's conversation must not survive the switch: the
       loader would otherwise request it from, and persist it against, the
       new assistant (URL ids outrank everything, across assistants). */
    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
    });
  });

  test("a failed switch reports, stays expanded, and stays put", async () => {
    switchMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    useConversationStore.setState({ activeConversationId: "conv-old" });
    const { getByLabelText, getByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Bob"));

    await waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledTimes(1);
    });
    expect(getByText("Bob")).toBeTruthy();
    expect(useConversationStore.getState().activeConversationId).toBe(
      "conv-old",
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
