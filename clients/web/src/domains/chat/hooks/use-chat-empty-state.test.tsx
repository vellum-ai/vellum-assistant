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
const startersStatusRef: { value: "ready" | "empty" | "generating" } = {
  value: "ready",
};

// Honors the assistant id the way the real hook does: a null id is a
// disabled query and answers idle. A stub that served starters regardless
// hid the paths that never ask for them (the suggestions library, an
// active conversation) behind chips they would never actually receive.
mock.module("@/domains/chat/hooks/use-conversation-starters", () => ({
  useConversationStarters: (assistantId: string | null | undefined) =>
    assistantId
      ? {
          starters: startersRef.value,
          status: startersStatusRef.value,
          isAwaitingStarters: awaitingStartersRef.value,
        }
      : { starters: [], status: "idle", isAwaitingStarters: false },
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
import {
  loadAssistantProducesStarters,
  recordAssistantProducesStarters,
} from "@/domains/chat/utils/starters-availability-storage";

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
  startersStatusRef.value = "ready";
  awaitingStartersRef.value = false;
  localStorage.clear();
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
  // The dock is what keeps the composer still while a fresh chat loads: it is
  // docked and mounted from the first frame, so the greeting + composer group
  // above it never re-centers around starters arriving. Whether it also holds
  // the chips' height up front is a separate decision, because holding space
  // for an assistant that produces no chips only trades one movement for
  // another. Only an assistant known to produce them reserves.
  const RESERVE = '[data-slot="conversation-starter-dock-reserve"]';

  const dockOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(
      '[data-slot="conversation-starter-dock"]',
    );

  test("a known producer reserves the chips' height before any of them arrives", () => {
    recordAssistantProducesStarters("a1", true);
    awaitingStartersRef.value = true;
    startersStatusRef.value = "generating";
    startersRef.value = [];
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    expect(result.current.dockStartersToBottom).toBe(true);
    expect(result.current.startersDockCollapsed).toBe(false);

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(dockOf(container)).not.toBeNull();
    expect(container.querySelector(RESERVE)).not.toBeNull();
    // Nothing readable yet: the reserve is invisible space, not chips.
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).toBeNull();
  });

  test("an assistant nothing is known about reserves nothing and starts collapsed", () => {
    // The fresh-install case. Reserving here would hold ~150px and then hand
    // it back the moment the daemon answers with an empty list, sliding a
    // screen that had no reason to move at all.
    awaitingStartersRef.value = true;
    startersStatusRef.value = "generating";
    startersRef.value = [];
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    expect(result.current.dockStartersToBottom).toBe(true);
    expect(result.current.startersDockCollapsed).toBe(true);

    // The slot is still handed over, so `ChatBody` mounts the wrapper a
    // later answer expands into. It just has nothing to draw.
    expect(result.current.startersSlot).not.toBeUndefined();
    const { container } = render(<>{result.current.startersSlot}</>);
    expect(dockOf(container)).toBeNull();
    expect(container.querySelector(RESERVE)).toBeNull();
  });

  test("the reserve ends when the wait does, whatever ended it", () => {
    // The wait can end on a settled answer, a failed or paused fetch, or the
    // deadline on a generation that never lands. Each arrives here the same
    // way, and none of them may leave a known producer holding space forever.
    recordAssistantProducesStarters("a1", true);
    awaitingStartersRef.value = false;
    startersStatusRef.value = "generating";
    startersRef.value = [];
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    expect(result.current.startersDockCollapsed).toBe(true);
    const { container } = render(<>{result.current.startersSlot}</>);
    expect(container.querySelector(RESERVE)).toBeNull();
  });

  test("the credits card does not sit above an empty panel", () => {
    // The card shares the slot, so a dock with nothing to draw must draw
    // nothing: its padding and caption would otherwise hang under the card
    // as dead space.
    startersRef.value = [];
    startersStatusRef.value = "empty";
    const { result } = renderHook(() =>
      useChatEmptyState(baseParams({ showCreditsUpsell: true })),
    );

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="credits-upsell-card"]'),
    ).not.toBeNull();
    expect(dockOf(container)).toBeNull();
  });

  test("chips landing keep the reserve as the dock's sizing floor", () => {
    // Dropping the floor the moment chips arrive would let a one-line answer
    // shrink the dock, which moves the group just as surely as growing it.
    recordAssistantProducesStarters("a1", true);
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    expect(result.current.startersDockCollapsed).toBe(false);
    const { container } = render(<>{result.current.startersSlot}</>);
    expect(container.querySelector(RESERVE)).not.toBeNull();
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).not.toBeNull();
    expect(container.innerHTML).toContain("opacity-100");
  });

  test("this launch's own answer does not add a floor under chips already drawn", () => {
    // The first-ever answer on a brand-new assistant. Recording it must not
    // feed straight back into the reserve: a floor appearing under chips that
    // are already laid out pushes the group the floor exists to hold still.
    // The chips open the dock instead, once, and the next launch reserves.
    const { result } = renderHook(() => useChatEmptyState(baseParams()));

    expect(result.current.startersDockCollapsed).toBe(false);
    const { container } = render(<>{result.current.startersSlot}</>);
    expect(container.querySelector(RESERVE)).toBeNull();
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).not.toBeNull();
    expect(loadAssistantProducesStarters("a1")).toBe(true);
  });

  test("a settled answer with no chips is remembered too", () => {
    recordAssistantProducesStarters("a1", true);
    startersRef.value = [];
    startersStatusRef.value = "empty";
    renderHook(() => useChatEmptyState(baseParams()));

    expect(loadAssistantProducesStarters("a1")).toBe(false);
  });

  test("an unsettled answer leaves the previous one alone", () => {
    // A wedged generation, a failed fetch, and an offline pause all reach
    // here with no chips and no terminal status. Forgetting on those would
    // cost the next launch its reserve over a transient failure.
    recordAssistantProducesStarters("a1", true);
    startersRef.value = [];
    startersStatusRef.value = "generating";
    renderHook(() => useChatEmptyState(baseParams()));

    expect(loadAssistantProducesStarters("a1")).toBe(true);
  });

  test("the suggestions library is never collapsed by the chip dock's policy", () => {
    // The library takes the same docked slot but fills it from its own data,
    // and the starter query is disabled on that path, so it answers idle with
    // no chips. Reading that as an empty dock collapsed the featured row out
    // of sight on the whole flag-on empty state.
    flagRef.value = true;
    const { result } = renderHook(() =>
      useChatEmptyState(baseParams({ onSelectSuggestion: () => {} })),
    );

    expect(result.current.dockStartersToBottom).toBe(true);
    expect(result.current.startersDockCollapsed).toBe(false);

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="suggestion-featured-row"]'),
    ).not.toBeNull();
    expect(dockOf(container)).toBeNull();
  });

  test("the library is not collapsed even for an assistant known to have no chips", () => {
    // The discriminating case: the flag-off path for this assistant would
    // collapse, so a gate that only checked the starter data would take the
    // library down with it.
    recordAssistantProducesStarters("a1", false);
    startersRef.value = [];
    startersStatusRef.value = "empty";
    flagRef.value = true;
    const { result } = renderHook(() =>
      useChatEmptyState(baseParams({ onSelectSuggestion: () => {} })),
    );

    expect(result.current.startersDockCollapsed).toBe(false);
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

  test("showCreditsUpsell with no starters still renders the card, riding the dock", () => {
    // The card shares the starters slot, so with no chips to show it rides
    // the bottom dock rather than sitting inline under the composer. The dock
    // must therefore stay expanded: collapsing an empty dock would take the
    // credit wall down with it.
    startersRef.value = [];
    startersStatusRef.value = "empty";
    const { result } = renderHook(() =>
      useChatEmptyState(baseParams({ showCreditsUpsell: true })),
    );

    const { container } = render(<>{result.current.startersSlot}</>);
    expect(
      container.querySelector('[data-slot="credits-upsell-card"]'),
    ).not.toBeNull();
    expect(result.current.startersDockCollapsed).toBe(false);
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
