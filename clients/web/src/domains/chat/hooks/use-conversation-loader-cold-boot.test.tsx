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
import { listPage } from "@/utils/conversation-list.test-helper";
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

type RawRow = {
  id: string;
  conversationType?: "standard" | "background" | "scheduled";
  surfacedAt?: number | null;
  groupId?: string | null;
  archivedAt?: number | null;
};

function raw(row: RawRow) {
  return {
    title: "",
    createdAt: 0,
    updatedAt: 0,
    lastMessageAt: 0,
    conversationType: "standard",
    source: "vellum",
    groupId: null,
    isProcessing: false,
    ...row,
  };
}

/** Requests the loader made, by URL, so a test can assert what it asked. */
let requests: string[] = [];
let byIdRow: RawRow | null = null;
let listRows: RawRow[] = [];

function stubDaemon() {
  daemonClient.get = mock(
    async (options: {
      url: string;
      path?: Record<string, string>;
      query?: Record<string, unknown>;
    }) => {
      const url = options.url;
      requests.push(url);
      if (url.endsWith("/conversations/{id}")) {
        if (!byIdRow) {
          return {
            data: null,
            error: { message: "not found" },
            response: new Response(null, { status: 404 }),
          };
        }
        const body = { conversation: raw(byIdRow) };
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
          conversations: listRows.slice(offset, offset + limit).map(raw),
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
