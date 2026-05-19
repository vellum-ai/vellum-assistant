import { describe, expect, test } from "bun:test";

import {
  deriveOrganizationStatus,
  shouldClearOrganizationRequestState,
} from "@/lib/organization/organization-provider.js";

describe("deriveOrganizationStatus", () => {
  test("returns idle when organization query is disabled", () => {
    expect(
      deriveOrganizationStatus({
        isOrganizationQueryEnabled: false,
        isQueryError: false,
        isQueryPending: false,
        currentOrganizationId: null,
        activeRequestOrganizationId: null,
      }),
    ).toBe("idle");
  });

  test("returns loading while initial organization query is pending", () => {
    expect(
      deriveOrganizationStatus({
        isOrganizationQueryEnabled: true,
        isQueryError: false,
        isQueryPending: true,
        currentOrganizationId: null,
        activeRequestOrganizationId: null,
      }),
    ).toBe("loading");
  });

  test("returns error when query fails", () => {
    expect(
      deriveOrganizationStatus({
        isOrganizationQueryEnabled: true,
        isQueryError: true,
        isQueryPending: false,
        currentOrganizationId: "org-123",
        activeRequestOrganizationId: "org-123",
      }),
    ).toBe("error");
  });

  test("returns error when no organization can be resolved", () => {
    expect(
      deriveOrganizationStatus({
        isOrganizationQueryEnabled: true,
        isQueryError: false,
        isQueryPending: false,
        currentOrganizationId: null,
        activeRequestOrganizationId: null,
      }),
    ).toBe("error");
  });

  test("returns loading when organization is not yet synced to request state", () => {
    expect(
      deriveOrganizationStatus({
        isOrganizationQueryEnabled: true,
        isQueryError: false,
        isQueryPending: false,
        currentOrganizationId: "org-123",
        activeRequestOrganizationId: null,
      }),
    ).toBe("loading");
  });

  test("returns ready when organization is synced to request state", () => {
    expect(
      deriveOrganizationStatus({
        isOrganizationQueryEnabled: true,
        isQueryError: false,
        isQueryPending: false,
        currentOrganizationId: "org-123",
        activeRequestOrganizationId: "org-123",
      }),
    ).toBe("ready");
  });
});

describe("shouldClearOrganizationRequestState", () => {
  test("does not clear while auth bootstrap is in progress", () => {
    expect(
      shouldClearOrganizationRequestState({
        isAuthLoading: true,
        isLoggedIn: false,
        isQueryError: false,
      }),
    ).toBe(false);
  });

  test("clears when auth bootstrap completes and user is unauthenticated", () => {
    expect(
      shouldClearOrganizationRequestState({
        isAuthLoading: false,
        isLoggedIn: false,
        isQueryError: false,
      }),
    ).toBe(true);
  });

  test("clears on organization query error after auth bootstrap", () => {
    expect(
      shouldClearOrganizationRequestState({
        isAuthLoading: false,
        isLoggedIn: true,
        isQueryError: true,
      }),
    ).toBe(true);
  });
});
