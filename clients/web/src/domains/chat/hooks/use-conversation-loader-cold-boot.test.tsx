/**
 * Cold-boot landing: with nothing selected, the loader resumes the
 * last-viewed conversation if the server still has it as a foreground row,
 * else lands on the newest foreground conversation, and it decides that
 * from two single-row reads while the drained conversation list is still
 * pending. The list query is stubbed permanently pending here so a landing
 * that waited on it would never happen and every test would time out.
 *
 * The newest-row read asks the daemon to filter to foreground rows itself.
 * The tests under "an assistant that predates foregroundOnly" flip the stub
 * to ignore the parameter, which is what an older assistant does, and cover
 * the paged search the loader falls back to when the answer proves that.
 *
 * The last blocks cover what the loader does to the URL once it holds a key:
 * a URL that already names the resolved key is left alone, segments and all,
 * so the app viewer sub-route survives a reload, a URL naming a draft the
 * first send re-keyed is redirected onto the row that send created, and a new
 * chat started while an app is kept beside it names that app in the URL it
 * lands on.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, createRef } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { stubViewportAxes } from "@/hooks/viewport-axes.test-helper";
import {
  readStoredDraftReplacements,
  useConversationStore,
} from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import {
  SAMPLE_APP,
  showOpenAppRoute,
  showPath,
} from "@/stores/open-app.test-helper";
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
import { routes } from "@/utils/routes";
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
/** The query of every list request, in order, so a test can assert the ask. */
let listQueries: Record<string, unknown>[] = [];
let byIdRow: RawConversationFixture | null = null;
let listRows: RawConversationFixture[] = [];
/** Rows the daemon appends to an unfiltered page one beyond the limit. */
let pinnedExtras: RawConversationFixture[] = [];
/** How many upcoming requests answer 503 before the stub recovers. */
let failNextRequests = 0;
/**
 * Whether the stub honors `foregroundOnly`. `false` plays an assistant that
 * predates the parameter: it ignores it and answers with the unfiltered
 * listing, appended pins and all.
 */
let daemonFiltersForeground = true;

/**
 * The stub's foreground rule, the daemon's `notBackgroundVisibilitySql`: an
 * unsurfaced background or scheduled run is dropped; a surfaced one stays.
 */
