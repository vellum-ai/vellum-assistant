/**
 * Tests for `ConversationAssetsPill`: the Chat Info trigger it registers in the
 * viewer store, and its unseen-document-changes affordance.
 *
 * The pill's asset count comes from TanStack queries, so the suite seeds the
 * cache with `staleTime: Infinity` instead of mocking the SDK: nothing
 * refetches on mount and the count is exactly what a test asks for.
 *
 * Class strings are deliberately not asserted (happy-dom makes those brittle);
 * the dot is located by its `data-testid` and the state it communicates is
 * asserted through the trigger's accessible name. The one exception is the
 * appearance pulse, which has no accessible surface at all: those tests check
 * for the single animation class token on the dot and nothing else.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as motionReact from "motion/react";

import { makeDocumentSummary } from "@/domains/chat/components/chat-info.test-helper";
import type { DocumentSummary } from "@/types/document-types";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// `useReducedMotion` reads a cached media-query singleton, so a per-test
// `matchMedia` stub can't flip it. Override just that export and drive it
// through this toggle instead.
let reducedMotion = false;
mock.module("motion/react", () => ({
  ...motionReact,
  useReducedMotion: () => reducedMotion,
}));

const {
  ConversationAssetsPill,
  ASSETS_PILL_UNSEEN_DOT_TESTID,
  ASSETS_PILL_UNSEEN_DOT_PULSE_CLASS,
} = await import("@/domains/chat/components/conversation-assets-pill");
const { useUnseenDocumentChangesStore } =
  await import("@/domains/chat/unseen-document-changes-store");
const { useViewerStore } = await import("@/stores/viewer-store");
const { appsGetOptions, documentsGetOptions } =
  await import("@/generated/daemon/@tanstack/react-query.gen");

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
const SURFACE_ID = "surface-1";
const OTHER_CONVERSATION_ID = "conv-2";
const OTHER_SURFACE_ID = "surface-2";

const DOC_TITLE = "Roadmap";

// Singular: these fixtures seed one asset, and the ICU `plural` in
// `conversationAssets.ariaLabel` agrees with the count.
const SEEN_LABEL = "Conversation assets, 1 item";
const UNSEEN_LABEL = "Conversation assets, 1 item (unseen changes)";

function makeDocument(
  conversationId = CONVERSATION_ID,
  surfaceId = SURFACE_ID,
): DocumentSummary {
  return makeDocumentSummary({ surfaceId, conversationId, title: DOC_TITLE });
}

/**
 * `staleTime: Infinity` keeps the seeded entries fresh, so the queries resolve
 * from cache and never reach the generated SDK.
 */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
}

function seedConversation(
  client: QueryClient,
  documents: DocumentSummary[],
  conversationId: string,
) {
  const queryArgs = {
    path: { assistant_id: ASSISTANT_ID },
    query: { conversationId },
  };
  client.setQueryData(appsGetOptions(queryArgs).queryKey, { apps: [] });
  client.setQueryData(documentsGetOptions(queryArgs).queryKey, { documents });
}

function renderPill({ withAssets = true }: { withAssets?: boolean } = {}) {
  const client = makeQueryClient();
  seedConversation(client, withAssets ? [makeDocument()] : [], CONVERSATION_ID);
  seedConversation(
    client,
    [makeDocument(OTHER_CONVERSATION_ID, OTHER_SURFACE_ID)],
    OTHER_CONVERSATION_ID,
  );

  const pill = (conversationId: string) => (
    <QueryClientProvider client={client}>
      <ConversationAssetsPill
        assistantId={ASSISTANT_ID}
        conversationId={conversationId}
      />
    </QueryClientProvider>
  );

  const view = render(pill(CONVERSATION_ID));

  return {
    unmount: () => view.unmount(),
    /** Swap the prop on the already-mounted pill, as the chat header does. */
    switchConversation: (conversationId: string) => {
      // Every real switch drops the transcript panel payloads before the
      // header re-renders; the store settles the view from there.
      act(() => {
        useViewerStore.getState().clearTranscriptPanelPayloads();
      });
      view.rerender(pill(conversationId));
    },
    /** Drop the conversation's last asset, as a delete would. */
    emptyAssets: () => {
      seedConversation(client, [], CONVERSATION_ID);
    },
  };
}

function markUnseen(conversationId = CONVERSATION_ID, surfaceId = SURFACE_ID) {
  useUnseenDocumentChangesStore
    .getState()
    .markDocumentChanged(conversationId, surfaceId);
}

function unseenConversations(): string[] {
  return Object.keys(useUnseenDocumentChangesStore.getState().changedDocuments);
}

function chatInfoState() {
  const { mainView, activeChatInfo } = useViewerStore.getState();
  return { mainView, activeChatInfo };
}

beforeEach(() => {
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  useViewerStore.getState().reset();
});

afterEach(() => {
  cleanup();
  isMobileRef.value = false;
  reducedMotion = false;
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
  useViewerStore.getState().reset();
});

function dotHasPulse(): boolean {
  return screen
    .getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)
    .classList.contains(ASSETS_PILL_UNSEEN_DOT_PULSE_CLASS);
}

