/**
 * Tests for `ConversationAssetsPill`'s unseen-document-changes affordance.
 *
 * The pill's asset list comes from two TanStack queries, so the suite seeds
 * the cache with `staleTime: Infinity` instead of mocking the SDK: nothing
 * refetches on mount and the rendered list is exactly what a test asks for.
 *
 * Class strings are deliberately not asserted (happy-dom makes those brittle);
 * the dot is located by its `data-testid` and the state it communicates is
 * asserted through the trigger's accessible name.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { DocumentSummary } from "@/types/document-types";

const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const { ConversationAssetsPill, ASSETS_PILL_UNSEEN_DOT_TESTID } =
  await import("@/domains/chat/components/conversation-assets-pill");
const { useUnseenDocumentChangesStore } =
  await import("@/domains/chat/unseen-document-changes-store");
const { appsGetOptions, documentsGetOptions } =
  await import("@/generated/daemon/@tanstack/react-query.gen");

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
const SURFACE_ID = "surface-1";

const SEEN_LABEL = "Conversation assets, 1 items";
const UNSEEN_LABEL = "Conversation assets, 1 items (unseen changes)";

function makeDocument(): DocumentSummary {
  return {
    surfaceId: SURFACE_ID,
    conversationId: CONVERSATION_ID,
    title: "Roadmap",
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

function renderPill({ withAssets = true }: { withAssets?: boolean } = {}) {
  const client = makeQueryClient();
  const queryArgs = {
    path: { assistant_id: ASSISTANT_ID },
    query: { conversationId: CONVERSATION_ID },
  };
  client.setQueryData(appsGetOptions(queryArgs).queryKey, { apps: [] });
  client.setQueryData(documentsGetOptions(queryArgs).queryKey, {
    documents: withAssets ? [makeDocument()] : [],
  });
  render(
    <QueryClientProvider client={client}>
      <ConversationAssetsPill
        assistantId={ASSISTANT_ID}
        conversationId={CONVERSATION_ID}
      />
    </QueryClientProvider>,
  );
}

function markUnseen() {
  useUnseenDocumentChangesStore
    .getState()
    .markDocumentChanged(CONVERSATION_ID, SURFACE_ID);
}

function unseenConversations(): string[] {
  return Object.keys(useUnseenDocumentChangesStore.getState().changedDocuments);
}

beforeEach(() => {
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

afterEach(() => {
  cleanup();
  isMobileRef.value = false;
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

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

describe("mobile trigger", () => {
  beforeEach(() => {
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
