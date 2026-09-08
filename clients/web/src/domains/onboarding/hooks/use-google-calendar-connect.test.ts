/**
 * Tests for the check-in calendar connect hook, focused on platform-identity
 * resolution: a locally-hatched assistant is known to the platform by its own
 * platform UUID, so the managed OAuth start must be called with the RESOLVED
 * id. Passing the local id 404s, and the failure path closes the popup the
 * moment it opened (a visible flicker).
 *
 * The hook is a thin wrapper over `connectManagedOAuthProvider`, so the
 * assertions land on the shared engine's SDK calls.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

import type { assistantsOauthStartCreate } from "@/generated/api/sdk.gen";
import { oauthCompletionStorageKey } from "@/lib/auth/oauth-popup";

const startCreateMock = mock(
  async (_options: Parameters<typeof assistantsOauthStartCreate>[0]) => ({
    data: {
      connect_url:
        "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=x",
    },
    error: null,
    response: new Response(),
  }),
);

// Spread the real module: the hook pulls in the generated react-query layer,
// which re-exports the rest of `sdk.gen` and fails to load from a partial mock.
const actualApiSdk = await import("@/generated/api/sdk.gen");
mock.module("@/generated/api/sdk.gen", () => ({
  ...actualApiSdk,
  assistantsOauthStartCreate: startCreateMock,
  assistantsOauthConnectionsList: mock(async () => ({
    data: [],
    error: null,
    response: new Response(),
  })),
}));
mock.module("@/generated/daemon/sdk.gen", () => ({
  oauthProvidersGet: mock(async () => ({
    data: { providers: [] },
    error: null,
  })),
}));

let resolvedPlatformId = "11111111-2222-4333-8444-555555555555";
let resolveShouldThrow = false;
const resolveMock = mock(async (id: string): Promise<string> => {
  if (resolveShouldThrow) {
    throw new Error("identity resolution failed");
  }
  return id === "vellum-local-assistant" ? resolvedPlatformId : id;
});
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
// Spread the real module so shared utilities that import other exports
// (e.g. `isCancelledError` via `captureError`) keep resolving; only the
// hook's query-client read is overridden.
const actualReactQuery = await import("@tanstack/react-query");
mock.module("@tanstack/react-query", () => ({
  ...actualReactQuery,
  useQueryClient: () => ({
    fetchQuery: async () => [],
    invalidateQueries: async () => {},
  }),
}));

const { useGoogleCalendarConnect } =
  await import("./use-google-calendar-connect");

// The engine opens a blank popup synchronously before the async identity
// resolution; stub a minimal Window the flow can point at Google later.
interface StubPopup {
  closed: boolean;
  close: () => void;
  location: { href: string };
}
let popupStub: StubPopup;
let requestIds: string[];

beforeEach(() => {
  resolveShouldThrow = false;
  resolvedPlatformId = "11111111-2222-4333-8444-555555555555";
  startCreateMock.mockClear();
  resolveMock.mockClear();
  requestIds = [];
  let counter = 0;
  globalThis.crypto.randomUUID = (() => {
    const id = `gcal-req-${++counter}`;
    requestIds.push(id);
    return id;
  }) as typeof crypto.randomUUID;
  popupStub = {
    closed: false,
    close: () => {
      popupStub.closed = true;
    },
    location: { href: "" },
  };
  window.open = (() => popupStub) as unknown as typeof window.open;
});

/** Settle the in-flight engine flow so it releases its dedupe slot. */
function settleFailed(requestId: string): void {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: oauthCompletionStorageKey(requestId),
      newValue: JSON.stringify({
        type: "vellum:oauth-complete",
        requestId,
        oauthStatus: "error",
        oauthCode: "access_denied",
      }),
    }),
  );
}

describe("useGoogleCalendarConnect", () => {
  test("starts OAuth with the RESOLVED platform assistant id, not the local id", async () => {
    const { result } = renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: "vellum-local-assistant",
        onConnect: () => {},
      }),
    );

    act(() => {
      result.current.handleConnect();
    });

    await waitFor(() => expect(startCreateMock).toHaveBeenCalledTimes(1));
    const vars = startCreateMock.mock.calls[0]?.[0];
    expect(resolveMock).toHaveBeenCalledWith("vellum-local-assistant");
    expect(vars?.path?.assistant_id).toBe(resolvedPlatformId);
    expect(vars?.path?.provider).toBe("google");
    // The popup stays open, waiting for the connect URL.
    expect(popupStub.closed).toBe(false);

    settleFailed(requestIds[0]!);
  });

  test("a platform assistant id passes through the resolver unchanged", async () => {
    const platformId = "99999999-8888-4777-8666-555555555555";
    const { result } = renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: platformId,
        onConnect: () => {},
      }),
    );

    act(() => {
      result.current.handleConnect();
    });

    await waitFor(() => expect(startCreateMock).toHaveBeenCalledTimes(1));
    expect(startCreateMock.mock.calls[0]?.[0]?.path?.assistant_id).toBe(
      platformId,
    );

    settleFailed(requestIds[0]!);
  });

  test("requests the calendar-only scope set by default", async () => {
    const { result } = renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: "22222222-3333-4444-8555-666666666666",
        onConnect: () => {},
      }),
    );

    act(() => {
      result.current.handleConnect();
    });

    await waitFor(() => expect(startCreateMock).toHaveBeenCalledTimes(1));
    expect(startCreateMock.mock.calls[0]?.[0]?.body?.requested_scopes).toEqual([
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/calendar.events",
    ]);

    settleFailed(requestIds[0]!);
  });

  test("failed identity resolution closes the popup and never starts OAuth", async () => {
    resolveShouldThrow = true;
    const { result } = renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: "33333333-4444-4555-8666-777777777777",
        onConnect: () => {},
      }),
    );

    act(() => {
      result.current.handleConnect();
    });

    await waitFor(() => expect(popupStub.closed).toBe(true));
    expect(startCreateMock).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.oauthInProgress).toBe(false));
  });
});
