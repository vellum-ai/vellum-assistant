/**
 * The organization behind `Vellum-Organization-Id` lives in the store, so the
 * store and sessionStorage never disagree about which organization a request
 * is scoped to.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { OrganizationRead } from "@/generated/api/types.gen";

const sdkGen = await import("@/generated/api/sdk.gen");

let listOrganizations: () => Promise<unknown> = () =>
  Promise.resolve({ data: { results: [] } });

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsList: () => listOrganizations(),
}));

const { getActiveOrganizationIdForRequests, useOrganizationStore } =
  await import("./organization-store");

const STORAGE_KEY = "vellum_active_organization_id";
const ORG_A: OrganizationRead = { id: "org-a", name: "Org A" };
const ORG_B: OrganizationRead = { id: "org-b", name: "Org B" };

beforeEach(() => {
  listOrganizations = () => Promise.resolve({ data: { results: [] } });
  sessionStorage.clear();
  useOrganizationStore.setState({
    organizations: [],
    currentOrganizationId: null,
    persistedOrganizationId: null,
    status: "idle",
    error: null,
  });
});

describe("the organization requests are scoped to", () => {
  test("is the persisted id until the list resolves", () => {
    useOrganizationStore.setState({ persistedOrganizationId: ORG_A.id });
    expect(getActiveOrganizationIdForRequests()).toBe(ORG_A.id);
    expect(useOrganizationStore.getState().currentOrganizationId).toBeNull();
  });

  test("is the resolved id once the list lands", async () => {
    useOrganizationStore.setState({ persistedOrganizationId: ORG_A.id });
    listOrganizations = () =>
      Promise.resolve({ data: { results: [ORG_B, ORG_A] } });

    await useOrganizationStore.getState().fetchOrganizations();

    expect(getActiveOrganizationIdForRequests()).toBe(ORG_A.id);
    expect(useOrganizationStore.getState().persistedOrganizationId).toBe(
      ORG_A.id,
    );
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(ORG_A.id);
  });

  test("survives a failed org-list fetch", async () => {
    useOrganizationStore.setState({ persistedOrganizationId: ORG_A.id });
    sessionStorage.setItem(STORAGE_KEY, ORG_A.id);
    listOrganizations = () => Promise.reject(new Error("network down"));

    await useOrganizationStore.getState().fetchOrganizations();

    expect(useOrganizationStore.getState().status).toBe("error");
    expect(getActiveOrganizationIdForRequests()).toBe(ORG_A.id);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(ORG_A.id);
  });

  test("follows an explicit switch into both the store and sessionStorage", () => {
    useOrganizationStore.setState({
      organizations: [ORG_A, ORG_B],
      currentOrganizationId: ORG_A.id,
      persistedOrganizationId: ORG_A.id,
      status: "ready",
    });

    useOrganizationStore.getState().setCurrentOrganizationId(ORG_B.id);

    expect(getActiveOrganizationIdForRequests()).toBe(ORG_B.id);
    expect(useOrganizationStore.getState().persistedOrganizationId).toBe(
      ORG_B.id,
    );
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(ORG_B.id);
  });

  test("is gone from both once the organization is cleared", () => {
    useOrganizationStore.setState({ persistedOrganizationId: ORG_A.id });
    sessionStorage.setItem(STORAGE_KEY, ORG_A.id);

    useOrganizationStore.getState().clearOrganization();

    expect(getActiveOrganizationIdForRequests()).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
