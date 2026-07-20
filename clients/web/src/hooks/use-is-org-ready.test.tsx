/**
 * `useIsOrgReady` must align with the request-header source
 * (`getActiveOrganizationIdForRequests()`): a failed org-list fetch must not
 * wedge org-gated queries when sessionStorage still carries the active org id
 * from an earlier page load.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { cleanup, render } from "@testing-library/react";

import * as authStore from "@/stores/auth-store";

let hasPlatformSessionMock = true;

mock.module("@/stores/auth-store", () => ({
  ...authStore,
  useHasPlatformSession: () => hasPlatformSessionMock,
}));

const { useIsOrgReady } = await import("./use-is-org-ready");
const { useOrganizationStore } = await import("@/stores/organization-store");

const STORAGE_KEY = "vellum_active_organization_id";

let latest: boolean | null = null;

function Probe() {
  const ready = useIsOrgReady();
  useEffect(() => {
    latest = ready;
  });
  return null;
}

beforeEach(() => {
  hasPlatformSessionMock = true;
  latest = null;
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
});
