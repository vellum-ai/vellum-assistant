/**
 * The request-scoped QueryClient is keyed on the organization requests carry,
 * so a response fetched for one organization is never read as the answer for
 * another — and is not thrown away while that organization still holds.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";

import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import {
  getLifecycleDiagnosticsEvents,
  removeLifecycleDiagnostics,
} from "@/lib/diagnostics";
import { ApiError } from "@/utils/api-errors";

// The quick-add controller runs a daemon query and pulls in the settings
// domain's profile editor; neither participates in cache scoping.
mock.module("@/components/profile-quick-add-provider", () => ({
  ProfileQuickAddProvider: ({ children }: { children: ReactNode }) => children,
}));

const { AppProviders } = await import("@/components/providers");
const { useAuthStore } = await import("@/stores/auth-store");
const { useOrganizationStore } = await import("@/stores/organization-store");

const ORGANIZATION_ID = "org-abc";
const STORAGE_KEY = "vellum_active_organization_id";
const PROBE_KEY = ["org-scoped-probe"];
const ASSET_FAILURE_OPTIONS = {
  queryKey: appsGetQueryKey({
    path: { assistant_id: "assistant-123" },
    query: { conversationId: "conv-123" },
  }),
  queryFn: async () => {
    throw new ApiError(405, "No list");
  },
  retry: false as const,
};

function assetEvents() {
  return getLifecycleDiagnosticsEvents().filter((event) =>
    event.kind.startsWith("asset_query_"),
  );
}

let observedClient: QueryClient | null = null;

function Probe() {
  const queryClient = useQueryClient();
  useEffect(() => {
    observedClient = queryClient;
  });
  return null;
}

/**
 * The persisted organization selection: sessionStorage is where it survives a
 * reload, and the store mirrors it so consumers can subscribe to it.
 */
function seedPersistedOrganization(organizationId: string) {
  sessionStorage.setItem(STORAGE_KEY, organizationId);
  useOrganizationStore.setState({ persistedOrganizationId: organizationId });
}

function renderProviders() {
  render(
    <AppProviders>
      <Probe />
    </AppProviders>,
  );
}

beforeEach(() => {
  observedClient = null;
  sessionStorage.clear();
  removeLifecycleDiagnostics("asset_query_");
  useAuthStore.setState({
    sessionStatus: "authenticated",
    user: {
      kind: "platform",
      id: "user-123",
      username: null,
      email: null,
      isStaff: false,
      firstName: "",
      lastName: "",
    },
  });
  useOrganizationStore.setState({
    organizations: [],
    currentOrganizationId: null,
    persistedOrganizationId: null,
    status: "idle",
    error: null,
  });
});

afterEach(() => {
  cleanup();
});

describe("AppProviders cache scope", () => {
  test("preserves asset diagnostics while a reload restores the same user", async () => {
    seedPersistedOrganization(ORGANIZATION_ID);
    renderProviders();
    await expect(
      observedClient!.fetchQuery(ASSET_FAILURE_OPTIONS),
    ).rejects.toThrow();
    const previousEvents = assetEvents();
    const previousUser = useAuthStore.getState().user;
    cleanup();

    useAuthStore.setState({ sessionStatus: "initializing", user: null });
    renderProviders();
    expect(assetEvents()).toEqual(previousEvents);
    await expect(
      observedClient!.fetchQuery(ASSET_FAILURE_OPTIONS),
    ).rejects.toThrow();
    expect(assetEvents()).toEqual(previousEvents);

    act(() => {
      useAuthStore.setState({
        sessionStatus: "authenticated",
        user: previousUser,
      });
    });
    expect(assetEvents()).toEqual(previousEvents);
    await expect(
      observedClient!.fetchQuery(ASSET_FAILURE_OPTIONS),
    ).rejects.toThrow();
    expect(assetEvents()).toHaveLength(2);
  });

  test.each(["another user", "no session"] as const)(
    "clears saved asset diagnostics when a reload settles with %s",
    async (outcome) => {
      seedPersistedOrganization(ORGANIZATION_ID);
      renderProviders();
      await expect(
        observedClient!.fetchQuery(ASSET_FAILURE_OPTIONS),
      ).rejects.toThrow();
      const previousEvents = assetEvents();
      const previousUser = useAuthStore.getState().user!;
      cleanup();

      useAuthStore.setState({ sessionStatus: "initializing", user: null });
      renderProviders();
      expect(assetEvents()).toEqual(previousEvents);

      act(() => {
        useAuthStore.setState(
          outcome === "another user"
            ? {
                sessionStatus: "authenticated",
                user: { ...previousUser, id: "user-456" },
              }
            : { sessionStatus: "unauthenticated", user: null },
        );
      });
      expect(assetEvents()).toHaveLength(0);
    },
  );

  test("removes asset failure diagnostics when the request identity changes", async () => {
    seedPersistedOrganization(ORGANIZATION_ID);
    renderProviders();
    const previousClient = observedClient!;
    await expect(
      previousClient.fetchQuery(ASSET_FAILURE_OPTIONS),
    ).rejects.toThrow();
    expect(
      getLifecycleDiagnosticsEvents().filter(
        (event) => event.kind === "asset_query_failed",
      ),
    ).toHaveLength(1);
    act(() => {
      useOrganizationStore.setState({
        currentOrganizationId: "org-xyz",
        persistedOrganizationId: "org-xyz",
        status: "ready",
      });
    });
    expect(assetEvents()).toHaveLength(0);
    await expect(
      previousClient.fetchQuery(ASSET_FAILURE_OPTIONS),
    ).rejects.toThrow();
    expect(assetEvents()).toHaveLength(0);
  });

  test("drops a persisted org's responses when that org is revoked", () => {
    // The id slice is null throughout: the persisted id is what the request
    // header carries, so this response belongs to that organization.
    seedPersistedOrganization(ORGANIZATION_ID);
    renderProviders();
    act(() => {
      observedClient!.setQueryData(PROBE_KEY, "answer-for-org-abc");
    });

    act(() => {
      useOrganizationStore.getState().clearOrganization();
    });

    expect(observedClient!.getQueryData<string>(PROBE_KEY)).toBeUndefined();
  });

  test("keeps them when the org list confirms the persisted org", () => {
    seedPersistedOrganization(ORGANIZATION_ID);
    renderProviders();
    act(() => {
      observedClient!.setQueryData(PROBE_KEY, "answer-for-org-abc");
    });

    act(() => {
      useOrganizationStore.setState({
        organizations: [],
        currentOrganizationId: ORGANIZATION_ID,
        status: "ready",
      });
    });

    expect(observedClient!.getQueryData<string>(PROBE_KEY)).toBe(
      "answer-for-org-abc",
    );
  });

  test("drops them when the org list resolves a different org", () => {
    seedPersistedOrganization(ORGANIZATION_ID);
    renderProviders();
    act(() => {
      observedClient!.setQueryData(PROBE_KEY, "answer-for-org-abc");
    });

    act(() => {
      useOrganizationStore.setState({
        currentOrganizationId: "org-xyz",
        persistedOrganizationId: "org-xyz",
        status: "ready",
      });
    });

    expect(observedClient!.getQueryData<string>(PROBE_KEY)).toBeUndefined();
  });
});
