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
  isAuthenticated,
  isSessionSettled,
  hasLivePlatformSession,
  type PlatformSessionStatus,
  type SessionStatus,
} from "@/stores/session-status";

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
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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
  sessionStatus: SessionStatus;
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

/**
 * Named state transitions — the store declares *which session it is entering*
 * instead of re-listing the same field combinations at every call site. Each
 * returns the patch for `set()`, so the actions read as a state machine.
 *
 * `platformSession` is left untouched by transitions that don't know it yet
 * (a follow-up probe settles it); transitions that do know it set it inline.
 */
const authenticatedPlatformUser = (user: AuthUser | null): Partial<AuthState> => ({
  sessionStatus: "authenticated",
  user,
  platformSession: "present",
});

const authenticatedLocalUser = (): Partial<AuthState> => ({
  sessionStatus: "authenticated",
  user: GATEWAY_LOCAL_USER,
});

const sessionEnded = (): Partial<AuthState> => ({
  sessionStatus: "unauthenticated",
  user: null,
  platformSession: "absent",
});

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

// Settle promise for the most recently launched probe, reassigned on every
// launch. Because re-probes keep the last `"present"`/`"absent"` rather than
// reopening `"unknown"` (so reactive consumers don't flicker), the displayed
// `platformSession` can be a prior result while a fresh probe is still in
// flight. Imperative readers that must not act on a not-yet-refreshed value
// (the onboarding route fork) await `whenPlatformSessionSettled`, which chases
// this reference so a probe that becomes latest mid-wait is awaited too.
// Initialized resolved: before any probe runs the status is `"unknown"`, which
// those callers already gate on separately.
let platformProbeSettled: Promise<void> = Promise.resolve();

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
  platformProbeSettled = getSession()
    .then(async (result) => {
      if (isStale()) return;
      if (result.ok && result.data.user) {
        const userUpdate = options.setUserOnSuccess
          ? { user: toAuthUser(result.data.user) }
          : {};
        // Sync platform assistants to the lockfile BEFORE setting
        // platformSession to "present". The auth middleware unblocks on
        // `platformSession !== "unknown"`, and hasAssistants() must
        // already reflect synced platform assistants at that point.
        // Bounded to 3s so a hanging list call can't block the probe
        // from settling — the middleware's 5s timeout would loop
        // indefinitely otherwise.
        if (isLocalMode()) {
          try {
            const apiAssistants = await Promise.race([
              listAssistants(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("sync timeout")), 3_000),
              ),
            ]);
            if (!isStale() && apiAssistants.ok) {
              await syncPlatformAssistantsToLockfile(apiAssistants.data);
            }
          } catch {
            // Sync failed or timed out — continue with cached lockfile data
          }
        }
        if (isStale()) return;
        set({ platformSession: "present", ...userUpdate });
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
      set((state) =>
        state.platformSession === "unknown"
          ? { platformSession: "absent" }
          : {},
      );
    });
}

/**
 * Resolve once no platform-session probe is in flight, or immediately when none
 * is running.
 *
 * Reactive consumers read `platformSession` directly and rely on re-probes
 * leaving the last `"present"`/`"absent"` in place (no flicker). Imperative
 * one-shot readers that must not branch on a stale value — the onboarding
 * hosting/welcome fork — await this instead, so they observe the fresh probe
 * result regardless of what the tri-state currently shows.
 *
 * A probe can become the latest *after* the wait begins (an app-resume refresh
 * firing while we await the current probe). Awaiting a single captured promise
 * would let the resolver proceed when that probe settles even though a newer
 * one is still pending. Instead this chases `platformProbeSettled`: after each
 * await it re-checks whether a newer probe replaced the reference and waits that
 * one out too, returning only once the reference is unchanged across an await —
 * i.e. no probe launched while waiting for the last one.
 */
export async function whenPlatformSessionSettled(): Promise<void> {
  let awaited = platformProbeSettled;
  await awaited;
  while (platformProbeSettled !== awaited) {
    awaited = platformProbeSettled;
    await awaited;
  }
}

/**
 * Probe the platform session when one could exist: non-local mode, gateway
 * auth enabled, or local mode with platform assistants in the lockfile.
 * Gateway auth always probes because the user may have logged into the
 * platform (e.g. via the login flow) without having added platform
 * assistants yet. When nothing qualifies, settle to `"absent"`.
 */
