/**
 * Tests for the tunnel-status query hook and its wire-to-view mapper.
 *
 * `useIsOrgReady` is the one `mock.module` here; the version gate and the
 * active assistant id are driven through their real stores so the gating the
 * hook actually ships with is what gets exercised.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { integrationsIngressStatusGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { MIN_VERSION } from "@/lib/backwards-compat/ingress-status-gate";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { toStatusView, useTunnelStatus } = await import("./use-tunnel-status");

const ASSISTANT_ID = "asst-1";
const PUBLIC_URL = "https://foo.ts.net";
const CHECKED_AT = "2026-08-21T12:00:00.000Z";

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

beforeEach(() => {
  orgReady = true;
  useResolvedAssistantsStore.getState().setActiveAssistantId(ASSISTANT_ID);
  useAssistantIdentityStore.getState().setIdentity("Test", MIN_VERSION);
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

  test("reports unconfigured with no answer and nothing in flight", () => {
    expect(toStatusView(undefined, false)).toEqual({ kind: "unconfigured" });
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

  test("degrades a stopped verdict with no record to unconfigured", () => {
    // A stopped row exists to name the command that restarts the tunnel; with
    // no provider there is nothing to tell the user, so draw nothing.
    expect(toStatusView({ state: "stopped" }, false)).toEqual({
      kind: "unconfigured",
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
    useAssistantIdentityStore.getState().setIdentity("Test", "0.11.5");
    const { result, client } = renderStatus();

    expect(probeFetchStatus(client)).toBe("idle");
    expect(result.current.status).toEqual({ kind: "unconfigured" });
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

  test("reports checking once the probe goes out", () => {
    const { result, client } = renderStatus();

    expect(probeFetchStatus(client)).toBe("fetching");
    expect(result.current.status).toEqual({ kind: "checking" });
    expect(result.current.isRefreshing).toBe(true);
  });
});
