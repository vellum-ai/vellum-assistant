/**
 * Cold-boot landing: with nothing selected, the loader resumes the
 * last-viewed conversation if the server still has it as a foreground row,
 * else lands on the newest foreground conversation, and it decides that
 * from two single-row reads while the drained conversation list is still
 * pending. The list query is stubbed permanently pending here so a landing
 * that waited on it would never happen and every test would time out.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, createRef } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useConversationStore } from "@/stores/conversation-store";
import {
  conversationListPrefix,
  conversationListQueryKey,
} from "@/utils/conversation-list-keys";
import {
  listPage,
  type RawConversationFixture,
  rawConversation,
} from "@/utils/conversation-list.test-helper";
import { saveLastViewedConversationId } from "@/utils/last-viewed-conversation-storage";
import type { Conversation } from "@/types/conversation-types";

const ASSISTANT_ID = "asst-1";

/* The daemon gate the list queries honor; the landing lookups share it. */
let podIsServing = true;
let orgIsReady = true;
mock.module("@/assistant/operational-status", () => ({
  useAssistantIsServing: () => podIsServing,
}));
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgIsReady,
}));

/* The drained foreground list never resolves in these tests; the gate is
   the real one, composed over the two stubs above. */
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

/* A completed page fetch posts to the telemetry ingest, which has no
   listener here. */
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

/* Not a native shell: no new-chat draft is minted on cold launch. Spread
   over the real module so its other exports survive for the rest of the
   import graph. */
const realPlatformDetection = await import("@/runtime/platform-detection");
mock.module("@/runtime/platform-detection", () => ({
  ...realPlatformDetection,
  isNativeMobile: () => false,
}));

const { useConversationLoader } =
  await import("@/domains/chat/hooks/use-conversation-loader");

/** Requests the loader made, by URL, so a test can assert what it asked. */
let requests: string[] = [];
let byIdRow: RawConversationFixture | null = null;
let listRows: RawConversationFixture[] = [];
/** Rows the daemon appends to an unfiltered page one beyond the limit. */
let pinnedExtras: RawConversationFixture[] = [];
/** How many upcoming requests answer 503 before the stub recovers. */
let failNextRequests = 0;

