/**
 * Zustand auth store.
 *
 * Session lifecycle: probes the allauth session on `initSession()`,
 * re-validates when the app resumes (foreground / visibility / online,
 * delivered via the layout-scoped event bus), and synchronizes logout
 * across tabs via BroadcastChannel. Middleware, loaders, and API
 * interceptors read state synchronously via `useAuthStore.getState()`.
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
import { probeGatewayAuthState } from "@/lib/auth/gateway-session.js";
import { useClientFeatureFlagStore } from "@/lib/feature-flags/client-feature-flag-store.js";
import { deleteBiometricToken } from "@/runtime/native-biometric.js";
import { syncOnboardingUser } from "@/domains/onboarding/prefs.js";
import { clearOrganization } from "@/stores/organization-store.js";
import { useEventBusStore } from "@/stores/event-bus-store.js";
import { isNativePlatform, installSessionCookies, waitForNativeSessionCookie } from "@/runtime/native-auth.js";
import { isBiometricEnabled, retrieveBiometricToken } from "@/runtime/native-biometric.js";

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

function syncUserScopedState(nextUserId: string | null): void {
  syncOnboardingUser(nextUserId);
  syncOrganizationState(nextUserId);
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
        syncUserScopedState(user?.id ?? null);
        set({ isLoggedIn: true, isLoading: false, user });
        return;
      }
    } catch (err) {
      console.error("auth.initSession failed", err);
    }

    // Biometric recovery: on iOS, the session cookie may have been lost
    // when WKWebView was killed. Try to restore from Keychain via Face ID.
    if (isNativePlatform() && isBiometricEnabled()) {
      try {
        const token = await retrieveBiometricToken();
        if (token) {
          installSessionCookies(token);
          await waitForNativeSessionCookie();
          const retryResult = await getSession();
          if (retryResult.ok && retryResult.data.user) {
            const user = toAuthUser(retryResult.data.user);
            syncUserScopedState(user?.id ?? null);
            set({ isLoggedIn: true, isLoading: false, user });
            return;
          }
        }
      } catch (err) {
        console.warn("auth.initSession biometric recovery failed", err);
      }
    }

    syncUserScopedState(null);
    set({ isLoggedIn: false, isLoading: false, user: null });

    if (useClientFeatureFlagStore.getState().gatewayWebAuth) {
      probeGatewayAuthState()
        .then((s) => console.debug("[gateway-auth] state:", s))
        .catch((e: unknown) =>
          console.debug("[gateway-auth] probe failed:", e),
        );
    }
  },

  refreshSession: async () => {
    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncUserScopedState(user?.id ?? null);
        set({ isLoggedIn: true, user });
        return true;
      }
    } catch (err) {
      console.warn("auth.refreshSession failed", err);
    }
    syncUserScopedState(null);
    set({ isLoggedIn: false, user: null });
    return false;
  },

  logout: async () => {
    try {
      await allauthLogout();
    } finally {
      void deleteBiometricToken();
      syncUserScopedState(null);
      set({ isLoggedIn: false, user: null });
      broadcastAuthChange();
    }
  },
}));

export const useAuthStore = createSelectors(useAuthStoreBase);

/**
 * Subscribe to app-resume signals on the layout-scoped event bus and to
 * cross-tab BroadcastChannel messages. Call once at app startup.
 *
 * The bus's `"app.resume"` payload fans in page visibility flipping to
 * "visible", a Capacitor `appStateChange` going active on native, and
 * `window.online`, so a single subscription drives the session refresh.
 */
export function setupAuthListeners(): () => void {
  const { refreshSession } = useAuthStore.getState();
  const cleanups: Array<() => void> = [];

  const safeRefresh = () =>
    refreshSession().catch((err: unknown) =>
      console.warn("auth.refreshSession failed", err),
    );

  const unsubResume = useEventBusStore
    .getState()
    .subscribe("app.resume", () => {
      void safeRefresh();
    });
  cleanups.push(unsubResume);

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
