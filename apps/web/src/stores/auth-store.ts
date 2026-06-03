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
  primeLocalGatewayConnectionWithRepair,
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

/**
 * Platform-session liveness as a single tri-state.
 *
 * - `"unknown"`: the probe has not settled yet. The local gateway path sets
 *   `isLoading: false` before `getSession()` returns, so there is a window
 *   where logged-in status is known but session liveness is not. Imperative
 *   consumers (the onboarding fork) must wait this out before deciding;
 *   reactive consumers treat it as "no session" but a cached platform
 *   assistant can stand in as a liveness hint.
 * - `"absent"`: the probe settled with no live platform session.
 * - `"present"`: the probe settled with a live platform session.
 *
 * Encoding it as one value makes "false that really means unknown"
 * unrepresentable, which is the ambiguity that let missing-session readers
 * silently treat the pre-settle window as a confirmed negative.
 */
export type PlatformSessionStatus = "unknown" | "absent" | "present";

interface AuthState {
  isLoggedIn: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  platformSession: PlatformSessionStatus;
}

interface AuthActions {
  initSession: () => Promise<void>;
  connectLocalAssistant: (assistantId: string) => Promise<void>;
  refreshSession: () => Promise<boolean>;
  logout: () => Promise<void>;
}

type AuthStore = AuthState & AuthActions;

/**
 * The store's `set`, narrowed to what the probe needs: a partial patch or a
 * functional updater that reads current state (used to resolve the first
 * settle without clobbering a value a newer probe already wrote).
 */
type AuthSet = (
  partial: Partial<AuthState> | ((state: AuthState) => Partial<AuthState>),
) => void;

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
// must not move `platformSession` while a newer probe is still pending, which
// would resurface the very race this state guards. Only the latest probe's id
// matches `latestPlatformProbe`, so older probes no-op.
let latestPlatformProbe = 0;

/**
 * Run the fire-and-forget platform-session probe used by the local gateway
 * auth paths, which return control before the session is known.
 *
 * The probe never reopens the `"unknown"` window: a re-run (app-resume
 * refresh, return from a provider callback) leaves the last `"present"` /
 * `"absent"` in place until the new result lands, so reactive consumers keep
 * showing the last-known session instead of flickering on every resume. Only
 * the initial boot probe starts from `"unknown"`, and the `.finally` settle
 * resolves that first `"unknown"` to `"absent"` when neither branch confirmed
 * a session.
 *
 * Overlapping probes are resolved latest-wins: each call captures a probe id
 * and only the newest probe is allowed to settle state, so a slower earlier
 * probe cannot overwrite the result of a later one.
 *
 * `setUserOnSuccess` adopts the probed user as the active user (the
 * no-platform-assistant local path, which starts as the placeholder local
 * user). `clearOnFailure` drives the status to `"absent"` on a negative
 * result (the refresh path, which must retract a session that has ended);
 * init paths leave a prior optimistic value untouched.
 */
function probePlatformSession(
  set: AuthSet,
  options: { setUserOnSuccess?: boolean; clearOnFailure?: boolean } = {},
): void {
  const probeId = ++latestPlatformProbe;
  const isStale = (): boolean => probeId !== latestPlatformProbe;
  getSession()
    .then((result) => {
      if (isStale()) return;
      if (result.ok && result.data.user) {
        set(
          options.setUserOnSuccess
            ? {
                platformSession: "present",
                user: toAuthUser(result.data.user),
              }
            : { platformSession: "present" },
        );
      } else if (options.clearOnFailure) {
        set({ platformSession: "absent" });
      }
    })
    .catch(() => {
      if (isStale()) return;
      if (options.clearOnFailure) {
        set({ platformSession: "absent" });
      }
    })
    .finally(() => {
      if (isStale()) return;
      // Settle the initial boot probe: when neither branch above confirmed or
      // cleared a session (init paths don't clear on failure), the first
      // `"unknown"` resolves to `"absent"`. A probe that already settled
      // `"present"`/`"absent"` is left untouched.
      set((state) =>
        state.platformSession === "unknown"
          ? { platformSession: "absent" }
          : {},
      );
    });
}