describe("desktop pill", () => {
  test("shows the dot and names the state when a change is unseen", () => {
    markUnseen();
    renderPill();

    expect(screen.getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeTruthy();
    expect(screen.getByRole("button", { name: UNSEEN_LABEL })).toBeTruthy();
  });

  test("shows no dot and the plain name when nothing is unseen", () => {
    renderPill();

    expect(screen.queryByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeNull();
    expect(screen.getByRole("button", { name: SEEN_LABEL })).toBeTruthy();
  });

  // The dot survives the click here: the panel is what clears it, and this
  // suite renders the trigger alone.
  test("opening the panel sets mainView to chat-info", () => {
    markUnseen();
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: UNSEEN_LABEL }));

    expect(chatInfoState()).toEqual({
      mainView: "chat-info",
      activeChatInfo: {
        assistantId: ASSISTANT_ID,
        conversationId: CONVERSATION_ID,
        category: null,
      },
    });
    expect(unseenConversations()).toEqual([CONVERSATION_ID]);
  });

  test("clicking while open closes the panel", () => {
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(chatInfoState().mainView).toBe("chat-info");

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));

    expect(chatInfoState()).toEqual({
      mainView: "chat",
      activeChatInfo: null,
    });
  });

  test("aria-expanded reflects the store", () => {
    renderPill();

    const trigger = screen.getByRole("button", { name: SEEN_LABEL });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // Store-first, so the attribute tracks the view however it was opened,
    // not just the trigger's own click.
    act(() => {
      useViewerStore.getState().openChatInfo({
        assistantId: ASSISTANT_ID,
        conversationId: CONVERSATION_ID,
      });
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      useViewerStore.getState().closeChatInfo();
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("narrow window with a mouse", () => {
  // Room decides whether the count fits in the header cluster: a narrow window
  // gets the compact trigger and the same panel.
  beforeEach(() => {
    isMobileRef.value = true;
  });

  test("trigger is icon-only and keeps its accessible name", () => {
    renderPill();

    expect(screen.getByRole("button", { name: SEEN_LABEL }).textContent).toBe(
      "",
    );
  });

  test("opening the panel sets mainView to chat-info", () => {
    markUnseen();
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: UNSEEN_LABEL }));

    expect(chatInfoState().mainView).toBe("chat-info");
  });
});

describe("conversation switch while the panel is open", () => {
  /**
   * The chat header renders one unkeyed pill and swaps `conversationId` on it,
   * so the open panel would otherwise survive the switch. The store settles it
   * from `clearTranscriptPanelPayloads`, which every switch runs: the incoming
   * conversation's assets are never put on screen unasked, and its changes
   * stay marked unseen until the user opens the panel.
   */
  test("closes the panel and keeps the incoming dot", () => {
    markUnseen(OTHER_CONVERSATION_ID, OTHER_SURFACE_ID);
    const { switchConversation } = renderPill();

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(chatInfoState().mainView).toBe("chat-info");

    switchConversation(OTHER_CONVERSATION_ID);

    expect(chatInfoState()).toEqual({
      mainView: "chat",
      activeChatInfo: null,
    });
    expect(screen.getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeTruthy();
    expect(screen.getByRole("button", { name: UNSEEN_LABEL })).toBeTruthy();
    expect(unseenConversations()).toEqual([OTHER_CONVERSATION_ID]);
  });
});

describe("the last asset leaving while the panel is open", () => {
  test("hides the trigger and takes the panel with it", async () => {
    const { emptyAssets } = renderPill();

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(chatInfoState().mainView).toBe("chat-info");

    emptyAssets();

    await waitFor(() => {
      expect(screen.queryByRole("button")).toBeNull();
    });
    expect(chatInfoState()).toEqual({
      mainView: "chat",
      activeChatInfo: null,
    });
  });
});

describe("pill unmount while the panel is open", () => {
  test("closes the panel it owns", () => {
    const { unmount } = renderPill();
    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(useViewerStore.getState().mainView).toBe("chat-info");

    unmount();

    expect(useViewerStore.getState().mainView).toBe("chat");
    expect(useViewerStore.getState().activeChatInfo).toBeNull();
  });
});

describe("appearance pulse", () => {
  // One `layersIcon` node feeds both the mobile trigger and the desktop pill,
  // so the pulse has a single render site and needs no per-platform case.
  test("pulses the dot when a change lands", () => {
    markUnseen();
    renderPill();

    expect(dotHasPulse()).toBe(true);
  });

  test("appears without animating when reduced motion is preferred", () => {
    reducedMotion = true;
    markUnseen();
    renderPill();

    expect(screen.getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeTruthy();
    expect(dotHasPulse()).toBe(false);
  });
});

describe("empty asset list", () => {
  /**
   * Pins the deliberate trade-off: the pill renders nothing at all without
   * assets, so there is no Layers icon to carry a dot. An unseen change in
   * that window stays recorded in the store and the dot appears as soon as
   * the documents query reports the asset, rather than the pill being forced
   * to render a trigger for an empty panel.
   */
  test("renders nothing even when a change is unseen", () => {
    markUnseen();
    renderPill({ withAssets: false });

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeNull();
    expect(unseenConversations()).toEqual([CONVERSATION_ID]);
  });
});
