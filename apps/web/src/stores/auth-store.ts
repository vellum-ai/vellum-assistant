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
import { setSelectedAssistant } from "@/assistant/selection";
import { createSelectors } from "@/utils/create-selectors";
import {
  isAuthenticated,
  isSessionSettled,
  isSettledSessionRejection,
  hasLivePlatformSession,
  type PlatformSessionStatus,
  type SessionStatus,
} from "@/stores/session-status";

import {
  getSession,
  logout as allauthLogout,
} from "@/lib/auth/allauth-client";
import {
  clearUserSnapshot,
  persistUserSnapshot,
  readUserSnapshot,
} from "@/lib/auth/user-snapshot";
import { getElectronSessionToken } from "@/runtime/session-token";
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
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithRepair,
  syncPlatformAssistantsToLockfile,
} from "@/lib/local-mode";
import { listAssistants } from "@/assistant/api";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { deleteBiometricToken } from "@/runtime/native-biometric";
import { fetchMe, patchConsent } from "@/domains/account/profile";
import { restoreConsentForUser, persistConsentForUser, resolveServerConsent, CONSENT_VERSION } from "@/utils/onboarding-cleanup";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { clearOrganization, useOrganizationStore } from "@/stores/organization-store";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import { subscribe } from "@/lib/event-bus";
import { isElectron } from "@/runtime/is-electron";
import { isNativePlatform, isOAuthFlowInFlight, installSessionCookies, waitForNativeSessionCookie } from "@/runtime/native-auth";
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
  connectPlatformAssistant: (assistantId: string) => Promise<void>;
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
const authenticatedPlatformUser = (user: AuthUser | null): Partial<AuthState> => {
  // Entering this state is the one place a platform session is freshly
  // confirmed — persist the snapshot here so every confirmation path
  // (boot, refresh, connect, biometric retry) feeds the offline restore
  // (LUM-2412) without each call site remembering to.
  persistUserSnapshot(user);
  return {
    sessionStatus: "authenticated",
    user,
    platformSession: "present",
  };
};

const authenticatedLocalUser = (): Partial<AuthState> => ({
  sessionStatus: "authenticated",
  user: GATEWAY_LOCAL_USER,
});

const sessionEnded = (): Partial<AuthState> => ({
  sessionStatus: "unauthenticated",
  user: null,
  platformSession: "absent",
});

/**
 * A `getSession()` outcome that says nothing about the session itself —
 * the request threw (fetch rejection), never completed, or failed for a
 * non-auth reason (429 rate limiting, 5xx outages, the Electron proxy's
 * offline 502). Distinct from a settled "no session" answer (2xx without
 * user, or an explicit 401/403/410 rejection), which is the only thing
 * allowed to end the session. Callers check the 2xx-without-user case
 * themselves — by the time they consult this, `result.ok` means the user
 * field was missing, a settled negative.
 */
const isInconclusiveProbe = (
  result: Awaited<ReturnType<typeof getSession>> | null,
): boolean =>
  result === null || (!result.ok && !isSettledSessionRejection(result));

/**
 * Settle the session from the persisted user snapshot after a
 * transport-failed boot probe (offline launch, tray reopen before Wi-Fi
 * reassociates — LUM-2412). Requires a local credential: the Electron
 * session token lives in the main process, so its presence means the
 * user never signed out — the probe merely couldn't reach the platform.
 * Web builds have no readable credential (cookie sessions), so they
 * keep the conservative login-screen behavior.
 *
 * `platformSession` is deliberately left untouched: the session is
 * believed, not confirmed. The app-resume/online refresh revalidates
 * once the network returns; a settled "no session" answer there ends
 * the session (and drops the snapshot) through the normal path.
 */
async function restoreOfflineSession(set: AuthSet): Promise<boolean> {
  if (!getElectronSessionToken()) return false;
  const cached = readUserSnapshot();
  if (!cached) return false;
  // Consent/org sync falls back to device-cached keys when the server
  // fetch fails (it will, offline) — same continuity as an online boot.
  await syncUserScopedState(cached.id);
  set({ sessionStatus: "authenticated", user: cached });
  return true;
}

function syncOrganizationState(nextUserId: string | null): void {
  if (!nextUserId || (previousUserId && previousUserId !== nextUserId)) {
    clearOrganization();
  }
  previousUserId = nextUserId;
}

function broadcastAuthChange(): void {
  broadcastChannel?.postMessage("auth-changed");
}