function isForegroundFixture(row: RawConversationFixture): boolean {
  return (
    row.surfacedAt != null ||
    (row.conversationType !== "background" &&
      row.conversationType !== "scheduled")
  );
}

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
        listQueries.push(options.query ?? {});
        const limit = Number(options.query?.limit ?? 50);
        const offset = Number(options.query?.offset ?? 0);
        const filtered =
          daemonFiltersForeground && options.query?.foregroundOnly === "true";
        const source = filtered
          ? listRows.filter(isForegroundFixture)
          : listRows;
        const body = {
          conversations: [
            ...source.slice(offset, offset + limit),
            ...(offset === 0 && !filtered ? pinnedExtras : []),
          ].map(rawConversation),
          hasMore: source.length > offset + limit,
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

function renderColdBoot(
  queryClient: QueryClient,
  urlConversationId: string | null = null,
) {
  return renderHook(
    () =>
      useConversationLoader({
        assistantId: ASSISTANT_ID,
        assistantStateKind: "active",
        activeConversationId: null,
        urlConversationId,
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
  listQueries = [];
  byIdRow = null;
  listRows = [];
  pinnedExtras = [];
  failNextRequests = 0;
  daemonFiltersForeground = true;
  podIsServing = true;
  orgIsReady = true;
  navigateMock.mockClear();
  useConversationStore.setState({
    activeConversationId: null,
    draftReplacements: new Map(),
  });
  localStorage.clear();
  sessionStorage.clear();
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
    /* One row, filtered by the daemon: the client neither pages nor
       re-derives which rows are foreground. */
    expect(listQueries).toEqual([
      { foregroundOnly: "true", limit: 1, offset: 0 },
    ]);
  });

  test("does not implicitly resume a stored background run", async () => {
    saveLastViewedConversationId(ASSISTANT_ID, "heartbeat");
    byIdRow = { id: "heartbeat", conversationType: "background" };
    listRows = [{ id: "newest" }];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("newest");
  });

  test("with nothing stored, reads the newest foreground row and caches nothing under the list prefix", async () => {
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

  test("lands on the first chat past any number of unselectable rows, in one request", async () => {
    /* The standard listing admits background runs filed in custom groups,
       so its newest rows can all be runs; the daemon's filter skips them, so
       the first chat is one row away however deep it sits. */
    listRows = [
      ...Array.from({ length: 300 }, (_, i) => ({
        id: `bg-${i}`,
        conversationType: "background" as const,
        groupId: "grp-1",
      })),
      { id: "deep-chat" },
    ];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("deep-chat");
    expect(requests.filter((u) => u.endsWith("/conversations"))).toHaveLength(
      1,
    );
  });

  test("a surfaced background run is a landing, not evidence of an older assistant", async () => {
    /* The daemon's filter keeps surfaced runs and so does the client's
       selectability rule; the two have to agree here, or a current
       assistant's honest first row would send the loader down the paged
       search. */
    listRows = [
      {
        id: "surfaced-run",
        conversationType: "background",
        surfacedAt: 1704067200000,
      },
      { id: "older-chat" },
    ];

    renderColdBoot(new QueryClient());

    expect(await landedOn()).toContain("surfaced-run");
    expect(requests.filter((u) => u.endsWith("/conversations"))).toHaveLength(
      1,
    );
  });

  describe("an assistant that predates foregroundOnly", () => {
    /* Such an assistant ignores the parameter and answers with the newest
       row of the unfiltered listing. When that row is a chat it is the same
       answer a filtering assistant gives; when it is not, the loader knows
       the filter was not applied and pages through the list itself. */
    beforeEach(() => {
      daemonFiltersForeground = false;
    });

    test("a newest row that is a chat is the landing, in one request", async () => {
      listRows = [{ id: "newest" }, { id: "older" }];

      renderColdBoot(new QueryClient());

      expect(await landedOn()).toContain("newest");
      expect(requests.filter((u) => u.endsWith("/conversations"))).toHaveLength(
        1,
      );
    });

    test("a newest row that is not a chat proves the filter was ignored, and the loader pages", async () => {
      listRows = [
        { id: "bg-in-group", conversationType: "background", groupId: "grp-1" },
        { id: "first-chat" },
      ];

      renderColdBoot(new QueryClient());

      expect(await landedOn()).toContain("first-chat");
      /* The one-row read, then page one of the unfiltered list. */
      expect(listQueries).toEqual([
        { foregroundOnly: "true", limit: 1, offset: 0 },
        { limit: 50, offset: 0 },
      ]);
    });

    test("keeps looking past page one when it has no chat, and stops after the 200 newest rows", async () => {
      /* 60 background runs in a custom group lead the list; the first chat
         sits on page two. The stub pages by the server's own offset
         arithmetic. Request counts include the one-row read that detected
         the older assistant. */
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
        3,
      );

      cleanup();
      navigateMock.mockClear();
      requests = [];
      useConversationStore.setState({ activeConversationId: null });

      /* 300 unselectable rows before the first chat: the search stops after
         four pages and lands on the assistant itself rather than scanning
         on. */
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
        5,
      );
    });

    test("pages by the server's page size, not by rows received, so appended pinned rows skip nothing", async () => {
      /* Page one is 50 rows plus 2 appended pinned rows, all unselectable;
         the first chat is row 51 in server order, so an offset advanced by
         rows received (52) would skip it. */
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
         an old pinned chat beyond the window; a newer (still selectable)
         chat leads page two. Recency order: bg rows (100..51), the page-two
         chat (30), the appended pin (1). */
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

describe("URL path is kept when it already names the key", () => {
  test("leaves an app viewer URL that already names the resolved key alone", async () => {
    showPath(routes.conversation("c1", SAMPLE_APP.appId));

    renderColdBoot(new QueryClient(), "c1");

    await waitFor(() => {
      expect(useConversationStore.getState().activeConversationId).toBe("c1");
    });
    /* A rewrite here would drop the app segment on every reload. */
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("rewrites an index landing to the conversation it resolved", async () => {
    showPath(routes.assistant);
    saveLastViewedConversationId(ASSISTANT_ID, "stored-chat");
    byIdRow = { id: "stored-chat" };

    renderColdBoot(new QueryClient());

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        routes.conversation("stored-chat"),
        { replace: true },
      );
    });
    expect(useConversationStore.getState().activeConversationId).toBe(
      "stored-chat",
    );
  });
});

describe("a URL naming a retired draft", () => {
  /* The entries the open pushed still name the draft; the row is under the id
     the send came back with, and nothing else resolves one to the other. */
  beforeEach(() => {
    useConversationStore
      .getState()
      .recordDraftReplacement("draft-1", "conv-server-1");
  });

  test("redirects onto the row the send created", async () => {
    showPath(routes.conversation("draft-1"));

    renderColdBoot(new QueryClient(), "draft-1");

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        routes.conversation("conv-server-1"),
        { replace: true },
      );
    });
  });

  test("keeps the app segment, so the redirect does not close the app", async () => {
    showPath(routes.conversation("draft-1", SAMPLE_APP.appId));

    renderColdBoot(new QueryClient(), "draft-1");

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        routes.conversation("conv-server-1", SAMPLE_APP.appId),
        { replace: true },
      );
    });
  });

  test("redirects after a reload, which keeps the entry but not the store", async () => {
    /* The reload's store is seeded from the tab's storage alone: an empty key
       would leave this assignment with nothing to redirect. */
    useConversationStore.setState({
      draftReplacements: readStoredDraftReplacements(),
    });
    showPath(routes.conversation("draft-1"));

    renderColdBoot(new QueryClient(), "draft-1");

    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        routes.conversation("conv-server-1"),
        { replace: true },
      );
    });
  });

  test("leaves the row itself alone, so the redirect cannot loop", async () => {
    showPath(routes.conversation("conv-server-1"));

    renderColdBoot(new QueryClient(), "conv-server-1");

    await waitFor(() => {
      expect(useConversationStore.getState().activeConversationId).toBe(
        "conv-server-1",
      );
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

describe("startNewConversation carries the app the viewer keeps", () => {
  let restoreViewport: (() => void) | undefined;

  beforeEach(() => {
    /* A wide viewport, the only shape with a side-by-side app layout. */
    restoreViewport = stubViewportAxes({ narrow: false, coarsePointer: false });
    showPath(routes.conversation("c1"));
  });

  afterEach(() => {
    restoreViewport?.();
    useViewerStore.getState().reset();
  });

  /** The path the loader navigated to for a fresh draft, and that draft's id. */
  async function startFreshChat(): Promise<{ draftId: string; path: string }> {
    const { result } = renderColdBoot(new QueryClient(), "c1");
    await waitFor(() => {
      expect(useConversationStore.getState().activeConversationId).toBe("c1");
    });
    navigateMock.mockClear();
    act(() => {
      result.current.startNewConversation();
    });
    const draftId = useConversationStore.getState().activeConversationId;
    if (draftId === null || draftId === "c1") {
      throw new Error("expected a fresh draft to be selected");
    }
    return {
      draftId,
      path: (navigateMock.mock.calls[0] as unknown as [string])[0],
    };
  }

  test("names the open app, so the new chat opens beside it", async () => {
    showOpenAppRoute({ conversationId: "c1" });

    const { draftId, path } = await startFreshChat();

    expect(path).toBe(routes.conversation(draftId, SAMPLE_APP.appId));
    expect(path).toEndWith(`/app/${SAMPLE_APP.appId}`);
  });

  test("names no app when the viewer is on the chat", async () => {
    const { draftId, path } = await startFreshChat();

    expect(path).toBe(routes.conversation(draftId));
  });
});
