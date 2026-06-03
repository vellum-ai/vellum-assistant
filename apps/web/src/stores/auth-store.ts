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

import { lifecycleService } from "@/assistant/lifecycle-service";
import { createSelectors } from "@/utils/create-selectors";

import {
  getSession,
  logout as allauthLogout,
} from "@/lib/auth/allauth-client";
import {
  isGatewayAuthEnabled,
  isGatewayAuthMode,
  ensureGatewayToken,
  clearGatewayToken,
  getLocalTokenUrl,
} from "@/lib/auth/gateway-session";
import {
  isLocalMode,
  getPlatformAssistants,
  getLocalAssistants,
  clearSelectedAssistant,
  setSelectedAssistantId,
  primeLocalGatewayConnection,
  syncPlatformAssistantsToLockfile,
} from "@/lib/local-mode";
import { listAssistants } from "@/assistant/api";
import { deleteBiometricToken } from "@/runtime/native-biometric";
import { syncOnboardingUser, clearOnboardingFlags } from "@/utils/onboarding-cleanup";
import { clearOrganization } from "@/stores/organization-store";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import { subscribe } from "@/lib/event-bus";
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
  /**
   * Whether the platform-session probe has settled. The local gateway path
   * sets `isLoading: false` before probing `getSession()`, so `false` here
   * means "unknown", not "no session" — consumers that gate on a missing
   * session must wait for this to flip true before treating the absence as
   * confirmed.
   */
  platformSessionResolved: boolean;
}

interface AuthActions {
  initSession: () => Promise<void>;
  connectLocalAssistant: (assistantId: string) => Promise<void>;
  refreshSession: () => Promise<boolean>;
  logout: () => Promise<void>;
}

type AuthStore = AuthState & AuthActions;

let previousUserId: string | null = null;
let broadcastChannel: BroadcastChannel | null = null;
let suppressPlatformProbe = false;

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

// Monotonic id stamped on each platform-session probe. Probes can overlap
// (an app-resume refresh firing while the initial probe is still in flight),
// and a stale completion must not mutate session state — most importantly it
// must not flip `platformSessionResolved` back to `true` while a newer probe
// is still pending, which would resurface the very race this state guards.
// Only the latest probe's id matches `latestPlatformProbe`, so older probes
// no-op.
let latestPlatformProbe = 0;

/**
 * Run the fire-and-forget platform-session probe used by the local gateway
 * auth paths, which return control before the session is known.
 *
 * `platformSessionResolved` is reset to `false` up front and flipped back to
 * `true` only once the probe settles, so a *re-run* probe (app-resume refresh,
 * return from a provider callback) re-enters the "unknown" state instead of
 * leaving a stale `true` from the previous probe. Consumers that treat a
 * missing session as confirmed must wait for this flip; until then a cached
 * platform assistant stands in as a liveness signal.
 *
 * Overlapping probes are resolved latest-wins: each call captures a probe id
 * and only the newest probe is allowed to settle state, so a slower earlier
 * probe cannot retire the "unknown" window a later probe just opened.
 *
 * `setUserOnSuccess` adopts the probed user as the active user (the
 * no-platform-assistant local path, which starts as the placeholder local
 * user). `clearOnFailure` drives `hasPlatformSession` to `false` on a negative
 * result (the refresh path, which must retract a session that has ended);
 * init paths leave a prior optimistic value untouched.
 */
function probePlatformSession(
  set: (partial: Partial<AuthState>) => void,
  options: { setUserOnSuccess?: boolean; clearOnFailure?: boolean } = {},
): void {
  const probeId = ++latestPlatformProbe;
  const isStale = (): boolean => probeId !== latestPlatformProbe;
  set({ platformSessionResolved: false });
  getSession()
    .then((result) => {
      if (isStale()) return;
      if (result.ok && result.data.user) {
        const next: Partial<AuthState> = { hasPlatformSession: true };
        if (options.setUserOnSuccess) {
          next.user = toAuthUser(result.data.user);
        }
        set(next);
      } else if (options.clearOnFailure) {
        set({ hasPlatformSession: false });
      }
    })
    .catch(() => {
      if (isStale()) return;
      if (options.clearOnFailure) {
        set({ hasPlatformSession: false });
      }
    })
    .finally(() => {
      if (isStale()) return;
      set({ platformSessionResolved: true });
    });
}

