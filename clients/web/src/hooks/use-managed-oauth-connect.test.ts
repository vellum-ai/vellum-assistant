/**
 * The connect flow reads the connections list, not the authorization window.
 *
 * A document carrying `Cross-Origin-Opener-Policy` disowns the opener's handle
 * (link.com sends `same-origin`, connect.stripe.com sends
 * `same-origin-allow-popups`), after which `closed` reads `true` while the
 * window is still open. These tests pin the properties that make that
 * irrelevant: the outcome comes from the platform, and only the user cancels.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { assistantsOauthStartCreate } from "@/generated/api/sdk.gen";
import { oauthCompletionStorageKey } from "@/lib/auth/oauth-popup";

const CONNECTED_ROW = {
  id: "conn-1",
  provider: "google",
  status: "ACTIVE",
  connected: true,
  account_label: "user@example.com",
  scopes_granted: ["scope-a"],
  expires_at: null,
};

/** Rows the connections endpoint reports, mutable per test. */
let connectionRows: unknown[] = [];
let connectionsListFails = false;

const startCreateMock = mock(
  async (_options: Parameters<typeof assistantsOauthStartCreate>[0]) => ({
    data: { connect_url: "https://accounts.google.com/o/oauth2/auth" },
    error: null,
    response: new Response(),
  }),
);

const actualApiSdk = await import("@/generated/api/sdk.gen");
mock.module("@/generated/api/sdk.gen", () => ({
  ...actualApiSdk,
  assistantsOauthStartCreate: startCreateMock,
  assistantsOauthConnectionsList: mock(async () => {
    if (connectionsListFails) {
      return {
        data: undefined,
        error: { detail: "boom" },
        response: new Response(),
      };
    }
    return { data: connectionRows, error: null, response: new Response() };
  }),
}));

const resolveMock = mock(async (id: string) =>
  id === "local-assistant" ? "11111111-2222-4333-8444-555555555555" : id,
);
mock.module("@/lib/local-platform-identity", () => ({
  resolveLocalAssistantPlatformIdentity: resolveMock,
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
  useIsNativePlatform: () => false,
}));
mock.module("@/runtime/browser", () => ({
  openUrl: async () => {},
  openUrlFinishedListener: () => () => {},
}));
// Real waits would hold the suite open for seconds.
const actualTiming = await import("@/lib/auth/oauth-connect-timing");
mock.module("@/lib/auth/oauth-connect-timing", () => ({
  ...actualTiming,
  CONNECTION_CONFIRM_WINDOW_MS: 40,
}));

// The hook reads the connections list through TanStack. Serve it from the same
// mutable rows the SDK mock uses so a test can make a grant appear.
const actualReactQuery = await import("@tanstack/react-query");
const invalidateQueries = mock(() => Promise.resolve());
mock.module("@tanstack/react-query", () => ({
  ...actualReactQuery,
  useQueryClient: () => ({
    invalidateQueries,
    fetchQuery: async () => {
      if (connectionsListFails) {
        throw new Error("boom");
      }
      return connectionRows;
    },
  }),
  useQuery: ({ enabled }: { enabled?: boolean }) => ({
    data: enabled ? connectionRows : undefined,
  }),
}));

const { useManagedOAuthConnect } = await import("./use-managed-oauth-connect");
const { useOAuthConnectAttemptStore, oauthConnectAttemptKey } =
  await import("@/stores/oauth-connect-attempt-store");

interface StubPopup {
  closed: boolean;
  close: () => void;
  location: { replace: (url: string) => void; href: string };
}
let popupStub: StubPopup;
let openSpy: ReturnType<typeof mock>;
let navigatedTo: string[];

const OPTS = {
  assistantId: "assistant-1",
  providerKey: "google",
  providerLabel: "Google",
};

beforeEach(() => {
  connectionRows = [];
  connectionsListFails = false;
  startCreateMock.mockClear();
  resolveMock.mockClear();
  invalidateQueries.mockClear();
  navigatedTo = [];
  // Reset the module-scope store so attempts do not leak between tests.
  for (const key of Object.keys(
    useOAuthConnectAttemptStore.getState().attempts,
  )) {
    useOAuthConnectAttemptStore.getState().clearAttempt(key);
  }
  popupStub = {
    closed: false,
    close: () => {
      popupStub.closed = true;
    },
    location: {
      href: "",
      replace: (url: string) => navigatedTo.push(url),
    },
  };
  openSpy = mock(() => popupStub);
  window.open = openSpy as unknown as typeof window.open;
});

function completionEvent(
  requestId: string,
  oauthStatus: string,
  code?: string,
) {
  return new StorageEvent("storage", {
    key: oauthCompletionStorageKey(requestId),
    newValue: JSON.stringify({
      type: "vellum:oauth-complete",
      requestId,
      oauthStatus,
      oauthCode: code ?? null,
    }),
  });
}

