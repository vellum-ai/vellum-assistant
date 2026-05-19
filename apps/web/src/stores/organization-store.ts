/**
 * Zustand organization store.
 *
 * Replaces the React Context-based OrganizationProvider with a store
 * readable from anywhere — middleware, loaders, API interceptors — via
 * `useOrganizationStore.getState()`.
 *
 * Fetches the organization list via the generated SDK client (not React
 * Query) so the store is self-contained and usable outside the React tree.
 * Persists the active organization to sessionStorage so page refreshes
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

import { createSelectors } from "@/utils/create-selectors.js";
import { organizationsList } from "@/generated/api/sdk.gen.js";
import type { OrganizationRead } from "@/generated/api/types.gen.js";
import { useAuthStore } from "@/stores/auth-store.js";

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
 * 2. Window focus / visibility — refetches the org list when the tab
 *    regains focus, but only if data is stale (older than STALE_TIME_MS).
 *    Matches the old React Query `refetchOnWindowFocus` + `staleTime`
 *    behavior from `createQueryClient({ staleTime: 10_000 })`.
 */
export function setupOrganizationStore(): () => void {
  const STALE_TIME_MS = 10_000;
  let lastFetchedAt = 0;

  // Track when fetches complete so we can enforce staleTime on focus refetch.
  const unsubStale = useOrganizationStore.subscribe((state) => {
    if (state.status === "ready" || state.status === "error") {
      lastFetchedAt = Date.now();
    }
  });

  // 1. Auth transitions — login or user switch triggers org fetch.
  const unsubAuth = useAuthStore.subscribe((state, prevState) => {
    if (
      state.isLoggedIn &&
      (!prevState.isLoggedIn || state.user?.id !== prevState.user?.id)
    ) {
      useOrganizationStore.getState().fetchOrganizations();
    }
  });

  // 2. Window focus / visibility — refetch if stale.
  const refetchIfStale = () => {
    const { status } = useOrganizationStore.getState();
    if (
      (status === "ready" || status === "error") &&
      Date.now() - lastFetchedAt > STALE_TIME_MS
    ) {
      useOrganizationStore.getState().fetchOrganizations();
    }
  };

  const onFocus = () => refetchIfStale();
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") refetchIfStale();
  };

  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    unsubStale();
    unsubAuth();
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
