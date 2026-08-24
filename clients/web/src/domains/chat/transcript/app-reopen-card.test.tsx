/**
 * Tests for the end-of-turn card for an app the assistant built or changed.
 *
 * Covers what the card owes its caller: it names the app from the apps query,
 * rendering only once a resolved list carries it, falls back to the
 * assistant-wide list for an app reached from another conversation, and opens
 * the app it names. The document twin of these rules lives in
 * `document-reopen-link.test`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// The card's thumbnail is a lazily-loaded live iframe of the app; it reaches
// the daemon and is not what these tests are about. Stub the card's presentation
// down to its name and open action.
mock.module("@/components/app-card", () => ({
  AppCard: ({ name, onOpen }: { name: string; onOpen?: () => void }) => (
    <button type="button" data-testid="app-card" onClick={onOpen}>
      {name}
    </button>
  ),
}));

const { AppReopenCard } = await import(
  "@/domains/chat/transcript/app-reopen-card"
);
const { appsGetQueryKey } = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";
const APP_ID = "app-7";

const onOpenApp = mock((_appId: string) => {});

type SeededApp = { id: string; name: string };

function seededPayload(apps: SeededApp[]) {
  return {
    apps: apps.map((app) => ({
      id: app.id,
      name: app.name,
      createdAt: 0,
      updatedAt: 0,
      version: "1",
      contentId: "c1",
      origin: "workspace",
    })),
  };
}

/** A client that never refetches, so a seeded entry needs no network. */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
}

function renderWithClient(
  queryClient: QueryClient,
  conversationId: string | null,
): void {
  const ui: ReactNode = (
    <AppReopenCard
      appId={APP_ID}
      assistantId={ASSISTANT_ID}
      conversationId={conversationId}
      onOpenApp={onOpenApp}
    />
  );
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/**
 * Render the card with the conversation-scoped apps query answered, and the
 * assistant-wide fallback answered too when `assistantWide` is given.
 */
function renderCard(apps: SeededApp[], assistantWide?: SeededApp[]): void {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(
    appsGetQueryKey({
      path: { assistant_id: ASSISTANT_ID },
      query: { conversationId: CONVERSATION_ID },
    }),
    seededPayload(apps),
  );
  if (assistantWide) {
    queryClient.setQueryData(
      appsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      seededPayload(assistantWide),
    );
  }
  renderWithClient(queryClient, CONVERSATION_ID);
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  onOpenApp.mockClear();
  // An unseeded query leaves the card in its loading state for the whole test
  // instead of reaching the network.
  globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), {
    preconnect: () => {},
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe("AppReopenCard", () => {
  test("names the app from the apps query", () => {
    renderCard([{ id: APP_ID, name: "Tracker" }]);

    expect(screen.getByText("Tracker")).toBeTruthy();
    expect(screen.getByTestId("app-reopen-card")).toBeTruthy();
  });

  test("renders nothing until the apps query resolves", () => {
    renderWithClient(makeQueryClient(), CONVERSATION_ID);

    expect(screen.queryByTestId("app-reopen-card")).toBeNull();
  });

  test("names an app reached from another conversation", () => {
    renderCard(
      [{ id: "app-other", name: "Something else" }],
      [{ id: APP_ID, name: "Tracker" }],
    );

    expect(screen.getByText("Tracker")).toBeTruthy();
  });

  test("renders nothing for an app neither resolved list carries", () => {
    // A created-then-deleted app resolves nowhere, so the card stays away
    // rather than offering to open something that is gone.
    renderCard(
      [{ id: "app-other", name: "Something else" }],
      [{ id: "app-other", name: "Something else" }],
    );

    expect(screen.queryByTestId("app-reopen-card")).toBeNull();
  });

  test("renders nothing while the assistant-wide fallback is unresolved", () => {
    renderCard([{ id: "app-other", name: "Something else" }]);

    expect(screen.queryByTestId("app-reopen-card")).toBeNull();
  });

  test("reads the assistant-wide list when there is no conversation", () => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(
      appsGetQueryKey({ path: { assistant_id: ASSISTANT_ID } }),
      seededPayload([{ id: APP_ID, name: "Tracker" }]),
    );
    renderWithClient(queryClient, null);

    expect(screen.getByText("Tracker")).toBeTruthy();
  });

  test("clicking opens the app it names", () => {
    renderCard([{ id: APP_ID, name: "Tracker" }]);

    fireEvent.click(screen.getByTestId("app-card"));

    expect(onOpenApp).toHaveBeenCalledTimes(1);
    expect(onOpenApp.mock.calls[0]).toEqual([APP_ID]);
  });
});
