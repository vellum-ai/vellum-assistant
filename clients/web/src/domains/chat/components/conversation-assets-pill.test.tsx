/**
 * Tests for `ConversationAssetsPill`'s unseen-document-changes affordance.
 *
 * The pill's asset list comes from two TanStack queries, so the suite seeds
 * the cache with `staleTime: Infinity` instead of mocking the SDK: nothing
 * refetches on mount and the rendered list is exactly what a test asks for.
 *
 * Class strings are deliberately not asserted (happy-dom makes those brittle);
 * the dot is located by its `data-testid` and the state it communicates is
 * asserted through the trigger's accessible name. The one exception is the
 * appearance pulse, which has no accessible surface at all: those tests check
 * for the single animation class token on the dot and nothing else.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as motionReact from "motion/react";

import type { DocumentSummary } from "@/types/document-types";

const isTouchMobileRef = { value: false };

mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => isTouchMobileRef.value,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));

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
const { appsGetOptions, documentsGetOptions } =
  await import("@/generated/daemon/@tanstack/react-query.gen");

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
const SURFACE_ID = "surface-1";
const OTHER_CONVERSATION_ID = "conv-2";
const OTHER_SURFACE_ID = "surface-2";

const DOC_TITLE = "Roadmap";
const OTHER_DOC_TITLE = "Backlog";

// Singular: these fixtures seed one asset, and the ICU `plural` in
// `conversationAssets.ariaLabel` agrees with the count.
const SEEN_LABEL = "Conversation assets, 1 item";
const UNSEEN_LABEL = "Conversation assets, 1 item (unseen changes)";

function makeDocument(
  conversationId = CONVERSATION_ID,
  surfaceId = SURFACE_ID,
  title = DOC_TITLE,
): DocumentSummary {
  return {
    surfaceId,
    conversationId,
    title,
    wordCount: 12,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  };
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
    [makeDocument(OTHER_CONVERSATION_ID, OTHER_SURFACE_ID, OTHER_DOC_TITLE)],
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
    /** Swap the prop on the already-mounted pill, as the chat header does. */
    switchConversation: (conversationId: string) => {
      view.rerender(pill(conversationId));
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

beforeEach(() => {
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

afterEach(() => {
  cleanup();
  isTouchMobileRef.value = false;
  isMobileRef.value = false;
  reducedMotion = false;
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
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

  test("opening the popover clears the conversation", () => {
    markUnseen();
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: UNSEEN_LABEL }));

    expect(unseenConversations()).toEqual([]);
    expect(screen.queryByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeNull();
  });
});

describe("narrow window with a mouse", () => {
  // Room decides whether the count fits in the header cluster, and pointer
  // decides whether the disclosure is a sheet: a narrow mouse-driven window
  // gets the compact trigger and still opens the anchored popover.
  beforeEach(() => {
    isMobileRef.value = true;
  });

  test("trigger is icon-only and keeps its accessible name", () => {
    renderPill();

    expect(screen.getByRole("button", { name: SEEN_LABEL }).textContent).toBe(
      "",
    );
  });

  test("opening the popover clears the conversation", () => {
    markUnseen();
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: UNSEEN_LABEL }));

    expect(unseenConversations()).toEqual([]);
  });
});

describe("mobile trigger", () => {
  beforeEach(() => {
    isTouchMobileRef.value = true;
    isMobileRef.value = true;
  });

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

  test("opening the sheet clears the conversation", () => {
    markUnseen();
    renderPill();

    fireEvent.click(screen.getByRole("button", { name: UNSEEN_LABEL }));

    expect(unseenConversations()).toEqual([]);
    expect(screen.queryByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeNull();
  });
});

describe("conversation switch while the disclosure is open", () => {
  /**
   * The chat header renders one unkeyed pill and swaps `conversationId` on it,
   * so `open` survives the switch and `onOpenChange` never fires for it. The
   * pill closes its own disclosure on that swap: the incoming conversation's
   * assets are never put on screen unasked, and its changes stay marked unseen
   * until the user opens the list.
   */
  test("closes the popover and keeps the incoming dot", () => {
    markUnseen(OTHER_CONVERSATION_ID, OTHER_SURFACE_ID);
    const { switchConversation } = renderPill();

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(screen.getByText(DOC_TITLE)).toBeTruthy();

    switchConversation(OTHER_CONVERSATION_ID);

    expect(screen.queryByText(OTHER_DOC_TITLE)).toBeNull();
    expect(screen.getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeTruthy();
    expect(screen.getByRole("button", { name: UNSEEN_LABEL })).toBeTruthy();
    expect(unseenConversations()).toEqual([OTHER_CONVERSATION_ID]);
  });

  test("closes the sheet and keeps the incoming dot on mobile", () => {
    isTouchMobileRef.value = true;
    markUnseen(OTHER_CONVERSATION_ID, OTHER_SURFACE_ID);
    const { switchConversation } = renderPill();

    fireEvent.click(screen.getByRole("button", { name: SEEN_LABEL }));
    expect(screen.getByText(DOC_TITLE)).toBeTruthy();

    switchConversation(OTHER_CONVERSATION_ID);

    expect(screen.queryByText(OTHER_DOC_TITLE)).toBeNull();
    expect(screen.getByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeTruthy();
    expect(screen.getByRole("button", { name: UNSEEN_LABEL })).toBeTruthy();
    expect(unseenConversations()).toEqual([OTHER_CONVERSATION_ID]);
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
   * to render an empty disclosure.
   */
  test("renders nothing even when a change is unseen", () => {
    markUnseen();
    renderPill({ withAssets: false });

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByTestId(ASSETS_PILL_UNSEEN_DOT_TESTID)).toBeNull();
    expect(unseenConversations()).toEqual([CONVERSATION_ID]);
  });
});