function attemptFor(assistantId = "assistant-1", providerKey = "google") {
  return useOAuthConnectAttemptStore.getState().attempts[
    oauthConnectAttemptKey(assistantId, providerKey)
  ];
}

describe("useManagedOAuthConnect", () => {
  test("authorization starts against the RESOLVED platform assistant id", async () => {
    const { result } = renderHook(() =>
      useManagedOAuthConnect({ ...OPTS, assistantId: "local-assistant" }),
    );

    act(() => result.current.connect());

    await waitFor(() => expect(startCreateMock).toHaveBeenCalledTimes(1));
    expect(resolveMock).toHaveBeenCalledWith("local-assistant");
    expect(startCreateMock.mock.calls[0]?.[0]?.path?.assistant_id).toBe(
      "11111111-2222-4333-8444-555555555555",
    );
    await waitFor(() => expect(navigatedTo).toHaveLength(1));
  });

  test("a connection the platform reports ends the attempt as connected", async () => {
    const { result, rerender } = renderHook(() => useManagedOAuthConnect(OPTS));

    act(() => result.current.connect());
    await waitFor(() => expect(attemptFor()).toBeTruthy());
    expect(result.current.status).toBe("attempting");

    // The grant lands wherever the user completed it, and the next read of the
    // list is what tells the flow.
    connectionRows = [CONNECTED_ROW];
    rerender();

    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.connection?.id).toBe("conn-1");
    expect(attemptFor()).toBeUndefined();
  });

  test("an account already connected before the attempt is not reported as new", async () => {
    // The baseline is captured before authorizing, so a row that was already
    // there cannot pass as the one the user just granted.
    connectionRows = [CONNECTED_ROW];
    const { result, rerender } = renderHook(() => useManagedOAuthConnect(OPTS));

    act(() => result.current.connect());
    await waitFor(() => expect(attemptFor()).toBeTruthy());
    rerender();

    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.status).toBe("attempting");
    expect(result.current.connection).toBeNull();
  });

  test("a failed baseline fetch refuses to start rather than guessing", async () => {
    // An empty baseline from a failed fetch would make every existing row look
    // new, so a cancelled connect would report an old account as just granted.
    connectionsListFails = true;
    connectionRows = [CONNECTED_ROW];
    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));

    act(() => result.current.connect());

    await waitFor(() => expect(result.current.errorMessage).toBeTruthy());
    expect(startCreateMock).not.toHaveBeenCalled();
    expect(attemptFor()).toBeUndefined();
    expect(result.current.status).toBe("idle");
  });

  test("a completion payload only invalidates; the list still decides", async () => {
    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => result.current.connect());
    await waitFor(() => expect(attemptFor()).toBeTruthy());

    act(() => {
      window.dispatchEvent(
        completionEvent(attemptFor()!.requestId, "connected"),
      );
    });

    await waitFor(() => expect(invalidateQueries).toHaveBeenCalled());
    // No row yet, so the flow keeps waiting rather than claiming success.
    expect(result.current.status).toBe("attempting");
  });

  test("a provider failure ends the attempt with localized copy", async () => {
    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => result.current.connect());
    await waitFor(() => expect(attemptFor()).toBeTruthy());

    act(() => {
      window.dispatchEvent(
        completionEvent(attemptFor()!.requestId, "error", "access_denied"),
      );
    });

    await waitFor(() => expect(result.current.errorMessage).toBeTruthy());
    expect(result.current.errorMessage).toContain("access_denied");
    expect(attemptFor()).toBeUndefined();
  });

  test("a remount does not open a second authorization window", async () => {
    const first = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => first.result.current.connect());
    await waitFor(() => expect(attemptFor()).toBeTruthy());
    first.unmount();

    // The attempt lives in the store, not the component, so the card that
    // remounts mid-authorization finds it instead of starting over.
    const second = renderHook(() => useManagedOAuthConnect(OPTS));
    expect(second.result.current.status).toBe("attempting");
    act(() => second.result.current.connect());
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  test("a second click during setup does not open a second authorization", async () => {
    // Identity resolution, the baseline read and the start request all happen
    // after the click. The slot has to be claimed before them, or a double
    // click races two authorizations into one attempt.
    let releaseResolve: (() => void) | undefined;
    resolveMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseResolve = () => resolve("assistant-1");
        }),
    );

    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));

    act(() => result.current.connect());
    act(() => result.current.connect());

    expect(openSpy).toHaveBeenCalledTimes(1);

    act(() => releaseResolve?.());
    await waitFor(() => expect(startCreateMock).toHaveBeenCalledTimes(1));
  });

  test("a dismissed attempt's late failure does not clear its replacement", async () => {
    // Setup outlives a dismissal, so A's rejection must not tear down B.
    let failA: ((err: Error) => void) | undefined;
    resolveMock.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          failA = reject;
        }),
    );

    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => result.current.connect());
    const attemptA = attemptFor()?.requestId;

    act(() => result.current.dismiss());
    act(() => result.current.connect());
    const attemptB = attemptFor()?.requestId;
    expect(attemptB).not.toBe(attemptA);

    act(() => failA?.(new Error("stale")));
    await new Promise((r) => setTimeout(r, 30));

    expect(attemptFor()?.requestId).toBe(attemptB!);
    expect(result.current.errorMessage).toBeNull();
  });

  test("a dismissed attempt does not hand its window to the provider", async () => {
    let releaseA: (() => void) | undefined;
    resolveMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseA = () => resolve("assistant-1");
        }),
    );

    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => result.current.connect());
    act(() => result.current.dismiss());

    act(() => releaseA?.());
    await new Promise((r) => setTimeout(r, 30));

    // Its window is closed rather than pointed at the provider, so a dismissed
    // attempt cannot leave a second authorization running untracked.
    expect(navigatedTo).toHaveLength(0);
  });

  test("a payload written while nothing was listening is still claimed", async () => {
    const { result, rerender } = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => result.current.connect());
    await waitFor(() => expect(attemptFor()?.platformAssistantId).toBeTruthy());

    // The callback page wrote its result while no listener was mounted.
    window.localStorage.setItem(
      oauthCompletionStorageKey(attemptFor()!.requestId),
      JSON.stringify({
        type: "vellum:oauth-complete",
        requestId: attemptFor()!.requestId,
        oauthStatus: "error",
        oauthCode: "access_denied",
      }),
    );
    rerender();

    await waitFor(() => expect(result.current.errorMessage).toBeTruthy());
    expect(attemptFor()).toBeUndefined();
  });

  test("blocked site storage does not break the flow", async () => {
    // A privacy or cookie policy can make localStorage throw outright. The
    // event transports and the connections poll carry the flow without it.
    const realStorage = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });

    try {
      const { result, rerender } = renderHook(() =>
        useManagedOAuthConnect(OPTS),
      );
      act(() => result.current.connect());
      await waitFor(() =>
        expect(attemptFor()?.platformAssistantId).toBeTruthy(),
      );

      expect(result.current.status).toBe("attempting");
      expect(result.current.errorMessage).toBeNull();

      connectionRows = [CONNECTED_ROW];
      rerender();
      await waitFor(() => expect(result.current.status).toBe("connected"));
    } finally {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        value: realStorage,
      });
    }
  });

  test("a confirmed authorization settles even when its row never arrives", async () => {
    // The connections list does not model every provider the platform can
    // authorize (Link by Stripe is absent from OAuthProviderEnum), so a flow
    // whose callback reported success must not wait on a row forever.
    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => result.current.connect());
    await waitFor(() => expect(attemptFor()?.platformAssistantId).toBeTruthy());

    act(() => {
      window.dispatchEvent(
        completionEvent(attemptFor()!.requestId, "connected"),
      );
    });

    // Still looking for the account for now.
    expect(result.current.status).toBe("attempting");

    await waitFor(() => expect(result.current.status).toBe("connected"));
    // No row ever appeared, so no details are invented.
    expect(result.current.connection).toBeNull();
    expect(attemptFor()).toBeUndefined();
  });

  test("dismiss is what ends an attempt", async () => {
    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => result.current.connect());
    await waitFor(() => expect(attemptFor()).toBeTruthy());

    act(() => result.current.dismiss());

    expect(attemptFor()).toBeUndefined();
    expect(result.current.status).toBe("idle");
  });

  test("a blocked popup is reported without starting an attempt", async () => {
    openSpy = mock(() => null);
    window.open = openSpy as unknown as typeof window.open;
    const { result } = renderHook(() => useManagedOAuthConnect(OPTS));

    act(() => result.current.connect());

    await waitFor(() => expect(result.current.errorMessage).toBeTruthy());
    expect(startCreateMock).not.toHaveBeenCalled();
    expect(attemptFor()).toBeUndefined();
  });

  test("the authorization window is never consulted after hand-off", async () => {
    const { result, rerender } = renderHook(() => useManagedOAuthConnect(OPTS));
    act(() => result.current.connect());
    await waitFor(() => expect(navigatedTo).toHaveLength(1));

    // What COOP does to the handle. It must change nothing.
    popupStub.closed = true;
    rerender();
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.status).toBe("attempting");
    expect(result.current.errorMessage).toBeNull();

    connectionRows = [CONNECTED_ROW];
    rerender();
    await waitFor(() => expect(result.current.status).toBe("connected"));
  });
});
