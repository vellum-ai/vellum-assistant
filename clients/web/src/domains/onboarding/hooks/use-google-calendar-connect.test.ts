/**
 * Tests for the check-in calendar connect hook, focused on platform-identity
 * resolution: a locally-hatched assistant is known to the platform by its own
 * platform UUID, so the managed OAuth start must be called with the RESOLVED
 * id — passing the local id 404s and the onError handler closes the popup the
 * moment it opened (a visible flicker).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

const startOAuthMutate = mock(
  (
    _vars: unknown,
    _handlers?: { onSuccess?: (data: unknown) => void; onError?: () => void },
  ) => {},
);
mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  useAssistantsOauthStartCreateMutation: () => ({
    mutate: startOAuthMutate,
    isPending: false,
  }),
  assistantsOauthConnectionsListOptions: (opts: unknown) => ({
    queryKey: ["oauth-connections", opts],
    queryFn: async () => [],
  }),
}));

let resolvedPlatformId = "11111111-2222-4333-8444-555555555555";
let resolveShouldThrow = false;
const resolveMock = mock(async (id: string): Promise<string> => {
  if (resolveShouldThrow) throw new Error("identity resolution failed");
  return id === "vellum-local-assistant" ? resolvedPlatformId : id;
});
mock.module("@/lib/local-platform-identity", () => ({
  resolveLocalAssistantPlatformIdentity: resolveMock,
}));

mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => false,
}));
mock.module("@/hooks/use-oauth-complete-deep-link-listener", () => ({
  useOAuthCompleteDeepLinkListener: () => {},
}));
mock.module("@/runtime/browser", () => ({
  openUrl: async () => {},
  openUrlFinishedListener: () => () => {},
}));
mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => ({ fetchQuery: async () => [] }),
}));

const { useGoogleCalendarConnect } = await import(
  "./use-google-calendar-connect"
);

// The hook opens a blank popup synchronously before the async identity
// resolution; stub a minimal Window the flow can point at Google later.
interface StubPopup {
  closed: boolean;
  close: () => void;
  location: { href: string };
}
let popupStub: StubPopup;

beforeEach(() => {
  resolveShouldThrow = false;
  resolvedPlatformId = "11111111-2222-4333-8444-555555555555";
  startOAuthMutate.mockClear();
  resolveMock.mockClear();
  popupStub = {
    closed: false,
    close: () => {
      popupStub.closed = true;
    },
    location: { href: "" },
  };
  window.open = (() => popupStub) as unknown as typeof window.open;
});

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

    await waitFor(() => expect(startOAuthMutate).toHaveBeenCalledTimes(1));
    const vars = startOAuthMutate.mock.calls[0]?.[0] as {
      path: { assistant_id: string; provider: string };
    };
    expect(resolveMock).toHaveBeenCalledWith("vellum-local-assistant");
    expect(vars.path.assistant_id).toBe(resolvedPlatformId);
    expect(vars.path.provider).toBe("google");
    // The popup stays open, waiting for the connect URL.
    expect(popupStub.closed).toBe(false);
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

    await waitFor(() => expect(startOAuthMutate).toHaveBeenCalledTimes(1));
    const vars = startOAuthMutate.mock.calls[0]?.[0] as {
      path: { assistant_id: string };
    };
    expect(vars.path.assistant_id).toBe(platformId);
  });

  test("failed identity resolution closes the popup and never starts OAuth", async () => {
    resolveShouldThrow = true;
    const { result } = renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: "vellum-local-assistant",
        onConnect: () => {},
      }),
    );

    act(() => {
      result.current.handleConnect();
    });

    await waitFor(() => expect(popupStub.closed).toBe(true));
    expect(startOAuthMutate).not.toHaveBeenCalled();
    expect(result.current.oauthInProgress).toBe(false);
  });
});
