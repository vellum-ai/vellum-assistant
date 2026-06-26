/**
 * Tests for `useChatEmptyState`'s `startersSlot` selection.
 *
 * The hook composes several other hooks (greeting, conversation-starters,
 * thread-suggestions) and the client feature-flag store. We stub each of those
 * via `mock.module` so the test stays focused on the slot-selection logic:
 *
 * - Flag OFF → the existing conversation-starter chips render (no regression).
 * - Flag ON (empty conversation, no app-editing) → the new SuggestionLibrary
 *   renders instead, and selecting a card maps the suggestion onto the
 *   existing `onSelectStarter` path.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, renderHook } from "@testing-library/react";

import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import type { ThreadSuggestion } from "@/domains/chat/suggestions/types";

// --- Mocks ----------------------------------------------------------------

const flagRef = { value: false };

mock.module("@/stores/client-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    newThreadSuggestions: () => flagRef.value,
  };
  return { useClientFeatureFlagStore: store };
});

mock.module("@/domains/chat/hooks/use-empty-state-greeting", () => ({
  useEmptyStateGreeting: () => ({ greeting: "Hi there", isGenerating: false }),
}));

const STARTER: ConversationStarter = {
  id: "starter-1",
  label: "Draft a plan",
  prompt: "Draft a plan for me",
  category: null,
  batch: 0,
};

mock.module("@/domains/chat/hooks/use-conversation-starters", () => ({
  useConversationStarters: () => ({ starters: [STARTER] }),
}));

const FEATURED: ThreadSuggestion = {
  id: "sugg-1",
  title: "Email Helper",
  iconKey: "gmail",
  prompt: "Help me triage my inbox",
  detail: {
    heading: "Email Helper",
    description: "Triage your inbox.",
    requirements: [],
    capabilities: [],
  },
};

mock.module("@/domains/chat/hooks/use-thread-suggestions", () => ({
  useThreadSuggestions: () => ({ featured: [FEATURED], groups: [] }),
}));

import { useChatEmptyState } from "@/domains/chat/hooks/use-chat-empty-state";
import type { UseChatEmptyStateParams } from "@/domains/chat/hooks/use-chat-empty-state";

function baseParams(
  overrides: Partial<UseChatEmptyStateParams> = {},
): UseChatEmptyStateParams {
  return {
    assistantId: "a1",
    conversationId: "c1",
    isEmptyConversation: true,
    avatar: { components: null, traits: null, customImageUrl: null } as never,
    mainView: "chat",
    openedAppState: null,
    isAssistantStreaming: false,
    activeConversationIsProcessing: false,
    onSelectStarter: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  flagRef.value = false;
});

afterEach(() => {
  cleanup();
});

describe("useChatEmptyState startersSlot", () => {
  test("flag OFF renders the conversation-starter chips, not the library", () => {
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="suggestion-library"]'),
    ).toBeNull();
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).not.toBeNull();
  });

  test("flag ON renders the suggestion library on a fresh thread", () => {
    flagRef.value = true;
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    const { container, getByText } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="suggestion-library"]'),
    ).not.toBeNull();
    expect(getByText(FEATURED.title)).toBeTruthy();
  });

  test("flag ON: selecting a card submits the suggestion's prompt via onSelectStarter", () => {
    flagRef.value = true;
    const selected: ConversationStarter[] = [];
    const { result } = renderHook(() =>
      useChatEmptyState(
        baseParams({ onSelectStarter: (s) => selected.push(s) }),
      ),
    );

    const { getByText } = render(<>{result.current.startersSlot}</>);
    fireEvent.click(getByText(FEATURED.title));

    expect(selected).toHaveLength(1);
    expect(selected[0]).toEqual({
      id: FEATURED.id,
      label: FEATURED.title,
      prompt: FEATURED.prompt,
      category: null,
      batch: 0,
    });
  });

  test("flag ON: onSelectSuggestion (when provided) wins over onSelectStarter", () => {
    flagRef.value = true;
    const submitted: ConversationStarter[] = [];
    const opened: ThreadSuggestion[] = [];
    const { result } = renderHook(() =>
      useChatEmptyState(
        baseParams({
          onSelectStarter: (s) => submitted.push(s),
          onSelectSuggestion: (s) => opened.push(s),
        }),
      ),
    );

    const { getByText } = render(<>{result.current.startersSlot}</>);
    fireEvent.click(getByText(FEATURED.title));

    expect(opened).toEqual([FEATURED]);
    expect(submitted).toHaveLength(0);
  });

  test("flag ON but app-editing keeps the conversation-starter grid", () => {
    flagRef.value = true;
    const { result } = renderHook(() =>
      useChatEmptyState(
        baseParams({
          mainView: "app-editing",
          openedAppState: { name: "My App" },
        }),
      ),
    );

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="suggestion-library"]'),
    ).toBeNull();
  });
});
