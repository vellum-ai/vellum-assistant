import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, createRef } from "react";

import { __setResumeGraceMsForTesting } from "@/hooks/use-resume-grace";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { ApiError } from "@/utils/api-errors";
import type * as GatewaySession from "@/lib/auth/gateway-session";

const CONVERSATION_LIST_LOAD_FAILED_CODE = "CONVERSATION_LIST_LOAD_FAILED";
const DEFAULT_RESUME_GRACE_MS = 15_000;

// The conversation-list query is stubbed so the test drives its error state
// directly; history loading, routing, and toasts are stubbed out so only the
// banner-consumer wiring is under test.
let listError: Error | null = null;

const realQueries = await import("@/hooks/conversation-queries");
mock.module("@/hooks/conversation-queries", () => ({
  ...realQueries,
  useConversationListQuery: () => ({
    conversations: [],
    isLoading: false,
    isPending: false,
    isError: listError !== null,
    error: listError,
    hasData: false,
    hasMore: false,
    refetch: () => {},
  }),
  /* These tests mount with an explicit URL key, so the landing lookups
     never run; the gate only needs to exist. */
  useCanQueryDaemon: () => true,
}));

mock.module("@/domains/chat/hooks/use-conversation-history", () => ({
  useConversationHistory: () => ({ pagination: {} }),
}));

const navigateMock = mock(() => Promise.resolve());
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

let toastErrorMock = mock((_message: string) => {});
mock.module("@vellumai/design-library", () => ({
  toast: {
    error: (message: string) => toastErrorMock(message),
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));

// Whether the session authenticates through a gateway decides whether a 401
// means "your login failed" at all. Both predicates are stubbed: the real
// `isGatewayAuthMode` reads the gateway token, which the guardian-repair
// handoff clears before the 401 lands, so a case can hold them apart to model
// that ordering.
let gatewayAuthEnabled = false;
let gatewayAuthMode = false;
mock.module(
  "@/lib/auth/gateway-session",
  (): Partial<typeof GatewaySession> => ({
    isGatewayAuthEnabled: () => gatewayAuthEnabled,
    isGatewayAuthMode: () => gatewayAuthMode,
  }),
);

const { useConversationLoader } =
  await import("@/domains/chat/hooks/use-conversation-loader");

const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderLoader() {
  return renderHook(
    () =>
      useConversationLoader({
        assistantId: "asst-1",
        assistantStateKind: "active",
        activeConversationId: "conv-A",
        urlConversationId: "conv-A",
        searchParams: new URLSearchParams(),
        activeConversation: undefined,
        refreshEpoch: 0,
        reachabilityReadyEpoch: 0,
        onboardingDraftConversationIdRef: createRef<string | null>() as {
          current: string | null;
        },
      }),
    { wrapper: Wrapper },
  );
}

function currentErrorCode() {
  return useChatSessionStore.getState().error?.code ?? null;
}

beforeEach(() => {
  __resetForTesting();
  __setResumeGraceMsForTesting(DEFAULT_RESUME_GRACE_MS);
  listError = null;
  toastErrorMock = mock((_message: string) => {});
  gatewayAuthEnabled = false;
  gatewayAuthMode = false;
  useChatSessionStore.getState().setError(null);
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  __setResumeGraceMsForTesting(DEFAULT_RESUME_GRACE_MS);
  useChatSessionStore.getState().setError(null);
});

describe("useConversationLoader resume grace on list-load errors", () => {
  test("holds back the load-failed banner within the resume grace window", () => {
    // GIVEN a mounted loader with no cached conversation list
    const { rerender } = renderLoader();

    // AND the app has just resumed from the background
    act(() => {
      publish("app.resume", { signal: "visibility" });
    });

    // WHEN the list query errors transiently
    listError = new ApiError(503, "boom");
    rerender();

    // THEN no load-failed banner is raised
    expect(currentErrorCode()).toBeNull();
  });

  test("raises the load-failed banner once the resume grace window expires", async () => {
    // GIVEN a very short resume grace window
    __setResumeGraceMsForTesting(20);

    // AND a mounted loader that just resumed from the background
    const { rerender } = renderLoader();
    act(() => {
      publish("app.resume", { signal: "visibility" });
    });

    // WHEN the list error persists past the window
    listError = new ApiError(503, "boom");
    rerender();

    // THEN the load-failed banner is raised
    await waitFor(() => {
      expect(currentErrorCode()).toBe(CONVERSATION_LIST_LOAD_FAILED_CODE);
    });
  });

  test("raises the load-failed banner immediately without a resume", () => {
    // GIVEN a mounted loader with no resume signal
    const { rerender } = renderLoader();

    // WHEN the list query errors
    listError = new ApiError(500, "boom");
    rerender();

    // THEN the load-failed banner is raised right away
    expect(currentErrorCode()).toBe(CONVERSATION_LIST_LOAD_FAILED_CODE);
  });

  // On a platform session a 401 is never transient: the session is gone and
  // the user has to re-authenticate, so the toast fires regardless of the
  // grace window.
  test("still toasts an auth failure inside the resume grace window", () => {
    // GIVEN a platform session that just resumed from the background
    const { rerender } = renderLoader();
    act(() => {
      publish("app.resume", { signal: "visibility" });
    });

    // WHEN the list query fails authentication
    listError = new ApiError(401, "unauthorized");
    rerender();

    // THEN the auth toast fires and no load-failed banner is raised
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to authenticate user.");
    expect(currentErrorCode()).toBeNull();
  });

  test("says nothing about authentication on a gateway-auth 401", () => {
    /**
     * In gateway-auth mode there is no user login to fail. A 401 means the
     * gateway rejected the bearer, which the 401 recovery either re-mints
     * through or hands to the chooser's guardian repair, so the guardian is
     * told their authentication failed while it is working and pointed at a
     * sign-in that would not help.
     */

    // GIVEN a local session authenticated through the gateway
    gatewayAuthEnabled = true;
    gatewayAuthMode = true;
    const { rerender } = renderLoader();

    // WHEN the gateway rejects the bearer
    listError = new ApiError(401, "unauthorized");
    rerender();

    // THEN nothing claims the user failed to authenticate
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  test("stays quiet when the repair handoff cleared the token before the 401", () => {
    /**
     * The guardian-repair handoff calls `clearGatewayToken()` and only then
     * returns the 401 to the caller, so by the time this effect runs
     * `isGatewayAuthMode()` reads false: it bottoms out at
     * `getGatewayToken() !== null`. Classifying on that would call the repair
     * path a platform session and toast on it, which is the one path this
     * suppression exists for.
     */

    // GIVEN a gateway session whose token the handoff has already cleared
    gatewayAuthEnabled = true;
    gatewayAuthMode = false;
    const { rerender } = renderLoader();

    // WHEN the 401 that triggered the handoff reaches the loader
    listError = new ApiError(401, "unauthorized");
    rerender();

    // THEN it is still recognised as a gateway session, and says nothing
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
