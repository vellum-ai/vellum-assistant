/**
 * Tests for `AssistantSwitcher`: the chevron's visibility matrix (gate,
 * entry count, collapsed rail), the expanded card's contents, and what a
 * row selection does on success and on failure. The switchable list and the
 * switch call are mocked; the identity pill renders for real around them.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";

const CURRENT: ResolvedAssistant = {
  id: "a1",
  name: "Mel Gibson",
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
};
const OTHER: ResolvedAssistant = {
  id: "a2",
  name: "Jimmy Buckets",
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
};

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
      label="Mel Gibson"
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
});

afterEach(() => {
  cleanup();
});

describe("AssistantSwitcher chevron visibility", () => {
  test("no chevron when the gate is closed or the list is short", () => {
    switchable = { assistants: [CURRENT], canSwitch: false };
    const { queryByLabelText, getByText } = renderSwitcher();

    expect(queryByLabelText("Switch assistant")).toBeNull();
    expect(getByText("Mel Gibson")).toBeTruthy();
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

    expect(getByLabelText("Mel Gibson, current assistant")).toBeTruthy();
    expect(getByText("Jimmy Buckets")).toBeTruthy();
    const collapse = getByLabelText("Hide assistants");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
  });

  test("the collapse control folds the card back to the pill", () => {
    const { getByLabelText, queryByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Hide assistants"));

    expect(queryByText("Jimmy Buckets")).toBeNull();
  });

  test("selecting a row switches and collapses on success", async () => {
    const { getByLabelText, queryByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Jimmy Buckets"));

    expect(switchMock).toHaveBeenCalledTimes(1);
    expect(switchMock.mock.calls[0]?.[0]).toEqual(OTHER);
    await waitFor(() => {
      expect(queryByText("Jimmy Buckets")).toBeNull();
    });
  });

  test("a failed switch reports, stays expanded for a retry", async () => {
    switchMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    const { getByLabelText, getByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Jimmy Buckets"));

    await waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledTimes(1);
    });
    expect(getByText("Jimmy Buckets")).toBeTruthy();
  });
});