/**
 * Probe the platform session only when one could exist — non-local mode, or
 * local mode with at least one platform assistant in the lockfile. When there
 * is nothing to probe, settle directly to `"absent"` rather than leaving the
 * status `"unknown"`. Centralizes the reachability gate shared by the local
 * gateway auth entry points (`initSession`, `refreshSession`,
 * `connectLocalAssistant`).
 */
function probePlatformSessionIfReachable(
  set: AuthSet,
  options?: { setUserOnSuccess?: boolean; clearOnFailure?: boolean },
): void {
  if (!isLocalMode() || getPlatformAssistants().length > 0) {
    probePlatformSession(set, options);
  } else {
    set({ platformSession: "absent" });
  }
}

const useAuthStoreBase = create<AuthStore>()((set) => ({
  isLoggedIn: false,
  isLoading: true,
  user: null,
  platformSession: "unknown",

  initSession: async () => {
    if (isGatewayAuthEnabled()) {
      try {
        await primeLocalGatewayConnection();
        set({ isLoggedIn: true, isLoading: false, user: GATEWAY_LOCAL_USER });
      } catch {
        set({ isLoggedIn: false, isLoading: false, user: null });
      }
      probePlatformSessionIfReachable(set);
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
                  set({ isLoggedIn: true, isLoading: false, user, platformSession: "present" });
                  return;
                }
              }
            } catch {
              // Sync failed — continue with cached data
            }
            set({ isLoggedIn: true, isLoading: false, user, platformSession: "present" });
            return;
          }
        } catch {
          // Session check failed — fall through to unauthenticated
        }
        set({ isLoggedIn: false, isLoading: false, user: null, platformSession: "absent" });
        return;
      }
      set({ isLoggedIn: true, isLoading: false, user: GATEWAY_LOCAL_USER });
      if (!suppressPlatformProbe) {
        probePlatformSession(set, { setUserOnSuccess: true });
      } else {
        set({ platformSession: "absent" });
      }
      suppressPlatformProbe = false;
      return;
    }

    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncUserScopedState(user?.id ?? null);
        set({ isLoggedIn: true, isLoading: false, user, platformSession: "present" });
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
            set({ isLoggedIn: true, isLoading: false, user, platformSession: "present" });
            return;
          }
        }
      } catch (err) {
        console.warn("auth.initSession biometric recovery failed", err);
      }
    }

    syncUserScopedState(null);
    set({ isLoggedIn: false, isLoading: false, user: null, platformSession: "absent" });
  },

  /**
   * Connect to a specific local assistant from an interactive surface (the
   * login picker / auto-connect). Selects the assistant, primes its gateway
   * connection, and marks the session logged in.
   *
   * Unlike {@link AuthActions.initSession}, which is the best-effort boot
   * probe and swallows failures, this rethrows so the caller can surface the
   * reason — including the typed `GuardianTokenError` from the host seam — and
   * offer recovery instead of dead-ending. It primes through
   * `primeLocalGatewayConnectionWithRepair`, which self-heals a stopped or
   * mis-seeded assistant via `wake` before surfacing any error — matching the
   * native client's re-pair-on-connect bootstrap. The boot probe deliberately
   * stays on the plain primitive so app launch never spawns daemon processes.
   */
  connectLocalAssistant: async (assistantId: string) => {
    setSelectedAssistantId(assistantId);
    await primeLocalGatewayConnectionWithRepair();
    set({ isLoggedIn: true, isLoading: false, user: GATEWAY_LOCAL_USER });
    probePlatformSessionIfReachable(set);
  },

  refreshSession: async () => {
    if (isGatewayAuthMode()) {
      try {
        await ensureGatewayToken(getLocalTokenUrl());
        set({ isLoggedIn: true });
      } catch {
        set({ isLoggedIn: false, user: null, platformSession: "absent" });
        return false;
      }
      probePlatformSessionIfReachable(set, { clearOnFailure: true });
      return true;
    }

    try {
      const result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        syncUserScopedState(user?.id ?? null);
        set({ isLoggedIn: true, user, platformSession: "present" });
        return true;
      }
    } catch (err) {
      console.warn("auth.refreshSession failed", err);
    }
    syncUserScopedState(null);
    set({ isLoggedIn: false, user: null, platformSession: "absent" });
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
      set({ isLoggedIn: false, user: null, platformSession: "absent" });
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
      set({ isLoggedIn: false, user: null, platformSession: "absent" });
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
