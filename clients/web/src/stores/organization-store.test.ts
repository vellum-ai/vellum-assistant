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

describe("fetch outcome classification", () => {
  test("a superseded failed fetch settles status but keeps the org fallback", async () => {
    sessionStorage.setItem(STORAGE_KEY, ORG_A.id);
    useOrganizationStore.setState({
      persistedOrganizationId: ORG_A.id,
      status: "ready",
    });
    listOrganizations = () =>
      Promise.resolve({
        data: undefined,
        error: { detail: "Authentication credentials were not provided." },
        response: new Response(null, { status: 403 }),
      });

    const outcome = await useOrganizationStore
      .getState()
      .fetchOrganizations(() => false);

    // The stale probe's rejection is reported to its caller and the store
    // reaches a terminal status (never wedged at "loading"), but the newer
    // session's org fallback stays untouched.
    expect(outcome).toEqual({ ok: false, kind: "rejected", status: 403 });
    expect(useOrganizationStore.getState().persistedOrganizationId).toBe(
      ORG_A.id,
    );
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(ORG_A.id);
    expect(useOrganizationStore.getState().status).toBe("error");
    expect(useOrganizationStore.getState().error).toBe(
      "Platform session was rejected (HTTP 403).",
    );
  });

  test("a superseded successful fetch settles status without committing the stale account's org", async () => {
    sessionStorage.setItem(STORAGE_KEY, ORG_B.id);
    useOrganizationStore.setState({
      persistedOrganizationId: ORG_B.id,
      status: "ready",
    });
    listOrganizations = () => Promise.resolve({ data: { results: [ORG_A] } });

    const outcome = await useOrganizationStore
      .getState()
      .fetchOrganizations(() => false);

    // The stale fetch resolved an older session's org; committing it would
    // stamp requests with the wrong Vellum-Organization-Id.
    expect(outcome).toEqual({ ok: true });
    const state = useOrganizationStore.getState();
    expect(state.currentOrganizationId).toBeNull();
    expect(state.persistedOrganizationId).toBe(ORG_B.id);
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(ORG_B.id);
    expect(state.status).toBe("error");
  });

  test("a timed-out fetch from the still-active session commits a late success", async () => {
    listOrganizations = () => Promise.resolve({ data: { results: [ORG_A] } });

    // The probe's race timeout lapsed (isCurrent false) but no newer
    // probe/session superseded the fetch (isSameSession true): the resolved
    // org belongs to the active session, so discarding it would strand
    // org-header readiness until the next resume.
    const outcome = await useOrganizationStore
      .getState()
      .fetchOrganizations(
        () => false,
        () => true,
      );

    expect(outcome).toEqual({ ok: true });
    const state = useOrganizationStore.getState();
    expect(state.currentOrganizationId).toBe(ORG_A.id);
    expect(state.status).toBe("ready");
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(ORG_A.id);
  });

  test("a timed-out rejection stays non-destructive even for the active session", async () => {
    sessionStorage.setItem(STORAGE_KEY, ORG_A.id);
    useOrganizationStore.setState({ persistedOrganizationId: ORG_A.id });
    listOrganizations = () =>
      Promise.resolve({
        data: undefined,
        error: { detail: "Authentication credentials were not provided." },
        response: new Response(null, { status: 403 }),
      });

    const outcome = await useOrganizationStore
      .getState()
      .fetchOrganizations(
        () => false,
        () => true,
      );

    // Destructive writes ride only with a fully current sync: the probe
    // already settled "present" past its timeout, so the late rejection must
    // not strip the org header out from under that session.
    expect(outcome).toEqual({ ok: false, kind: "rejected", status: 403 });
    expect(useOrganizationStore.getState().persistedOrganizationId).toBe(
      ORG_A.id,
    );
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(ORG_A.id);
    expect(useOrganizationStore.getState().status).toBe("error");
  });

  test("a superseded thrown fetch still settles status", async () => {
    useOrganizationStore.setState({ status: "ready" });
    listOrganizations = () => Promise.reject(new Error("network down"));

    const outcome = await useOrganizationStore
      .getState()
      .fetchOrganizations(() => false);

    expect(outcome).toEqual({ ok: false, kind: "unavailable" });
    expect(useOrganizationStore.getState().status).toBe("error");
    expect(useOrganizationStore.getState().error).toBe("network down");
  });

  test("a current predicate commits normally", async () => {
    sessionStorage.setItem(STORAGE_KEY, ORG_A.id);
    useOrganizationStore.setState({ persistedOrganizationId: ORG_A.id });
    listOrganizations = () =>
      Promise.resolve({
        data: undefined,
        error: { detail: "Authentication credentials were not provided." },
        response: new Response(null, { status: 403 }),
      });

    const outcome = await useOrganizationStore
      .getState()
      .fetchOrganizations(() => true);

    expect(outcome).toEqual({ ok: false, kind: "rejected", status: 403 });
    expect(useOrganizationStore.getState().persistedOrganizationId).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  test("a settled 403 concludes as a rejected session", async () => {
    listOrganizations = () =>
      Promise.resolve({
        data: undefined,
        error: { detail: "Authentication credentials were not provided." },
        response: new Response(null, { status: 403 }),
      });

    const outcome = await useOrganizationStore.getState().fetchOrganizations();

    expect(outcome).toEqual({ ok: false, kind: "rejected", status: 403 });
    const state = useOrganizationStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toBe("Platform session was rejected (HTTP 403).");
  });

  test("a rejection clears the persisted org id so stale headers stop", async () => {
    sessionStorage.setItem(STORAGE_KEY, ORG_A.id);
    useOrganizationStore.setState({ persistedOrganizationId: ORG_A.id });
    listOrganizations = () =>
      Promise.resolve({
        data: undefined,
        error: { detail: "Authentication credentials were not provided." },
        response: new Response(null, { status: 403 }),
      });

    await useOrganizationStore.getState().fetchOrganizations();

    expect(useOrganizationStore.getState().persistedOrganizationId).toBeNull();
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getActiveOrganizationIdForRequests()).toBeNull();
  });

  test("a thrown fetch concludes as unavailable with no HTTP status", async () => {
    listOrganizations = () => Promise.reject(new Error("network down"));

    const outcome = await useOrganizationStore.getState().fetchOrganizations();

    expect(outcome).toEqual({ ok: false, kind: "unavailable" });
    const state = useOrganizationStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toBe("network down");
  });

  test("a transport failure keeps the persisted org id for offline reloads", async () => {
    sessionStorage.setItem(STORAGE_KEY, ORG_A.id);
    useOrganizationStore.setState({ persistedOrganizationId: ORG_A.id });
    listOrganizations = () => Promise.reject(new Error("network down"));

    await useOrganizationStore.getState().fetchOrganizations();

    expect(useOrganizationStore.getState().persistedOrganizationId).toBe(
      ORG_A.id,
    );
    expect(sessionStorage.getItem(STORAGE_KEY)).toBe(ORG_A.id);
  });

  test("a 200 with no organizations concludes as unavailable", async () => {
    listOrganizations = () =>
      Promise.resolve({
        data: { results: [] },
        response: new Response(null, { status: 200 }),
      });

    const outcome = await useOrganizationStore.getState().fetchOrganizations();

    expect(outcome).toEqual({ ok: false, kind: "unavailable" });
    const state = useOrganizationStore.getState();
    expect(state.status).toBe("error");
    expect(state.error).toBe("No organization available for this user.");
  });

  test("a successful fetch resets the error state", async () => {
    useOrganizationStore.setState({
      status: "error",
      error: "Platform session was rejected (HTTP 403).",
    });
    listOrganizations = () =>
      Promise.resolve({ data: { results: [ORG_A] } });

    const outcome = await useOrganizationStore.getState().fetchOrganizations();

    expect(outcome).toEqual({ ok: true });
    const state = useOrganizationStore.getState();
    expect(state.status).toBe("ready");
    expect(state.error).toBeNull();
  });
});
