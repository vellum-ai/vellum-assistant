/**
 * Tests for `useChatEmptyState`'s `startersSlot` selection.
 *
 * The hook composes several other hooks (greeting, conversation-starters,
 * thread-suggestions) and the client feature-flag store. We stub each of those
 * via `mock.module` so the test stays focused on the slot-selection logic:
 *
 * - Flag OFF → the existing conversation-starter chips render (no regression).
 * - Flag ON (empty conversation, no app-editing) with `onSelectSuggestion`
 *   provided → the new SuggestionLibrary renders instead, and selecting a card
 *   calls `onSelectSuggestion` to open the detail drawer.
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

const startersRef = { value: [STARTER] };
const awaitingStartersRef = { value: false };

mock.module("@/domains/chat/hooks/use-conversation-starters", () => ({
  useConversationStarters: () => ({
    starters: startersRef.value,
    isAwaitingStarters: awaitingStartersRef.value,
  }),
}));

// The real card mounts platform gates, subscription queries, and a router
// navigate; the hook only decides whether/where it renders, so a sentinel div
// keeps the test on the slot-composition logic.
mock.module("@/domains/chat/components/credits-upsell-card", () => ({
  CreditsUpsellCard: () => <div data-slot="credits-upsell-card" />,
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

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
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
    isAssistantBusy: false,
    showCreditsUpsell: false,
    onSelectStarter: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  flagRef.value = false;
  startersRef.value = [STARTER];
  awaitingStartersRef.value = false;
  useLiveVoiceStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("useChatEmptyState composerPeekSlot", () => {
  test("renders the peek on an idle empty conversation", () => {
    const { result } = renderHook(() => useChatEmptyState(baseParams()));
    expect(result.current.composerPeekSlot).not.toBeUndefined();
  });

  test("drops the peek while a live-voice session is active", () => {
    // The peek is anchored to the composer's input rect, which a session
    // replaces with the voice surface. It is also a `fixed` full-viewport
    // portal, so on mobile its top-of-screen avatar dangles into the band
    // above the voice sheet: the strip the sheet leaves to the thread header.
    useLiveVoiceStore.setState({ state: "listening" });
    const { result } = renderHook(() => useChatEmptyState(baseParams()));
    expect(result.current.composerPeekSlot).toBeUndefined();
  });
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

  test("flag ON with onSelectSuggestion docks the featured row and groups below the fold", () => {
    flagRef.value = true;
    const { result } = renderHook(() =>
      useChatEmptyState(baseParams({ onSelectSuggestion: () => {} })),
    );

    // The featured row is the docked first-screen slot; the categorized
    // groups render below the fold.
    expect(result.current.dockStartersToBottom).toBe(true);

    const starters = render(<>{result.current.startersSlot}</>);
    expect(
      starters.container.querySelector('[data-slot="suggestion-featured-row"]'),
    ).not.toBeNull();
    expect(starters.getByText(FEATURED.title)).toBeTruthy();

    const below = render(<>{result.current.belowFoldSlot}</>);
    expect(
      below.container.querySelector('[data-slot="suggestion-groups"]'),
    ).not.toBeNull();
  });

  test("flag ON without onSelectSuggestion falls back to the conversation-starter chips", () => {
    flagRef.value = true;
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="suggestion-library"]'),
    ).toBeNull();
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).not.toBeNull();
  });

  test("flag ON: selecting a card opens the suggestion via onSelectSuggestion", () => {
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

describe("useChatEmptyState starters dock", () => {
  // The dock is what keeps the composer still while a fresh chat loads. It
  // is docked and mounted from the first frame, before the daemon has
  // answered, so the greeting + composer group above it never re-centers
  // around starters arriving.
  const dockOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      '[data-slot="conversation-starter-dock"]',
    );

  test("docks from the first frame, before any starter has arrived", () => {
    awaitingStartersRef.value = true;
    startersRef.value = [];
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    expect(result.current.dockStartersToBottom).toBe(true);
    expect(result.current.startersSlot).not.toBeUndefined();

    const { container } = render(<>{result.current.startersSlot}</>);
    const dock = dockOf(container);
    expect(dock).not.toBeNull();
    // Reserved, not collapsed: the space the chips will occupy is already
    // held, so their arrival moves nothing above the dock.
    expect(dock?.style.gridTemplateRows).toBe("1fr");
    expect(dock?.hasAttribute("inert")).toBe(false);
    expect(
      container.querySelector(
        '[data-slot="conversation-starter-dock-reserve"]',
      ),
    ).not.toBeNull();
    // Nothing readable yet: the reserve is invisible space, not chips.
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).toBeNull();
  });

  test("stays docked when no assistant id has resolved yet", () => {
    // At boot the chat route can render before an assistant id lands. The
    // starter query is idle there, and a dock that read that as "settled with
    // nothing" would collapse for a frame and re-expand on the next.
    awaitingStartersRef.value = false;
    startersRef.value = [];
    const { result } = renderHook(() =>
      useChatEmptyState(baseParams({ assistantId: null })),
    );

    expect(result.current.dockStartersToBottom).toBe(true);
    const { container } = render(<>{result.current.startersSlot}</>);
    expect(dockOf(container)?.style.gridTemplateRows).toBe("1fr");
  });

  test("chips landing fill the reserved dock and become visible", () => {
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    const { container } = render(<>{result.current.startersSlot}</>);
    const dock = dockOf(container);
    expect(dock?.style.gridTemplateRows).toBe("1fr");
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).not.toBeNull();
    // The reserve stays mounted as the dock's sizing floor.
    expect(
      container.querySelector(
        '[data-slot="conversation-starter-dock-reserve"]',
      ),
    ).not.toBeNull();
    expect(container.innerHTML).toContain("opacity-100");
  });

  test("a starter query that settles empty collapses the dock instead of dropping it", () => {
    // Self-hosted assistants and failed fetches land here. The dock stays in
    // the tree and animates its height away, so the group above re-centers
    // smoothly rather than snapping.
    awaitingStartersRef.value = false;
    startersRef.value = [];
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    expect(result.current.dockStartersToBottom).toBe(true);
    const { container } = render(<>{result.current.startersSlot}</>);
    const dock = dockOf(container);
    expect(dock).not.toBeNull();
    expect(dock?.style.gridTemplateRows).toBe("0fr");
    expect(dock?.hasAttribute("inert")).toBe(true);
  });

  test("app editing keeps its chips inline and never docks", () => {
    const { result } = renderHook(() =>
      useChatEmptyState(
        baseParams({
          mainView: "app-editing",
          openedAppState: { name: "My App" },
        }),
      ),
    );

    expect(result.current.dockStartersToBottom).toBe(false);
    const { container } = render(<>{result.current.startersSlot}</>);
    expect(dockOf(container)).toBeNull();
  });

  test("app editing renders no starters slot at all once the conversation has messages", () => {
    const { result } = renderHook(() =>
      useChatEmptyState(
        baseParams({
          isEmptyConversation: false,
          mainView: "app-editing",
          openedAppState: { name: "My App" },
        }),
      ),
    );

    expect(result.current.dockStartersToBottom).toBe(false);
    expect(result.current.startersSlot).toBeUndefined();
  });
});

describe("useChatEmptyState credits upsell card", () => {
  test("showCreditsUpsell renders the card above the starter chips", () => {
    const { result } = renderHook(() =>
      useChatEmptyState(baseParams({ showCreditsUpsell: true })),
    );

    const { container } = render(<>{result.current.startersSlot}</>);
    // Card first, chips after it.
    expect(
      container.firstElementChild?.querySelector(
        '[data-slot="credits-upsell-card"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).not.toBeNull();
  });

  test("showCreditsUpsell with no starters still renders the card alone", () => {
    startersRef.value = [];
    const { result } = renderHook(() =>
      useChatEmptyState(baseParams({ showCreditsUpsell: true })),
    );

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="credits-upsell-card"]'),
    ).not.toBeNull();
  });

  test("no card when showCreditsUpsell is false (normal balance, loading, or gated-off billing query)", () => {
    // `useBillingBalanceStatus` is inert (isExhausted false) while the summary
    // is loading and for self-hosted / logged-out assistants, so those states
    // all arrive here as `showCreditsUpsell: false` and never flash the card.
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="credits-upsell-card"]'),
    ).toBeNull();
  });

  test("no card on the app-editing empty state", () => {
    const { result } = renderHook(() =>
      useChatEmptyState(
        baseParams({
          showCreditsUpsell: true,
          mainView: "app-editing",
          openedAppState: { name: "My App" },
        }),
      ),
    );

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="credits-upsell-card"]'),
    ).toBeNull();
  });

  test("no card once the conversation has messages (the transcript owns it)", () => {
    const { result } = renderHook(() =>
      useChatEmptyState(
        baseParams({ showCreditsUpsell: true, isEmptyConversation: false }),
      ),
    );

    expect(result.current.startersSlot).toBeUndefined();
  });
});
