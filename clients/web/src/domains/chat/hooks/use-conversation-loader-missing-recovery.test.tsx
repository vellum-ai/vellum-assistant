/**
 * Missing-conversation recovery: when the server's detail endpoint answers
 * 404 for the selected conversation, the loader routes the user to the chat
 * index, clears the dead selection, and refuses to reselect the dead id -
 * from the URL, from the landing fallbacks, or by re-asking the detail
 * endpoint - so a stale row or a stale deep link recovers without a retry
 * loop and without the full-page generic error boundary.
 *
 * The 404 itself is answered where it happens (`useActiveConversation`'s
 * single-row fetch), which registers the id in the session's
 * missing-conversation registry. These tests drive the registry directly -
 * that registration is the contract between the two hooks, and covering it
 * end-to-end is `use-active-conversation.test.tsx`'s job.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, createRef } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useConversationStore } from "@/stores/conversation-store";
import {
  clearLastViewedConversationId,
  loadLastViewedConversationId,
  saveLastViewedConversationId,
} from "@/utils/last-viewed-conversation-storage";
import {
  markConversationMissing,
  useMissingConversationStore,
} from "@/domains/chat/utils/missing-conversation-registry";
import {
  rawConversation,
  type RawConversationFixture,
} from "@/utils/conversation-list.test-helper";

const ASSISTANT_ID = "asst-1";
const DEAD_ID = "dead-1";

/* The daemon gate the list queries honor; the landing lookups share it. */
let podIsServing = true;
let orgIsReady = true;
mock.module("@/assistant/operational-status", () => ({
  useAssistantIsServing: () => podIsServing,
}));
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgIsReady,
}));

/* The drained foreground list never resolves here; nothing in these tests
   waits on it. */
const realQueries = await import("@/hooks/conversation-queries");
mock.module("@/hooks/conversation-queries", () => ({
  ...realQueries,
  useConversationListQuery: () => ({
    conversations: [],
    isLoading: true,
    isPending: true,
    isError: false,
    error: null,
    hasData: false,
    hasMore: false,
    refetch: () => {},
  }),
}));

mock.module("@/lib/telemetry/client-perf", () => ({
  emitClientPerfEvent: () => {},
  setClientPerfBootId: () => {},
  __resetClientPerfForTests: () => {},
}));

mock.module("@/domains/chat/hooks/use-conversation-history", () => ({
  useConversationHistory: () => ({ pagination: {} }),
}));

const navigateMock = mock((_to: string, _opts?: unknown) => Promise.resolve());
const realReactRouter = await import("react-router");
mock.module("react-router", () => ({
  ...realReactRouter,
  useNavigate: () => navigateMock,
}));