async function syncUserScopedState(nextUserId: string | null): Promise<void> {
  if (nextUserId) {
    try {
      const me = await fetchMe();
      if (me.consent) {
        const resolved = resolveServerConsent(me.consent);
        const store = useOnboardingStore.getState();
        store.setTosAccepted(resolved.tos);
        store.setAiDataConsent(resolved.ai);
        if (resolved.shareAnalytics !== null) store.setShareAnalytics(resolved.shareAnalytics);
        if (resolved.shareDiagnostics !== null) store.setShareDiagnostics(resolved.shareDiagnostics);
        persistConsentForUser(nextUserId, resolved.tos, resolved.ai);
        syncOrganizationState(nextUserId);
        return;
      }
      // Server has no consent record — fall through to device keys.
      // If device keys show prior acceptance, backfill the server.
      const deviceConsent = restoreConsentForUser(nextUserId);
      const store = useOnboardingStore.getState();
      store.setTosAccepted(deviceConsent.tos);
      store.setAiDataConsent(deviceConsent.ai);
      if (deviceConsent.tos && deviceConsent.ai) {
        void patchConsent({
          tos_accepted_version: CONSENT_VERSION,
          privacy_policy_accepted_version: CONSENT_VERSION,
          ai_data_sharing_accepted_version: CONSENT_VERSION,
        }).catch(() => {});
      }
      syncOrganizationState(nextUserId);
      return;
    } catch {
      // Server fetch failed — fall through to device keys
    }
  }

  const consent = restoreConsentForUser(nextUserId);
  const store = useOnboardingStore.getState();
  store.setTosAccepted(consent.tos);
  store.setAiDataConsent(consent.ai);
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
        const probedUser = toAuthUser(result.data.user);
        const userUpdate = options.setUserOnSuccess ? { user: probedUser } : {};
        // Adopting the probed user confirms a platform session outside the
        // `authenticatedPlatformUser` transition — persist here too so the
        // local-mode path feeds the offline restore (LUM-2412).
        if (options.setUserOnSuccess) persistUserSnapshot(probedUser);
        // Sync platform assistants to the lockfile BEFORE setting
        // platformSession to "present". The auth middleware unblocks on
        // `platformSession !== "unknown"`, and hasAssistants() must
        // already reflect synced platform assistants at that point.
        // The whole sequence (org fetch, list, host replace) is bounded
        // to 3s so a hanging call can't block the probe from settling —
        // the middleware's 5s timeout would loop indefinitely otherwise.
        // The race does not cancel the inner branch, so the guard also
        // checks `timedOut`: once the probe settles without the sync, a
        // late commit must not land after routing decisions were made on
        // the un-synced lockfile. `!isStale()` likewise keeps a
        // superseded probe from committing an out-of-date lockfile.
        if (isLocalMode()) {
          let timedOut = false;
          const syncIsCurrent = (): boolean => !timedOut && !isStale();
          try {
            await Promise.race([
              (async () => {
                await useOrganizationStore.getState().fetchOrganizations();
                const apiAssistants = await listAssistants();
                if (syncIsCurrent() && apiAssistants.ok) {
                  await syncPlatformAssistantsToLockfile(
                    apiAssistants.data,
                    useOrganizationStore.getState().currentOrganizationId ?? undefined,
                    syncIsCurrent,
                  );
                }
              })(),
              new Promise<never>((_, reject) =>
                setTimeout(() => {
                  timedOut = true;
                  reject(new Error("sync timeout"));
                }, 3_000),
              ),
            ]);
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

const useAuthStoreBase = create<AuthStore>()((set, get) => ({
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
        let result: Awaited<ReturnType<typeof getSession>> | null = null;
        try {
          result = await getSession();
          if (result.ok && result.data.user) {
            const user = toAuthUser(result.data.user);
            await syncUserScopedState(user?.id ?? null);
            // Re-sync platform assistants to remove stale lockfile entries.
            try {
              await useOrganizationStore.getState().fetchOrganizations();
              const apiAssistants = await listAssistants();
              if (apiAssistants.ok) {
                await syncPlatformAssistantsToLockfile(
                  apiAssistants.data,
                  useOrganizationStore.getState().currentOrganizationId ?? undefined,
                );
              }
            } catch {
              // Sync failed — continue with cached data
            }
            set(authenticatedPlatformUser(user));
            return;
          }
        } catch {
          // Thrown fetch — classified as a transport failure below.
        }
        // Offline boot with a still-valid local credential must not bounce
        // to the login screen (LUM-2412); only a settled "no session"
        // answer ends the session (and invalidates the snapshot).
        if (isInconclusiveProbe(result)) {
          if (await restoreOfflineSession(set)) return;
        } else {
          clearUserSnapshot();
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

    let result: Awaited<ReturnType<typeof getSession>> | null = null;
    try {
      result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        await syncUserScopedState(user?.id ?? null);
        try {
          await useOrganizationStore.getState().fetchOrganizations();
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

    // Offline boot (tray reopen recreating the window, app launch before
    // Wi-Fi reassociates): a transport-failed probe says nothing about
    // the session, so restore it from the snapshot instead of bouncing a
    // logged-in user to the login screen (LUM-2412).
    if (isInconclusiveProbe(result) && (await restoreOfflineSession(set))) {
      return;
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
            await syncUserScopedState(user?.id ?? null);
            try {
              await useOrganizationStore.getState().fetchOrganizations();
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

    await syncUserScopedState(null);
    // Only a settled "no session" answer invalidates the snapshot — a
    // revoked session must not be resurrected by a later offline boot.
    // Transport failures keep it (web builds land here too; without a
    // readable credential they stay on the login-screen behavior).
    if (!isInconclusiveProbe(result)) clearUserSnapshot();
    set(sessionEnded());
  },

  /**
   * Connect to a specific local assistant from an interactive surface (the
   * login picker / auto-connect). Primes its gateway connection, selects the
   * assistant, and marks the session logged in.
   *
   * Priming runs BEFORE the selection write: the lifecycle's selection
   * subscription republishes the connection synchronously on the write, so
   * the token must already be minted for the new gateway — and a failed
   * connect leaves the previous selection in place.
   *
   * After the selection write we explicitly drive `checkAssistant()` rather
   * than trusting the selection subscription to publish `activeAssistantId`.
   * That subscription only fires when `selectedAssistantId` actually changes
   * (and not while the lifecycle is still `loading`), so reconnecting to the
   * assistant that's already selected — the common case after guardian-token
   * repair, where the user retries the very assistant they were connecting to
   * — would otherwise leave the active id stale. In gateway mode the call is a
   * synchronous, idempotent republish.
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
    const target = getLocalAssistants().find(
      (a) => a.assistantId === assistantId,
    );
    await primeLocalGatewayConnectionWithRepair(target);
    await setSelectedAssistant(assistantId);
    set(authenticatedLocalUser());
    await lifecycleService.checkAssistant();
    probePlatformSessionIfReachable(set);
  },

  connectPlatformAssistant: async (assistantId: string) => {
    await setSelectedAssistant(assistantId);
    const result = await getSession();
    if (!result.ok || !result.data.user) {
      throw new Error("Platform authentication required");
    }
    const user = toAuthUser(result.data.user);
    await syncUserScopedState(user?.id ?? null);
    // Hydrate the organizations to avoid race conditions from lazy fetch.
    await useOrganizationStore.getState().fetchOrganizations();
    set(authenticatedPlatformUser(user));
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

    let result: Awaited<ReturnType<typeof getSession>> | null = null;
    try {
      result = await getSession();
      if (result.ok && result.data.user) {
        const user = toAuthUser(result.data.user);
        await syncUserScopedState(user?.id ?? null);
        // Reconcile the lockfile mirror on refresh too — not just cold
        // `initSession`. App resume, profile save, and the provider callback
        // all route through here; without this the macOS tray and CLI keep a
        // stale managed-assistant list until the next full boot. Best-effort
        // and local-mode only (platform mode has no lockfile host); the
        // refresh has already succeeded regardless of the sync outcome.
        if (isLocalMode()) {
          try {
            await useOrganizationStore.getState().fetchOrganizations();
            const apiAssistants = await listAssistants();
            if (apiAssistants.ok) {
              await syncPlatformAssistantsToLockfile(
                apiAssistants.data,
                useOrganizationStore.getState().currentOrganizationId ?? undefined,
              );
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
    // Offline resume (un-minimizing fires visibilitychange → app.resume →
    // this refresh): a transport-failed probe must not tear a logged-in
    // surface down to the login screen (LUM-2412). Keep the current state;
    // the next resume/online refresh revalidates for real, and a settled
    // "no session" answer below still ends the session normally.
    if (isInconclusiveProbe(result)) {
      return isAuthenticated(get().sessionStatus);
    }
    clearUserSnapshot();
    await syncUserScopedState(null);
    set(sessionEnded());
    return false;
  },

  logout: async () => {
    if (isGatewayAuthMode()) {
      // Clear lifecycle state BEFORE `sessionStatus` leaves `authenticated`
      // so the assistant sync hooks don't observe a stale assistant id in
      // their first re-render, and BEFORE the selection clear so the
      // lifecycle's selection subscription (guarded on `loading`) doesn't
      // resurrect an active state mid-logout. The `respondToInputs`
      // not-authenticated branch is the safety net for token-expiry-style
      // flips.
      lifecycleService.resetForLogout();
      await setSelectedAssistant(null);
      clearGatewayToken();
      clearOrganization();
      clearUserScopedStorage();
      set(sessionEnded());
      broadcastAuthChange();
      return;
    }

    suppressPlatformProbe = true;
    try {
      await allauthLogout();
    } finally {
      // Clean up session token in the main process.
      if (isElectron()) await window.vellum?.auth?.signOut?.();
      if (isLocalMode()) {
        document.cookie = "sessionid=; path=/; samesite=lax; expires=Thu, 01 Jan 1970 00:00:00 UTC";
      }
      void deleteBiometricToken();
      clearOrganization();
      clearUserScopedStorage();
      lifecycleService.resetForLogout();
      // Clear the selection slice too — `clearUserScopedStorage` already
      // removed the persisted key, and a surviving slice would resolve the
      // previous user's assistant after re-login.
      await setSelectedAssistant(null);
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
    // Mid-OAuth refocus — an unauthenticated probe would tear down state.
    if (isOAuthFlowInFlight()) return;
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