function stubDaemon() {
  daemonClient.get = mock(
    async (options: {
      url: string;
      path?: Record<string, string>;
      query?: Record<string, unknown>;
    }) => {
      const url = options.url;
      requests.push(url);
      if (failNextRequests > 0) {
        failNextRequests -= 1;
        return {
          data: null,
          error: { message: "waking" },
          response: new Response(null, { status: 503 }),
        };
      }
      if (url.endsWith("/conversations/{id}")) {
        if (!byIdRow) {
          return {
            data: null,
            error: { message: "not found" },
            response: new Response(null, { status: 404 }),
          };
        }
        const body = { conversation: rawConversation(byIdRow) };
        return {
          data: body,
          error: null,
          response: new Response(JSON.stringify(body), { status: 200 }),
        };
      }
      if (url.endsWith("/conversations")) {
        const limit = Number(options.query?.limit ?? 50);
        const offset = Number(options.query?.offset ?? 0);
        const body = {
          conversations: [
            ...listRows.slice(offset, offset + limit),
            ...(offset === 0 ? pinnedExtras : []),
          ].map(rawConversation),
          hasMore: listRows.length > offset + limit,
        };
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

function renderColdBoot(queryClient: QueryClient) {
  return renderHook(
    () =>
      useConversationLoader({
        assistantId: ASSISTANT_ID,
        assistantStateKind: "active",
        activeConversationId: null,
        urlConversationId: null,
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

async function landedOn(): Promise<string> {
  await waitFor(() => {
    expect(navigateMock).toHaveBeenCalled();
  });
  return (navigateMock.mock.calls[0] as unknown as [string])[0];
}

beforeEach(() => {
  requests = [];
  byIdRow = null;
  listRows = [];
  pinnedExtras = [];
  failNextRequests = 0;
  podIsServing = true;
  orgIsReady = true;
  navigateMock.mockClear();
  useConversationStore.setState({ activeConversationId: null });
  localStorage.clear();
  stubDaemon();
});

afterEach(() => {
  cleanup();
  daemonClient.get = originalGet;
});

describe("useConversationLoader cold-boot landing", () => {
  test("resumes the stored conversation from one by-id read, without the list", async () => {
    saveLastViewedConversationId(ASSISTANT_ID, "old-visible");
    byIdRow = { id: "old-visible" };

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("old-visible");
    /* One request, the by-id read; the list was never asked. */
    expect(requests).toEqual([
      "/v1/assistants/{assistant_id}/conversations/{id}",
    ]);
  });

  test("lands on the newest foreground conversation when the stored one is gone", async () => {
    /* "Gone" is the daemon's answer for a deleted row and for a legacy
       private row the listing hides (the by-id route declines those; the
       wire type could not carry "private" anyway). */
    saveLastViewedConversationId(ASSISTANT_ID, "deleted");
    byIdRow = null;
    listRows = [{ id: "newest" }, { id: "older" }];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("newest");
    expect(requests).toEqual([
      "/v1/assistants/{assistant_id}/conversations/{id}",
      "/v1/assistants/{assistant_id}/conversations",
    ]);
  });

  test("does not implicitly resume a stored background run", async () => {
    saveLastViewedConversationId(ASSISTANT_ID, "heartbeat");
    byIdRow = { id: "heartbeat", conversationType: "background" };
    listRows = [{ id: "newest" }];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("newest");
  });

  test("with nothing stored, reads page one of the foreground list and caches nothing under the list prefix", async () => {
    listRows = [{ id: "newest" }, { id: "older" }, { id: "oldest" }];
    const queryClient = new QueryClient();

    renderColdBoot(queryClient);

    expect(await landedOn()).toContain("newest");
    expect(requests).toEqual(["/v1/assistants/{assistant_id}/conversations"]);
    /* A plain fetch, not a query: nothing the prefix scanners could mistake
       for a list cache. */
    expect(
      queryClient.getQueriesData({
        queryKey: conversationListPrefix(ASSISTANT_ID),
      }),
    ).toEqual([]);
  });

  test("skips an unselectable newest row and lands on the first chat", async () => {
    /* The standard listing admits background runs filed in custom groups,
       so page one can lead with one. */
    listRows = [
      { id: "bg-in-group", conversationType: "background", groupId: "grp-1" },
      { id: "first-chat" },
    ];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("first-chat");
  });

  test("keeps looking past page one when it has no chat, and stops after the 200 newest rows", async () => {
    /* 60 background runs in a custom group lead the list; the first chat sits
       on page two. The stub pages by the server's own offset arithmetic. */
    listRows = [
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `bg-${i}`,
        conversationType: "background" as const,
        groupId: "grp-1",
      })),
      { id: "first-chat" },
    ];
    renderColdBoot(new QueryClient());
    expect(await landedOn()).toContain("first-chat");
    expect(requests.filter((u) => u.endsWith("/conversations"))).toHaveLength(
      2,
    );

    cleanup();
    navigateMock.mockClear();
    requests = [];
    useConversationStore.setState({ activeConversationId: null });

    /* 300 unselectable rows before the first chat: the search stops after
       four pages and lands on the assistant itself rather than scanning on. */
    listRows = [
      ...Array.from({ length: 300 }, (_, i) => ({
        id: `bg-${i}`,
        conversationType: "background" as const,
        groupId: "grp-1",
      })),
      { id: "deep-chat" },
    ];
    renderColdBoot(new QueryClient());
    const landing = await landedOn();
    expect(landing).toContain(ASSISTANT_ID);
    expect(landing).not.toContain("deep-chat");
    expect(requests.filter((u) => u.endsWith("/conversations"))).toHaveLength(
      4,
    );
  });

  test("pages by the server's page size, not by rows received, so appended pinned rows skip nothing", async () => {
    /* Page one is 50 rows plus 2 appended pinned rows, all unselectable; the
       first chat is row 51 in server order, so an offset advanced by rows
       received (52) would skip it. */
    pinnedExtras = [
      { id: "pin-a", conversationType: "background", groupId: "grp-1" },
      { id: "pin-b", conversationType: "background", groupId: "grp-1" },
    ];
    listRows = [
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `bg-${i}`,
        conversationType: "background" as const,
        groupId: "grp-1",
      })),
      { id: "row-51-chat" },
    ];
    renderColdBoot(new QueryClient());
    expect(await landedOn()).toContain("row-51-chat");
  });

  test("an appended pin older than the window does not pre-empt a newer chat on page two", async () => {
    /* The window's 50 newest rows are all unselectable; the daemon appends
       an old pinned chat beyond the window; a newer (still selectable) chat
       leads page two. Recency order: bg rows (100..51), the page-two chat
       (30), the appended pin (1). */
    pinnedExtras = [{ id: "old-pin", isPinned: true, lastMessageAt: 1 }];
    listRows = [
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `bg-${i}`,
        conversationType: "background" as const,
        groupId: "grp-1",
        lastMessageAt: 100 - i,
      })),
      { id: "page-two-chat", lastMessageAt: 30 },
    ];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("page-two-chat");
  });

  test("an appended pin newer than everything past the window wins", async () => {
    pinnedExtras = [{ id: "newer-pin", isPinned: true, lastMessageAt: 40 }];
    listRows = [
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `bg-${i}`,
        conversationType: "background" as const,
        groupId: "grp-1",
        lastMessageAt: 100 - i,
      })),
      { id: "page-two-chat", lastMessageAt: 30 },
    ];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("newer-pin");
  });

  test("retries a transient failure before falling back", async () => {
    saveLastViewedConversationId(ASSISTANT_ID, "old-visible");
    byIdRow = { id: "old-visible" };
    failNextRequests = 1;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: 2, retryDelay: 0 } },
    });

    renderColdBoot(queryClient);

    expect(await landedOn()).toContain("old-visible");
    expect(requests).toHaveLength(2);
  });

  test("does not resume a stored conversation that has since been archived", async () => {
    saveLastViewedConversationId(ASSISTANT_ID, "archived-chat");
    byIdRow = { id: "archived-chat", archivedAt: 1704067200000 };
    listRows = [{ id: "newest" }];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("newest");
  });

  test("defers the lookups while the pod is not serving, then lands once it is", async () => {
    saveLastViewedConversationId(ASSISTANT_ID, "old-visible");
    byIdRow = { id: "old-visible" };
    podIsServing = false;

    const { rerender } = renderColdBoot(new QueryClient());
    await new Promise((resolve) => setTimeout(resolve, 20));
    /* Nothing asked, nothing decided: a 503 from a waking pod must not
       become a landing on the assistant home. */
    expect(requests).toEqual([]);
    expect(navigateMock).not.toHaveBeenCalled();

    podIsServing = true;
    rerender();

    expect(await landedOn()).toContain("old-visible");
  });

  test("reads the newest selectable row from a warm drained cache instead of the server", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      conversationListQueryKey(ASSISTANT_ID),
      listPage([
        /* An optimistic archive leaves the row in place, archived, until
           the settle refetch; it is not a landing. */
        {
          conversationId: "just-archived",
          archivedAt: 1704067200000,
        } as Conversation,
        { conversationId: "cached-newest" } as Conversation,
        { conversationId: "cached-older" } as Conversation,
      ]),
    );

    renderColdBoot(queryClient);

    expect(await landedOn()).toContain("cached-newest");
    expect(requests).toEqual([]);
  });

  test("lands on the assistant itself when there is nothing to land on", async () => {
    listRows = [];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain(ASSISTANT_ID);
  });
});