const realDesignLibrary = await import("@vellumai/design-library");
mock.module("@vellumai/design-library", () => ({
  ...realDesignLibrary,
  toast: { error: () => {} },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

const realPlatformDetection = await import("@/runtime/platform-detection");
mock.module("@/runtime/platform-detection", () => ({
  ...realPlatformDetection,
  isNativeMobile: () => false,
}));

const { useConversationLoader } =
  await import("@/domains/chat/hooks/use-conversation-loader");

/** Rows the daemon's list endpoint serves. */
let listRows: RawConversationFixture[] = [];

function stubDaemon() {
  daemonClient.get = mock(
    async (options: {
      url: string;
      query?: Record<string, unknown>;
    }) => {
      const url = options.url;
      if (url.endsWith("/conversations")) {
        const limit = Number(options.query?.limit ?? 50);
        const offset = Number(options.query?.offset ?? 0);
        const source = listRows.slice(offset, offset + limit);
        const body = {
          conversations: source.map(rawConversation),
          hasMore: listRows.length > offset + limit,
        };
        return {
          data: body,
          error: null,
          response: new Response(JSON.stringify(body), { status: 200 }),
        };
      }
      if (url.endsWith("/conversations/{id}")) {
        const body = { conversation: { conversationId: "irrelevant" } };
        return {
          data: body,
          error: null,
          response: new Response(JSON.stringify(body), { status: 200 }),
        };
      }
      throw new Error(`unexpected request ${url}`);
    },
  ) as typeof daemonClient.get;
}

const originalGet = daemonClient.get;

interface RenderParams {
  activeConversationId?: string | null;
  urlConversationId?: string | null;
}

function renderLoader(queryClient: QueryClient, params: RenderParams = {}) {
  return renderHook(
    () =>
      useConversationLoader({
        assistantId: ASSISTANT_ID,
        assistantStateKind: "active",
        activeConversationId: params.activeConversationId ?? null,
        urlConversationId: params.urlConversationId ?? null,
        searchParams: new URLSearchParams(),
        activeConversation: undefined,
        refreshEpoch: 0,
        reachabilityReadyEpoch: 0,
        onboardingDraftConversationIdRef: createRef<string | null>() as {
          current: string | null;
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
}

function navigatedTo(): string[] {
  return navigateMock.mock.calls.map(
    (call) => (call as unknown as [string])[0],
  );
}

beforeEach(() => {
  listRows = [];
  podIsServing = true;
  orgIsReady = true;
  navigateMock.mockClear();
  useConversationStore.setState({ activeConversationId: null });
  useMissingConversationStore.setState({ missing: {} });
  localStorage.clear();
  stubDaemon();
});

afterEach(() => {
  cleanup();
  daemonClient.get = originalGet;
  clearLastViewedConversationId(ASSISTANT_ID);
});

describe("useConversationLoader missing-conversation recovery", () => {
  test("routes to the chat index, clears the selection, and drops the stored last-viewed", async () => {
    saveLastViewedConversationId(ASSISTANT_ID, DEAD_ID);
    useConversationStore.setState({ activeConversationId: DEAD_ID });

    renderLoader(new QueryClient(), {
      activeConversationId: DEAD_ID,
      urlConversationId: DEAD_ID,
    });

    /* The 404 landing where the row fetch happens: useActiveConversation
       registers the id. */
    markConversationMissing(ASSISTANT_ID, DEAD_ID);

    await waitFor(() => {
      expect(navigatedTo()).toContain("/assistant");
    });
    const indexCall = navigateMock.mock.calls.find(
      (call) => (call as unknown as [string])[0] === "/assistant",
    ) as unknown as [string, { replace: boolean }];
    /* Replace, not push: the dead route leaves no history entry to go back
       to. */
    expect(indexCall[1]?.replace).toBe(true);
    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(loadLastViewedConversationId(ASSISTANT_ID)).toBeNull();
  });

  test("recovers once - a re-render does not navigate again", async () => {
    useConversationStore.setState({ activeConversationId: DEAD_ID });
    const { rerender } = renderLoader(new QueryClient(), {
      activeConversationId: DEAD_ID,
      urlConversationId: DEAD_ID,
    });

    markConversationMissing(ASSISTANT_ID, DEAD_ID);

    await waitFor(() => {
      expect(navigatedTo().filter((to) => to === "/assistant").length).toBe(1);
    });
    rerender();
    rerender();
    expect(navigatedTo().filter((to) => to === "/assistant").length).toBe(1);
  });

  test("a URL key the session knows is missing is never applied", async () => {
    /* A deep link to a conversation whose 404 this session already heard -
       e.g. the user followed the same notification twice. */
    markConversationMissing(ASSISTANT_ID, DEAD_ID);
    listRows = [{ id: "newest" }, { id: "older" }];

    renderLoader(new QueryClient(), { urlConversationId: DEAD_ID });

    await waitFor(() => {
      expect(navigatedTo().length).toBeGreaterThan(0);
    });
    /* Never the dead id; the landing fallback owns the route. */
    expect(navigatedTo()).not.toContain(`/assistant/conversations/${DEAD_ID}`);
    expect(navigatedTo()).toContain("/assistant/conversations/newest");
  });

  test("the landing refuses a newest row the session knows is missing", async () => {
    /* The list and the detail endpoint disagree: the server's newest row is
       one whose detail fetch already answered 404. Landing on it would loop
       recovery straight back; the assistant itself is the safe landing. */
    markConversationMissing(ASSISTANT_ID, "newest");
    listRows = [{ id: "newest" }, { id: "older" }];

    renderLoader(new QueryClient());

    await waitFor(() => {
      expect(navigatedTo().length).toBeGreaterThan(0);
    });
    expect(navigatedTo()).not.toContain("/assistant/conversations/newest");
    expect(navigatedTo()).toContain(
      `/assistant/conversations/${ASSISTANT_ID}`,
    );
  });

  test("a live conversation never triggers recovery", async () => {
    useConversationStore.setState({ activeConversationId: "live-1" });
    saveLastViewedConversationId(ASSISTANT_ID, "live-1");

    renderLoader(new QueryClient(), {
      activeConversationId: "live-1",
      urlConversationId: "live-1",
    });

    /* Nothing marks it missing; no navigation away from the live route. */
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(navigatedTo()).not.toContain("/assistant");
    expect(useConversationStore.getState().activeConversationId).toBe(
      "live-1",
    );
    expect(loadLastViewedConversationId(ASSISTANT_ID)).toBe("live-1");
  });
});
