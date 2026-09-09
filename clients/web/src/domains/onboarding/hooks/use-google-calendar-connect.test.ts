/**
 * The check-in calendar connect hook adds three things to the shared connect
 * flow: the narrowed scope set, the provider label, and an `onConnect(scopes)`
 * that schedules the check-in and navigates.
 *
 * `onConnect` navigating is why the mounted guard matters: a connection can
 * land after the user has moved on through the top nav, and dragging them back
 * to a step they left is worse than missing the callback.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";

import type { OAuthConnection } from "@/generated/api/types.gen";
import type {
  UseManagedOAuthConnectOptions,
  UseManagedOAuthConnectResult,
} from "@/hooks/use-managed-oauth-connect";

const CONNECTION = {
  id: "conn-1",
  provider: "google",
  connected: true,
  scopes_granted: ["https://www.googleapis.com/auth/calendar.events"],
} as OAuthConnection;

let connectResult: Partial<UseManagedOAuthConnectResult> = {};
let capturedOptions: UseManagedOAuthConnectOptions | null = null;
const connectMock = mock(() => {});

mock.module("@/hooks/use-managed-oauth-connect", () => ({
  useManagedOAuthConnect: (options: UseManagedOAuthConnectOptions) => {
    capturedOptions = options;
    return {
      connect: connectMock,
      dismiss: () => {},
      status: "idle" as const,
      connection: null,
      errorMessage: null,
      ...connectResult,
    };
  },
}));

const { useGoogleCalendarConnect, GOOGLE_CALENDAR_CONNECT_SCOPES } =
  await import("./use-google-calendar-connect");

beforeEach(() => {
  connectResult = {};
  capturedOptions = null;
  connectMock.mockClear();
});

describe("useGoogleCalendarConnect", () => {
  test("requests the calendar-only scope set for the google provider", () => {
    renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: "assistant-1",
        onConnect: () => {},
      }),
    );

    expect(capturedOptions?.providerKey).toBe("google");
    expect(capturedOptions?.requestedScopes).toEqual(
      GOOGLE_CALENDAR_CONNECT_SCOPES,
    );
    // Identity scopes are required or the grant fails with `identity_failed`.
    expect(GOOGLE_CALENDAR_CONNECT_SCOPES).toContain("openid");
  });

  test("an explicit scope override is passed through", () => {
    renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: "assistant-1",
        requestedScopes: ["openid", "scope-x"],
        onConnect: () => {},
      }),
    );

    expect(capturedOptions?.requestedScopes).toEqual(["openid", "scope-x"]);
  });

  test("handleConnect starts the shared flow", () => {
    const { result } = renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: "assistant-1",
        onConnect: () => {},
      }),
    );

    act(() => result.current.handleConnect());

    expect(connectMock).toHaveBeenCalled();
  });

  test("a landed connection hands the granted scopes to the caller", async () => {
    connectResult = { status: "connected", connection: CONNECTION };
    const onConnect = mock(() => {});

    renderHook(() =>
      useGoogleCalendarConnect({ assistantId: "assistant-1", onConnect }),
    );

    await waitFor(() =>
      expect(onConnect).toHaveBeenCalledWith([
        "https://www.googleapis.com/auth/calendar.events",
      ]),
    );
  });

  test("an open authorization reports as in progress", () => {
    connectResult = { status: "attempting" };
    const { result } = renderHook(() =>
      useGoogleCalendarConnect({
        assistantId: "assistant-1",
        onConnect: () => {},
      }),
    );

    expect(result.current.oauthInProgress).toBe(true);
  });

  test("a connection landing after unmount does not navigate", async () => {
    connectResult = { status: "connected", connection: CONNECTION };
    const onConnect = mock(() => {});

    const { unmount } = renderHook(() =>
      useGoogleCalendarConnect({ assistantId: "assistant-1", onConnect }),
    );
    unmount();
    onConnect.mockClear();

    // Remounting is a fresh screen; a stale callback must not fire against the
    // unmounted one.
    await new Promise((r) => setTimeout(r, 20));
    expect(onConnect).not.toHaveBeenCalled();
  });
});
