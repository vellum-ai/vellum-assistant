/**
 * Tests for the tunnel-status query hook and its wire-to-view mapper.
 *
 * `useIsOrgReady` and the generated probe call are the two `mock.module`s
 * here; the version gate and the active assistant id are driven through their
 * real stores so the gating the hook actually ships with is what gets
 * exercised. Mocking the SDK call (rather than only reading TanStack's
 * `fetchStatus`) is what lets the refresh tests count probes: an imperative
 * `refetch()` that the guard should have swallowed leaves no trace in the
 * query state, but it would show up as a call here.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { integrationsIngressStatusGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { MIN_VERSION } from "@/lib/backwards-compat/ingress-status-gate";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ASSISTANT_ID = "asst-1";
const PUBLIC_URL = "https://foo.ts.net";
const CHECKED_AT = "2026-08-21T12:00:00.000Z";

let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

/** Set by a test to make the probe fail the way a dead daemon would. */
let probeFailure: Error | null = null;

const probeMock = mock(async () => {
  if (probeFailure) {
    throw probeFailure;
  }
  return {
    data: {
      state: "healthy",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: CHECKED_AT,
    },
    error: undefined,
    response: new Response(null, { status: 200 }),
  };
});

/* Spread over the real module rather than replacing it: the generated SDK is a
   single barrel that the query-options barrel also pulls from, and a bare
   object drops every export this file does not name. */
const realDaemonSdk = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...realDaemonSdk,
  integrationsIngressStatusGet: probeMock,
}));

const { toStatusView, useTunnelStatus } = await import("./use-tunnel-status");

/** "idle" unless the status probe actually went out. */
function probeFetchStatus(client: QueryClient): string {
  return (
    client.getQueryState(
      integrationsIngressStatusGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
      }),
    )?.fetchStatus ?? "idle"
  );
}

