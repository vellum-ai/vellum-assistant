/**
 * Zustand auth store.
 *
 * Session lifecycle: probes the allauth session on `initSession()`,
 * re-validates on window focus / visibility change, and synchronizes
 * logout across tabs via BroadcastChannel. Middleware, loaders, and
 * API interceptors read state synchronously via
 * `useAuthStore.getState()`.
 *
 * References:
 * - https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components
 * - https://docs.allauth.org/en/latest/headless/openapi-specification/
 */
import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors.js";

import {
  getSession,
  logout as allauthLogout,
} from "@/lib/auth/allauth-client.js";
import { isLocalMode } from "@/lib/auth/mode.js";
import { clearOrganization } from "@/stores/organization-store.js";

/**
 * Synthetic user for local mode. The SPA never queries identity in
 * local mode (no IdP, no allauth), but the rest of the app reads
 * `useAuthStore().user` to decide what to render — so we provide a
 * stable placeholder identity. Anything that needs a real user id
 * (telemetry, multi-tenant features) should branch on `isLocalMode()`
 * rather than reading the synthetic id.
 */
const LOCAL_MODE_USER: AuthUser = {
  id: "local",
  username: "local",
  email: null,
  isStaff: false,
  firstName: "",
  lastName: "",
};

export interface AuthUser {
  id: string | null;
  username: string | null;
  email: string | null;
  isStaff: boolean;
  firstName: string;
  lastName: string;
}

interface RawSessionUser {
  id?: string;
  username?: string;
  email?: string;
  is_staff?: boolean;
  first_name?: string;
  last_name?: string;
}

function resolveUserId(user: RawSessionUser | null): string | null {
  return user?.id ?? user?.email ?? user?.username ?? null;
}

function toAuthUser(raw: RawSessionUser | null): AuthUser | null {
  if (!raw) return null;
  return {
    id: resolveUserId(raw),
    username: raw.username ?? null,
    email: raw.email ?? null,
    isStaff: raw.is_staff ?? false,
    firstName: raw.first_name ?? "",
    lastName: raw.last_name ?? "",
  };
}

interface AuthState {
  isLoggedIn: boolean;
  isLoading: boolean;
  user: AuthUser | null;
}

interface AuthActions {
  initSession: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  logout: () => Promise<void>;
}

type AuthStore = AuthState & AuthActions;

let previousUserId: string | null = null;
let broadcastChannel: BroadcastChannel | null = null;

function syncOrganizationState(nextUserId: string | null): void {
  if (!nextUserId || (previousUserId && previousUserId !== nextUserId)) {
    clearOrganization();
  }
  previousUserId = nextUserId;
}

function broadcastAuthChange(): void {
  broadcastChannel?.postMessage("auth-changed");
}

const useAuthStoreBase = create<AuthStore>()((set) => ({
  isLoggedIn: false,
  isLoading: true,
  user: null,

  initSession: async () => {
    if (isLocalMode()) {
      // No allauth backend in local mode. Boot straight into an
      // "always signed in as local owner" state and skip the probe.
      syncOrganizationState(LOCAL_MODE_USER.id);
      set({ isLoggedIn: true, isLoading: false, user: LOCAL_MODE_USER });
      return;
    }
    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncOrganizationState(user?.id ?? null);
        set({ isLoggedIn: true, isLoading: false, user });
        return;
      }
    } catch (err) {
      console.error("auth.initSession failed", err);
    }
    syncOrganizationState(null);
    set({ isLoggedIn: false, isLoading: false, user: null });
  },

  refreshSession: async () => {
    if (isLocalMode()) {
      // Local mode has no remote session to refresh against.
      return true;
    }
    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncOrganizationState(user?.id ?? null);
        set({ isLoggedIn: true, user });
        return true;
      }
    } catch (err) {
      console.warn("auth.refreshSession failed", err);
    }
    syncOrganizationState(null);
    set({ isLoggedIn: false, user: null });
    return false;
  },

  logout: async () => {
    if (isLocalMode()) {
      // No remote session to terminate; ignore. (Surfaces in UI as a
      // no-op; the logout button is hidden in local mode at the view
      // layer.)
      return;
    }
    try {
      await allauthLogout();
    } finally {
      syncOrganizationState(null);
      set({ isLoggedIn: false, user: null });
      broadcastAuthChange();
    }
  },
}));

export const useAuthStore = createSelectors(useAuthStoreBase);

/**
 * Subscribe to window focus / visibility changes and cross-tab
 * BroadcastChannel messages. Call once at app startup.
 */
export function setupAuthListeners(): () => void {
  const { refreshSession } = useAuthStore.getState();
  const cleanups: Array<() => void> = [];

  const safeRefresh = () =>
    refreshSession().catch((err: unknown) =>
      console.warn("auth.refreshSession failed", err),
    );

  const onFocus = () => safeRefresh();
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") safeRefresh();
  };

  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
  cleanups.push(() => {
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  if (typeof BroadcastChannel !== "undefined") {
    broadcastChannel = new BroadcastChannel("auth");
    broadcastChannel.onmessage = () => safeRefresh();
    cleanups.push(() => {
      broadcastChannel?.close();
      broadcastChannel = null;
    });
  }

  return () => cleanups.forEach((fn) => fn());
}
