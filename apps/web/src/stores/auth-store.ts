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

import { createSelectors } from "@/utils/create-selectors";

import {
  getSession,
  logout as allauthLogout,
} from "@/lib/auth/allauth-client";
import {
  isGatewayAuthEnabled,
  isGatewayAuthMode,
  ensureGatewayToken,
  getGatewayToken,
  clearGatewayToken,
  getLocalTokenUrl,
} from "@/lib/auth/gateway-session";
import {
  isLocalMode,
  getPlatformAssistants,
  getLocalGatewayUrl,
  clearSelectedAssistant,
} from "@/lib/local-mode";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { deleteBiometricToken } from "@/runtime/native-biometric";
import { syncOnboardingUser, clearOnboardingFlags } from "@/lib/onboarding-cleanup";
import { clearOrganization } from "@/stores/organization-store";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import { useEventBusStore } from "@/stores/event-bus-store";
import { isNativePlatform, installSessionCookies, waitForNativeSessionCookie } from "@/runtime/native-auth";
import { isBiometricEnabled, retrieveBiometricToken } from "@/runtime/native-biometric";

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
  hasPlatformSession: boolean;
}

interface AuthActions {
  initSession: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  logout: () => Promise<void>;
}

type AuthStore = AuthState & AuthActions;

let previousUserId: string | null = null;
let broadcastChannel: BroadcastChannel | null = null;

const GATEWAY_LOCAL_USER: AuthUser = {
  id: "gateway-local",
  username: "local",
  email: null,
  isStaff: false,
  firstName: "Local",
  lastName: "User",
};

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
  hasPlatformSession: false,

  initSession: async () => {
    if (isGatewayAuthEnabled()) {
      try {
        await ensureGatewayToken(getLocalTokenUrl());
        const localGateway = getLocalGatewayUrl();
        if (localGateway) {
          setSelfHostedConnection({
            url: `${window.location.origin}${localGateway}`,
            token: getGatewayToken(),
          });
        }
        set({ isLoggedIn: true, isLoading: false, user: GATEWAY_LOCAL_USER });
      } catch {
        set({ isLoggedIn: false, isLoading: false, user: null });
      }
      if (!isLocalMode() || getPlatformAssistants().length > 0) {
        getSession()
          .then((result) => {
            if (result.ok && result.data.user) {
              set({ hasPlatformSession: true });
            }
          })
          .catch(() => {});
      }
      return;
    }

    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncUserScopedState(user?.id ?? null);
        set({ isLoggedIn: true, isLoading: false, user, hasPlatformSession: true });
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
            set({ isLoggedIn: true, isLoading: false, user, hasPlatformSession: true });
            return;
          }
        }
      } catch (err) {
        console.warn("auth.initSession biometric recovery failed", err);
      }
    }

    syncUserScopedState(null);
    set({ isLoggedIn: false, isLoading: false, user: null });
  },

  refreshSession: async () => {
    if (isGatewayAuthMode()) {
      try {
        await ensureGatewayToken(getLocalTokenUrl());
        set({ isLoggedIn: true });
      } catch {
        set({ isLoggedIn: false, user: null, hasPlatformSession: false });
        return false;
      }
      if (!isLocalMode() || getPlatformAssistants().length > 0) {
        getSession()
          .then((result) => {
            set({ hasPlatformSession: !!(result.ok && result.data.user) });
          })
          .catch(() => set({ hasPlatformSession: false }));
      }
      return true;
    }

    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncUserScopedState(user?.id ?? null);
        set({ isLoggedIn: true, user, hasPlatformSession: true });
        return true;
      }
    } catch (err) {
      console.warn("auth.refreshSession failed", err);
    }
    syncUserScopedState(null);
    set({ isLoggedIn: false, user: null, hasPlatformSession: false });
    return false;
  },

  logout: async () => {
    if (isGatewayAuthMode()) {
      clearSelectedAssistant();
      clearGatewayToken();
      clearOnboardingFlags();
      clearOrganization();
      clearUserScopedStorage();
      set({ isLoggedIn: false, user: null, hasPlatformSession: false });
      broadcastAuthChange();
      return;
    }

    try {
      await allauthLogout();
    } finally {
      void deleteBiometricToken();
      clearOnboardingFlags();
      clearOrganization();
      clearUserScopedStorage();
      set({ isLoggedIn: false, user: null, hasPlatformSession: false });
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
    broadcastChannel.onmessage = () => {
      clearUserScopedStorage();
      window.location.reload();
    };
    cleanups.push(() => {
      broadcastChannel?.close();
      broadcastChannel = null;
    });
  }

  return () => cleanups.forEach((fn) => fn());
}
