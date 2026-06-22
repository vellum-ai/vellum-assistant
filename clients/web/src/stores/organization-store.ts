/**
 * Zustand organization store.
 *
 * Owns the organization list and the active-organization selection.
 * Fetches the list via the generated SDK client (not React Query) so
 * middleware, loaders, and API interceptors can read state synchronously
 * via `useOrganizationStore.getState()` outside the React tree. The
 * active organization is persisted to sessionStorage so page refreshes
 * and new tabs preserve the selection.
 *
 * Lifecycle (auth subscription + focus/visibility refetch) is registered
 * via `setupOrganizationStore()`, called once at app startup.
 *
 * References:
 * - https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components
 * - https://tkdodo.eu/blog/working-with-zustand
 */
import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { organizationsList } from "@/generated/api/sdk.gen";
import type { OrganizationRead } from "@/generated/api/types.gen";
import { subscribe } from "@/lib/event-bus";
import { useAuthStore } from "@/stores/auth-store";
import { hasLivePlatformSession } from "@/stores/session-status";

const ACTIVE_ORGANIZATION_STORAGE_KEY = "vellum_active_organization_id";

type OrganizationStatus = "idle" | "loading" | "ready" | "error";

interface OrganizationState {
  organizations: OrganizationRead[];
  currentOrganizationId: string | null;
  status: OrganizationStatus;
  error: string | null;
}

interface OrganizationActions {
  fetchOrganizations: () => Promise<void>;
  setCurrentOrganizationId: (organizationId: string) => void;
  clearOrganization: () => void;
}

type OrganizationStore = OrganizationState & OrganizationActions;

function getSessionStorage(): Storage | null {
  if (typeof globalThis.sessionStorage === "undefined") {
    return null;
  }
  return globalThis.sessionStorage;
}

function getStoredOrganizationId(): string | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    return storage.getItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setStoredOrganizationId(organizationId: string): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, organizationId);
  } catch {
    // ignore storage failures
  }
}

function clearStoredOrganizationId(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

function resolveActiveOrganizationId(
  organizations: readonly OrganizationRead[],
  candidateId: string | null,
): string | null {
  if (organizations.length === 0) return null;
  if (candidateId && organizations.some((org) => org.id === candidateId)) {
    return candidateId;
  }
  return organizations[0]!.id;
}

const useOrganizationStoreBase = create<OrganizationStore>()((set, get) => ({
  organizations: [],
  currentOrganizationId: null,
  status: "idle",
  error: null,

  fetchOrganizations: async () => {
    set({ status: "loading", error: null });

    try {
      const result = await organizationsList();
      const organizations = result.data?.results ?? [];
      const candidateId =
        get().currentOrganizationId ?? getStoredOrganizationId();
      const currentOrganizationId = resolveActiveOrganizationId(
        organizations,
        candidateId,
      );

      if (currentOrganizationId) {
        setStoredOrganizationId(currentOrganizationId);
      }

      set({
        organizations,
        currentOrganizationId,
        status: currentOrganizationId ? "ready" : "error",
        error: currentOrganizationId
          ? null
          : "No organization available for this user.",
      });
    } catch (err) {
      const message =
        err instanceof Error && err.message
          ? err.message
          : "Failed to load organizations.";
      set({ status: "error", error: message });
    }
  },

  setCurrentOrganizationId: (organizationId: string) => {
    const { organizations } = get();
    if (!organizations.some((org) => org.id === organizationId)) return;

    setStoredOrganizationId(organizationId);
    set({ currentOrganizationId: organizationId, status: "ready" });
  },

  clearOrganization: () => {
    clearStoredOrganizationId();
    set({
      organizations: [],
      currentOrganizationId: null,
      status: "idle",
      error: null,
    });
  },
}));

export const useOrganizationStore = createSelectors(useOrganizationStoreBase);

/**
 * Read the active organization ID for non-React contexts (API interceptors).
 * Prefer `useOrganizationStore.use.currentOrganizationId()` in components.
 */
export function getActiveOrganizationIdForRequests(): string | null {
  return (
    useOrganizationStore.getState().currentOrganizationId ??
    getStoredOrganizationId()
  );
}

/**
 * Clear organization state. Called by the auth store on logout or user change.
 */
export function clearOrganization(): void {
  useOrganizationStore.getState().clearOrganization();
}

/**
 * Register all organization store lifecycle listeners. Call once at startup.
 *
 * 1. Auth subscription — fetches orgs when the user logs in or switches
 *    accounts (including cross-tab via BroadcastChannel).
 * 2. App resume — refetches the org list when the user returns to the
 *    tab (visibility / native foreground / online), but only if data is
 *    older than STALE_TIME_MS so rapid resume signals on fresh data
 *    don't trigger redundant fetches. Delivered via the layout-scoped
 *    event bus, which covers the visibility + focus + online surface
 *    behind a single channel.
 */
export function setupOrganizationStore(): () => void {
  const STALE_TIME_MS = 10_000;
  let lastFetchedAt = 0;

  // Track when fetches complete so we can enforce staleTime on resume refetch.
  const unsubStale = useOrganizationStore.subscribe((state) => {
    if (state.status === "ready" || state.status === "error") {
      lastFetchedAt = Date.now();
    }
  });

  // 1. Auth transitions — platform session triggers org fetch. Orgs are a
  //    platform concept; skip the fetch when there's no platform session
  //    (e.g. self-hosted/local mode with gateway-only auth).
  const unsubAuth = useAuthStore.subscribe((state, prevState) => {
    const hasSession = hasLivePlatformSession(state.platformSession);
    const hadSession = hasLivePlatformSession(prevState.platformSession);
    if (
      hasSession &&
      (!hadSession || state.user?.id !== prevState.user?.id)
    ) {
      useOrganizationStore.getState().fetchOrganizations();
    }
  });

  // 2. App resume — refetch if stale and platform session is active.
  const refetchIfStale = () => {
    if (!hasLivePlatformSession(useAuthStore.getState().platformSession)) return;
    const { status } = useOrganizationStore.getState();
    if (
      (status === "ready" || status === "error") &&
      Date.now() - lastFetchedAt > STALE_TIME_MS
    ) {
      useOrganizationStore.getState().fetchOrganizations();
    }
  };

  const unsubResume = subscribe("app.resume", () => {
    refetchIfStale();
  });

  return () => {
    unsubStale();
    unsubAuth();
    unsubResume();
  };
}
