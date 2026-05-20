/**
 * Zustand auth store.
 *
 * Replaces the React Context-based AuthProvider with a store that can be
 * read from anywhere — middleware, loaders, API interceptors — via
 * `useAuthStore.getState()`.
 *
 * Session lifecycle: probes the allauth session on `initSession()`,
 * re-validates on window focus / visibility change, and synchronizes
 * logout across tabs via BroadcastChannel.
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
import { clearOrganization } from "@/stores/organization-store.js";

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
