/**
 * `useIsOrgReady` must align with the request-header source
 * (`getActiveOrganizationIdForRequests()`): a failed org-list fetch must not
 * wedge org-gated queries when sessionStorage still carries the active org id
 * from an earlier page load.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, render } from "@testing-library/react";

import * as authStore from "@/stores/auth-store";

let hasPlatformSessionMock = true;

mock.module("@/stores/auth-store", () => ({
  ...authStore,
  useHasPlatformSession: () => hasPlatformSessionMock,
}));

const { useIsOrgReady, useOrgHeaderReadiness } = await import(
  "./use-is-org-ready"
);
const { useOrganizationStore } = await import("@/stores/organization-store");

const STORAGE_KEY = "vellum_active_organization_id";

let latest: boolean | null = null;
let latestReadiness: string | null = null;

function Probe() {
  const ready = useIsOrgReady();
  useEffect(() => {
    latest = ready;
  });
  return null;
}

function ReadinessProbe() {
  const readiness = useOrgHeaderReadiness();
  useEffect(() => {
    latestReadiness = readiness;
  });
  return null;
}

beforeEach(() => {
  hasPlatformSessionMock = true;
  latest = null;
  latestReadiness = null;
  sessionStorage.clear();
  useOrganizationStore.setState({
    organizations: [],
    currentOrganizationId: null,
    status: "idle",
    error: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("useIsOrgReady", () => {
  test("not ready with a platform session and no org id anywhere", () => {
    render(<Probe />);
    expect(latest).toBe(false);
  });

  test("ready once the store has hydrated", () => {
    useOrganizationStore.setState({
      currentOrganizationId: "org-1",
      status: "ready",
    });
    render(<Probe />);
    expect(latest).toBe(true);
  });

  test("ready via the sessionStorage fallback when the org fetch failed", () => {
    sessionStorage.setItem(STORAGE_KEY, "org-1");
    useOrganizationStore.setState({
      status: "error",
      error: "Failed to load organizations.",
    });
    render(<Probe />);
    expect(latest).toBe(true);
  });

  test("ready without a platform session (self-hosted auth)", () => {
    hasPlatformSessionMock = false;
    render(<Probe />);
    expect(latest).toBe(true);
  });

  test("clearOrganization revokes fallback-only readiness", () => {
    // Readiness comes solely from the sessionStorage fallback — the store's
    // id slice is null and stays null through clearOrganization(), so only
    // the status subscription can deliver the re-render.
    sessionStorage.setItem(STORAGE_KEY, "org-1");
    useOrganizationStore.setState({
      status: "error",
      error: "Failed to load organizations.",
    });
    render(<Probe />);
    expect(latest).toBe(true);

    act(() => {
      useOrganizationStore.getState().clearOrganization();
    });
    expect(latest).toBe(false);
  });
});

describe("useOrgHeaderReadiness", () => {
  // Callers that wait for the header need "no id yet" and "no id ever" to be
  // different answers — the boolean gate collapses them, so a waiter can't tell
  // a cold load from a dead end.
  test("an in-flight org fetch is resolving, not unavailable", () => {
    useOrganizationStore.setState({ status: "loading" });
    render(<ReadinessProbe />);
    expect(latestReadiness).toBe("resolving");
  });

  test("an unstarted org fetch is resolving", () => {
    render(<ReadinessProbe />);
    expect(latestReadiness).toBe("resolving");
  });

  test("a terminal org failure with no fallback id is unavailable", () => {
    // `fetchOrganizations()` lands on `ready` or `error` on every exit path, so
    // this is the bound on how long a waiter can sit in `resolving`.
    useOrganizationStore.setState({
      status: "error",
      error: "Failed to load organizations.",
    });
    render(<ReadinessProbe />);
    expect(latestReadiness).toBe("unavailable");
  });

  test("a hydrated org id is ready", () => {
    useOrganizationStore.setState({
      currentOrganizationId: "org-1",
      status: "ready",
    });
    render(<ReadinessProbe />);
    expect(latestReadiness).toBe("ready");
  });

  test("no platform session needs no header at all", () => {
    hasPlatformSessionMock = false;
    render(<ReadinessProbe />);
    expect(latestReadiness).toBe("ready");
  });
});