function renderStatus(enabled = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(() => useTunnelStatus(enabled), { wrapper });
  return { result, client };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  orgReady = true;
  probeFailure = null;
  probeMock.mockClear();
  useResolvedAssistantsStore.getState().setActiveAssistantId(ASSISTANT_ID);
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test", MIN_VERSION, ASSISTANT_ID);
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("toStatusView", () => {
  test("reports checking while the first probe is in flight", () => {
    expect(toStatusView(undefined, true)).toEqual({ kind: "checking" });
  });

  // Only the daemon says "no tunnel"; an answer the card never got is a
  // different thing, and the card restores its pre-probe fallbacks for it.
  test("reports unavailable with no answer and nothing in flight", () => {
    expect(toStatusView(undefined, false)).toEqual({ kind: "unavailable" });
  });

  test("maps unconfigured", () => {
    expect(toStatusView({ state: "unconfigured" }, false)).toEqual({
      kind: "unconfigured",
    });
  });

  test("flattens stopped onto the last tunnel record", () => {
    expect(
      toStatusView(
        {
          state: "stopped",
          lastTunnel: { provider: "tailscale", publicBaseUrl: PUBLIC_URL },
        },
        false,
      ),
    ).toEqual({
      kind: "stopped",
      provider: "tailscale",
      publicBaseUrl: PUBLIC_URL,
    });
  });

  test("degrades a stopped verdict with no record to unavailable", () => {
    // A stopped row exists to name the command that restarts the tunnel; with
    // no provider there is nothing to tell the user, and nothing usable came
    // back either, so the card keeps its own fallbacks.
    expect(toStatusView({ state: "stopped" }, false)).toEqual({
      kind: "unavailable",
    });
  });

  test("maps healthy", () => {
    expect(
      toStatusView(
        { state: "healthy", publicBaseUrl: PUBLIC_URL, checkedAt: CHECKED_AT },
        false,
      ),
    ).toEqual({
      kind: "healthy",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: CHECKED_AT,
    });
  });

  test("maps unreachable and drops the daemon's detail string", () => {
    expect(
      toStatusView(
        {
          state: "unreachable",
          publicBaseUrl: PUBLIC_URL,
          checkedAt: CHECKED_AT,
          detail: "connection refused",
        },
        false,
      ),
    ).toEqual({
      kind: "unreachable",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: CHECKED_AT,
    });
  });

  test("maps foreign with the serving assistant's name", () => {
    expect(
      toStatusView(
        {
          state: "foreign",
          publicBaseUrl: PUBLIC_URL,
          checkedAt: CHECKED_AT,
          servingAssistantName: "Other",
        },
        false,
      ),
    ).toEqual({
      kind: "foreign",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: CHECKED_AT,
      servingAssistantName: "Other",
    });
  });

  test("omits the name when the foreign edge reports none", () => {
    expect(
      toStatusView(
        { state: "foreign", publicBaseUrl: PUBLIC_URL, checkedAt: CHECKED_AT },
        false,
      ),
    ).toEqual({
      kind: "foreign",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: CHECKED_AT,
    });
  });

  test("keeps a probed state renderable when the daemon omits its fields", () => {
    expect(toStatusView({ state: "healthy" }, false)).toEqual({
      kind: "healthy",
      publicBaseUrl: "",
      checkedAt: "",
    });
  });
});

describe("useTunnelStatus", () => {
  test("never probes an assistant whose version predates the route", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Test", "0.11.5", ASSISTANT_ID);
    const { result, client } = renderStatus();

    expect(probeFetchStatus(client)).toBe("idle");
    expect(result.current.status).toEqual({ kind: "unavailable" });
    expect(result.current.isRefreshing).toBe(false);
  });

  test("holds the probe until the org is ready", () => {
    orgReady = false;
    const { client } = renderStatus();

    expect(probeFetchStatus(client)).toBe("idle");
  });

  test("holds the probe while the caller's own condition is false", () => {
    const { client } = renderStatus(false);

    expect(probeFetchStatus(client)).toBe("idle");
  });

  // The cross-assistant skew window the gate is scoped for: on a switch the
  // active id is already the incoming assistant while the identity store still
  // holds the outgoing one's version. An unscoped gate would read that stale
  // version and aim the new route at a daemon that may not serve it.
  test("holds the probe while the hydrated version belongs to another assistant", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Other", MIN_VERSION, "asst-outgoing");
    const { client } = renderStatus();

    expect(probeFetchStatus(client)).toBe("idle");
  });

  test("reports checking once the probe goes out", () => {
    const { result, client } = renderStatus();

    expect(probeFetchStatus(client)).toBe("fetching");
    expect(result.current.status).toEqual({ kind: "checking" });
    expect(result.current.isRefreshing).toBe(true);
  });

  test("reports unavailable once the probe gives up", async () => {
    probeFailure = new Error("connection refused");
    const { result } = renderStatus();

    await waitFor(() =>
      expect(result.current.status).toEqual({ kind: "unavailable" }),
    );
    expect(result.current.isRefreshing).toBe(false);
  });
});

// `refetch()` ignores the query's `enabled` option, so the same condition has
// to guard the imperative path or the `app.resume` re-check would walk past
// every gate above.
describe("useTunnelStatus · refresh", () => {
  test("does not probe when the assistant predates the route", async () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Test", "0.11.5", ASSISTANT_ID);
    const { result } = renderStatus();

    act(() => result.current.refresh());
    await settle();

    expect(probeMock).not.toHaveBeenCalled();
  });

  test("does not probe while the org is not ready", async () => {
    orgReady = false;
    const { result } = renderStatus();

    act(() => result.current.refresh());
    await settle();

    expect(probeMock).not.toHaveBeenCalled();
  });

  test("does not probe while the caller's own condition is false", async () => {
    const { result } = renderStatus(false);

    act(() => result.current.refresh());
    await settle();

    expect(probeMock).not.toHaveBeenCalled();
  });

  test("re-probes once every gate holds", async () => {
    const { result, client } = renderStatus();

    // Wait out the mount probe: an in-flight fetch swallows a refetch, so a
    // second call only proves the guard opened after the first one settles.
    await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(probeFetchStatus(client)).toBe("idle"));

    act(() => result.current.refresh());

    await waitFor(() => expect(probeMock).toHaveBeenCalledTimes(2));
  });
});