const useAuthStoreBase = create<AuthStore>()((set) => ({
  isLoggedIn: false,
  isLoading: true,
  user: null,
  hasPlatformSession: false,
  platformSessionResolved: false,

  initSession: async () => {
    if (isGatewayAuthEnabled()) {
      try {
        await primeLocalGatewayConnection();
        set({ isLoggedIn: true, isLoading: false, user: GATEWAY_LOCAL_USER });
      } catch {
        set({ isLoggedIn: false, isLoading: false, user: null });
      }
      if (!isLocalMode() || getPlatformAssistants().length > 0) {
        probePlatformSession(set);
      } else {
        set({ platformSessionResolved: true });
      }
      return;
    }

    if (isLocalMode() && !isGatewayAuthEnabled()) {
      const hasPlatformAssistants = getPlatformAssistants().length > 0;
      if (hasPlatformAssistants) {
        // Platform assistants require a valid session — await the check
        // so the auth middleware can redirect to login if it fails.
        try {
          const result = await getSession();
          if (result.ok && result.data.user) {
            const user = toAuthUser(result.data.user);
            // Re-sync platform assistants to remove stale lockfile entries.
            try {
              const apiAssistants = await listAssistants();
              if (apiAssistants.ok) {
                await syncPlatformAssistantsToLockfile(apiAssistants.data);
                if (getPlatformAssistants().length === 0 && getLocalAssistants().length === 0) {
                  set({ isLoggedIn: true, isLoading: false, user, hasPlatformSession: true, platformSessionResolved: true });
                  return;
                }
              }
            } catch {
              // Sync failed — continue with cached data
            }
            set({ isLoggedIn: true, isLoading: false, user, hasPlatformSession: true, platformSessionResolved: true });
            return;
          }
        } catch {
          // Session check failed — fall through to unauthenticated
        }
        set({ isLoggedIn: false, isLoading: false, user: null, platformSessionResolved: true });
        return;
      }
      set({ isLoggedIn: true, isLoading: false, user: GATEWAY_LOCAL_USER });
      if (!suppressPlatformProbe) {
        probePlatformSession(set, { setUserOnSuccess: true });
      } else {
        set({ platformSessionResolved: true });
      }
      suppressPlatformProbe = false;
      return;
    }

    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncUserScopedState(user?.id ?? null);
        set({ isLoggedIn: true, isLoading: false, user, hasPlatformSession: true, platformSessionResolved: true });
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
            set({ isLoggedIn: true, isLoading: false, user, hasPlatformSession: true, platformSessionResolved: true });
            return;
          }
        }
      } catch (err) {
        console.warn("auth.initSession biometric recovery failed", err);
      }
    }

    syncUserScopedState(null);
    set({ isLoggedIn: false, isLoading: false, user: null, platformSessionResolved: true });
  },

  /**
   * Connect to a specific local assistant from an interactive surface (the
   * login picker / auto-connect). Selects the assistant, primes its gateway
   * connection, and marks the session logged in.
   *
   * Unlike {@link AuthActions.initSession}, which is the best-effort boot
   * probe and swallows failures, this rethrows so the caller can surface the
   * reason — including the typed `GuardianTokenError` from the host seam — and
   * offer recovery instead of dead-ending. Both paths share
   * `primeLocalGatewayConnection`, so the guardian-token and gateway exchange
   * happen exactly once per connect.
   */
  connectLocalAssistant: async (assistantId: string) => {
    setSelectedAssistantId(assistantId);
    await primeLocalGatewayConnection();
    set({ isLoggedIn: true, isLoading: false, user: GATEWAY_LOCAL_USER });
    if (!isLocalMode() || getPlatformAssistants().length > 0) {
      probePlatformSession(set);
    } else {
      set({ platformSessionResolved: true });
    }
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
        probePlatformSession(set, { clearOnFailure: true });
      } else {
        set({ platformSessionResolved: true });
      }
      return true;
    }

    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncUserScopedState(user?.id ?? null);
        set({ isLoggedIn: true, user, hasPlatformSession: true, platformSessionResolved: true });
        return true;
      }
    } catch (err) {
      console.warn("auth.refreshSession failed", err);
    }
    syncUserScopedState(null);
    set({ isLoggedIn: false, user: null, hasPlatformSession: false, platformSessionResolved: true });
    return false;
  },

  logout: async () => {
    if (isGatewayAuthMode()) {
      clearSelectedAssistant();
      clearGatewayToken();
      clearOnboardingFlags();
      clearOrganization();
      clearUserScopedStorage();
      // Clear lifecycle state BEFORE flipping `isLoggedIn` so the
      // assistant sync hooks don't observe a stale assistant id in
      // their first re-render. The `respondToInputs` `!isLoggedIn`
      // branch is the safety net for token-expiry-style flips.
      lifecycleService.resetForLogout();
      set({ isLoggedIn: false, user: null, hasPlatformSession: false, platformSessionResolved: true });
      broadcastAuthChange();
      return;
    }

    suppressPlatformProbe = true;
    try {
      await allauthLogout();
    } finally {
      if (isLocalMode()) {
        document.cookie = "sessionid=; path=/; samesite=lax; expires=Thu, 01 Jan 1970 00:00:00 UTC";
      }
      void deleteBiometricToken();
      clearOnboardingFlags();
      clearOrganization();
      clearUserScopedStorage();
      lifecycleService.resetForLogout();
      set({ isLoggedIn: false, user: null, hasPlatformSession: false, platformSessionResolved: true });
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

  const unsubResume = subscribe("app.resume", () => {
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
