/**
 * What the loader does to the URL once it has resolved a conversation key.
 * A URL that already names the resolved key is left alone, segments and all,
 * so the app viewer sub-route survives a reload; an index landing with no key
 * in the URL is still rewritten to the conversation it resolved.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, createRef } from "react";

import { client as daemonClient } from "@/generated/daemon/client.gen";
import { useConversationStore } from "@/stores/conversation-store";
import {
  type RawConversationFixture,
  rawConversation,
} from "@/utils/conversation-list.test-helper";
import { saveLastViewedConversationId } from "@/utils/last-viewed-conversation-storage";
import { routes } from "@/utils/routes";

const ASSISTANT_ID = "asst-1";

mock.module("@/assistant/operational-status", () => ({
  useAssistantIsServing: () => true,
}));
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

/* The drained foreground list never resolves here, so any landing that
   waited on it would time out rather than pass by accident. */
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

let byIdRow: RawConversationFixture | null = null;

function stubDaemon() {
  daemonClient.get = mock(async (options: { url: string }) => {
    /* The by-id read is the only lookup either landing here needs; anything
       else means the loader took a path these tests do not describe. */
    if (!options.url.endsWith("/conversations/{id}")) {
      throw new Error(`unexpected request ${options.url}`);
    }
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
  }) as typeof daemonClient.get;
}

const originalGet = daemonClient.get;

function renderLoader(urlConversationId: string | null) {
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
        <QueryClientProvider client={new QueryClient()}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
}

beforeEach(() => {
  byIdRow = null;
  navigateMock.mockClear();
  useConversationStore.setState({ activeConversationId: null });
  localStorage.clear();
  stubDaemon();
});

afterEach(() => {
  cleanup();
  daemonClient.get = originalGet;
});

describe("useConversationLoader URL rewriting", () => {
  test("leaves an app viewer URL that already names the resolved key alone", async () => {
    window.history.replaceState(
      {},
      "",
      routes.conversation("c1") + "/app/app-1",
    );

    renderLoader("c1");

    await waitFor(() => {
      expect(useConversationStore.getState().activeConversationId).toBe("c1");
    });
    /* A rewrite here would drop the app segment on every reload. */
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("rewrites an index landing to the conversation it resolved", async () => {
    window.history.replaceState({}, "", routes.assistant);
    saveLastViewedConversationId(ASSISTANT_ID, "stored-chat");
    byIdRow = { id: "stored-chat" };

    renderLoader(null);

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
