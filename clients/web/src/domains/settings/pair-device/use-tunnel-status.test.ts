/**
 * Tests for the tunnel-status query hook and its wire-to-view mapper.
 *
 * `useIsOrgReady` and the generated probe call are the two `mock.module`s
 * here (the probe through the shared `installIngressProbe` harness); the
 * version gate and the active assistant id are driven through their real
 * stores so the gating the hook actually ships with is what gets exercised.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { integrationsIngressStatusGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { MIN_VERSION } from "@/lib/backwards-compat/ingress-status-gate";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import {
  createQueryClientWrapper,
  installIngressProbe,
  VERSION_BELOW_INGRESS_STATUS,
} from "./pair-device-test-helpers";

const ASSISTANT_ID = "asst-1";
const PUBLIC_URL = "https://foo.ts.net";
const CHECKED_AT = "2026-08-21T12:00:00.000Z";

let orgReady = true;
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const {
  probe: probeMock,
  failWith,
  reset: resetProbe,
} = await installIngressProbe({
  state: "healthy",
  publicBaseUrl: PUBLIC_URL,
  checkedAt: CHECKED_AT,
});

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
  const { client, wrapper } = createQueryClientWrapper();
  const { result } = renderHook(() => useTunnelStatus(enabled), { wrapper });
  return { result, client };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  orgReady = true;
  resetProbe();
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

  // A cached bundle can outlive the daemon it talks to. Falling off the switch
  // would hand the row `undefined` and crash it on `.kind`.
  test("reports unavailable for a state this bundle predates", () => {
    expect(
      toStatusView(
        { state: "a-state-from-a-newer-daemon" } as never,
        false,
      ),
    ).toEqual({ kind: "unavailable" });
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

  // Ingress switched off with no tunnel on record. The daemon still answered,
  // so the verdict stands: degrading it to `unavailable` would send the card
  // back to the recorded ingress URL this probe exists to replace.
  test("keeps a stopped verdict with no record a stopped row", () => {
    expect(toStatusView({ state: "stopped" }, false)).toEqual({
      kind: "stopped",
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

  // The address answers, so it carries one, and the recorded provider comes
  // along for the same reason it does on unreachable: the fix is a restart.
  test("maps unpairable with its detail and recorded provider", () => {
    expect(
      toStatusView(
        {
          state: "unpairable",
          publicBaseUrl: PUBLIC_URL,
          checkedAt: CHECKED_AT,
          detail: "HTTP 404",
          lastTunnel: { provider: "tailscale", publicBaseUrl: PUBLIC_URL },
        },
        false,
      ),
    ).toEqual({
      kind: "unpairable",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: CHECKED_AT,
      detail: "HTTP 404",
      provider: "tailscale",
    });
  });

  test("carries the daemon's detail onto unreachable", () => {
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
      detail: "connection refused",
    });
  });

  // A killed tunnel answers as unreachable, and the record the daemon kept is
  // what lets the row name the command that starts it again.
  test("carries the last tunnel's provider onto unreachable", () => {
    expect(
      toStatusView(
        {
          state: "unreachable",
          publicBaseUrl: PUBLIC_URL,
          checkedAt: CHECKED_AT,
          lastTunnel: { provider: "tailscale", publicBaseUrl: PUBLIC_URL },
        },
        false,
      ),
    ).toEqual({
      kind: "unreachable",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: CHECKED_AT,
      provider: "tailscale",
    });
  });

  test("carries the last tunnel's provider onto foreign", () => {
    expect(
      toStatusView(
        {
          state: "foreign",
          publicBaseUrl: PUBLIC_URL,
          checkedAt: CHECKED_AT,
          lastTunnel: { provider: "ngrok", publicBaseUrl: PUBLIC_URL },
        },
        false,
      ),
    ).toEqual({
      kind: "foreign",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: CHECKED_AT,
      provider: "ngrok",
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
      .setIdentity("Test", VERSION_BELOW_INGRESS_STATUS, ASSISTANT_ID);
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
    failWith(new Error("connection refused"));
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
      .setIdentity("Test", VERSION_BELOW_INGRESS_STATUS, ASSISTANT_ID);
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