function probePlatformSessionIfReachable(
  set: AuthSet,
  options?: { setUserOnSuccess?: boolean; clearOnFailure?: boolean },
): void {
  if (!isLocalMode() || isGatewayAuthEnabled() || getPlatformAssistants().length > 0) {
    probePlatformSession(set, options);
  } else {
    set({ platformSession: "absent" });
  }
}

const useAuthStoreBase = create<AuthStore>()((set) => ({
  sessionStatus: "initializing",
  user: null,
  platformSession: "unknown",

  initSession: async () => {
    if (isGatewayAuthEnabled()) {
      try {
        await primeLocalGatewayConnection();
        set(authenticatedLocalUser());
      } catch {
        // Gateway prime failed: settle to unauthenticated but leave
        // `platformSession` for the follow-up probe to resolve.
        set({ sessionStatus: "unauthenticated", user: null });
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
                  set(authenticatedPlatformUser(user));
                  return;
                }
              }
            } catch {
              // Sync failed — continue with cached data
            }
            set(authenticatedPlatformUser(user));
            return;
          }
        } catch {
          // Session check failed — fall through to unauthenticated
        }
        set(sessionEnded());
        return;
      }
      set(authenticatedLocalUser());
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
        try {
          const apiAssistants = await listAssistants();
          if (apiAssistants.ok) {
            useResolvedAssistantsStore.getState().setFromApi(apiAssistants.data);
          }
        } catch { /* best effort */ }
        set(authenticatedPlatformUser(user));
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
            try {
              const apiAssistants = await listAssistants();
              if (apiAssistants.ok) {
                useResolvedAssistantsStore.getState().setFromApi(apiAssistants.data);
              }
            } catch { /* best effort */ }
            set(authenticatedPlatformUser(user));
            return;
          }
        }
      } catch (err) {
        console.warn("auth.initSession biometric recovery failed", err);
      }
    }

    syncUserScopedState(null);
    set(sessionEnded());
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
    set(authenticatedLocalUser());
    probePlatformSessionIfReachable(set);
  },

  refreshSession: async () => {
    if (isGatewayAuthMode()) {
      try {
        await ensureGatewayToken(getLocalTokenUrl());
        set({ sessionStatus: "authenticated" });
      } catch {
        set(sessionEnded());
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
        // Reconcile the lockfile mirror on refresh too — not just cold
        // `initSession`. App resume, profile save, and the provider callback
        // all route through here; without this the macOS tray and CLI keep a
        // stale managed-assistant list until the next full boot. Best-effort
        // and local-mode only (platform mode has no lockfile host); the
        // refresh has already succeeded regardless of the sync outcome.
        if (isLocalMode()) {
          try {
            const apiAssistants = await listAssistants();
            if (apiAssistants.ok) {
              await syncPlatformAssistantsToLockfile(apiAssistants.data);
            }
          } catch {
            // Sync failed — continue with cached lockfile data.
          }
        }
        set(authenticatedPlatformUser(user));
        return true;
      }
    } catch (err) {
      console.warn("auth.refreshSession failed", err);
    }
    syncUserScopedState(null);
    set(sessionEnded());
    return false;
  },

  logout: async () => {
    if (isGatewayAuthMode()) {
      clearSelectedAssistant();
      clearGatewayToken();
      clearOnboardingFlags();
      clearOrganization();
      clearUserScopedStorage();
      // Clear lifecycle state BEFORE `sessionStatus` leaves `authenticated`
      // so the assistant sync hooks don't observe a stale assistant id in
      // their first re-render. The `respondToInputs` not-authenticated
      // branch is the safety net for token-expiry-style flips.
      lifecycleService.resetForLogout();
      set(sessionEnded());
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
      set(sessionEnded());
      broadcastAuthChange();
    }
  },
}));

export const useAuthStore = createSelectors(useAuthStoreBase);

/**
 * Semantic read hooks — the reactive public API for components.
 *
 * Each subscribes to one atomic field and answers a single domain question, so
 * components never re-encode the enum (`sessionStatus === "authenticated"`,
 * `platformSession === "present"`) and never juggle a pair of booleans. They
 * compose the pure `session-status` predicates over the atomic selectors
 * generated by `createSelectors`, keeping Zustand's `Object.is` snapshot
 * equality stable.
 */
export const useIsAuthenticated = (): boolean =>
  isAuthenticated(useAuthStore.use.sessionStatus());

export const useIsSessionInitializing = (): boolean =>
  !isSessionSettled(useAuthStore.use.sessionStatus());

export const useHasPlatformSession = (): boolean =>
  hasLivePlatformSession(useAuthStore.use.platformSession());

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
