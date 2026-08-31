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
  isPlatformSessionSettled,
  isConfirmedPlatformSession,
  type PlatformSessionStatus,
  type SessionStatus,
} from "@/stores/session-status";

import { getSession, logout as allauthLogout } from "@/lib/auth/allauth-client";
import {
  clearUserSnapshot,
  persistUserSnapshot,
  readUserSnapshot,
} from "@/lib/auth/user-snapshot";
import { getElectronSessionToken } from "@/runtime/session-token";
import { clearWidgetSnapshot } from "@/runtime/widget-snapshot";
import {
  isGatewayAuthEnabled,
  isGatewayAuthMode,
  ensureGatewayToken,
  clearGatewayToken,
  getGatewayToken,
  getLocalTokenUrl,
} from "@/lib/auth/gateway-session";
import { refreshRemoteGatewaySession } from "@/lib/auth/remote-gateway-session";
import {
  isLocalClient,
  isRemoteGatewayMode,
  getLockfileAssistant,
  getPlatformAssistants,
  getLocalAssistants,
  getSelectedAssistant,
  isPairedAssistant,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithRepair,
  primeLocalGatewayConnectionWithStartupRetry,
  syncPlatformAssistantsToLockfile,
} from "@/lib/local-mode";
import { bootstrapLocalAssistantPlatformIdentity } from "@/lib/local-platform-identity";
import { listAssistants } from "@/assistant/api";
import { deleteBiometricToken } from "@/runtime/native-biometric";
import { unregisterLiveActivityPushToken } from "@/domains/chat/voice/live-voice/live-activity-push-registration";
import { unregisterFromRemotePush } from "@/runtime/push-registration";
import {
  fetchConsent,
  patchConsent,
  type ConsentPatch,
} from "@/domains/account/profile";
import {
  restoreConsentForUser,
  persistConsentForUser,
  persistDiagnosticsAck,
  resolveServerConsent,
  getRequiredConsentVersions,
  ANALYTICS_CONSENT_VERSION,
} from "@/lib/consent/consent-persistence";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import {
  applyResolvedDiagnosticsConsent,
  failCloseDiagnosticsGateUntilFirstSync,
} from "@/lib/consent/diagnostics-consent";
import {
  clearOrganization,
  useOrganizationStore,
} from "@/stores/organization-store";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { subscribe } from "@/lib/event-bus";
import { isElectron } from "@/runtime/is-electron";
import { clearLocalPlatformSession } from "@/runtime/local-mode-host";
import {
  isNativePlatform,
  isOAuthFlowInFlight,
  installSessionCookies,
  waitForNativeSessionCookie,
} from "@/runtime/native-auth";
import {
  isBiometricEnabled,
  retrieveBiometricToken,
} from "@/runtime/native-biometric";

export interface AuthUser {
  /**
   * Discriminates a real platform account (`"platform"`) from synthetic local
   * gateway access (`"local"`). Both carry a stable `id` — local's is the
   * synthetic `"gateway-local"`, kept for storage namespacing — so a non-null
   * user does not by itself imply a platform account.
   */
  kind: "platform" | "local";
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
  if (!raw) {
    return null;
  }
  return {
    kind: "platform",
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
  // True while `platformSession: "present"` is a believed offline restore
  // (LUM-2412) rather than a session a live probe confirmed. Telemetry gates on
  // a confirmed-live session, so it must not treat the restored state as live.
  platformSessionRestoredOffline: boolean;
}

interface AuthActions {
  initSession: () => Promise<void>;
  connectLocalAssistant: (assistantId: string) => Promise<void>;
  connectPairedAssistant: (assistantId: string) => Promise<void>;
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
  kind: "local",
  id: "gateway-local",
  username: "local",
  email: null,
  isStaff: false,
  firstName: "Local",
  lastName: "User",
};

// Monotonic id stamped on every transition INTO an authenticated session.
// `endSession` awaits the widget-snapshot clear before it writes, and auth work
// overlaps: the app-resume listener can fire a second `refreshSession`, and an
// interactive sign-in can land, while an earlier conclusive rejection is still
// waiting on that bridge call. A session authenticated inside that window is
// the newer truth, so the delayed write compares the epoch it captured against
// this counter and skips itself rather than sending a freshly signed-in user
// back to login. Latest-wins, the same rule `latestPlatformProbe` applies to
// overlapping platform probes.
//
// Latest-wins only settles races between *observations* of the session. An
// explicit `logout()` is not one, so it ends the session through
// `endSession(set, { authoritative: true })` and lands its write regardless.
let authEpoch = 0;

// Bumped by every explicit `logout()`, once when it starts and once when the
// session has ended. `authEpoch` settles races between observations; this
// settles the other direction, because a decision also invalidates the
// observations already in flight. A `refreshSession` that entered before the
// logout can still be inside `reconcilePlatformAssistants()` or
// `syncUserScopedState()` when the authoritative session-ending write lands,
// and its later `set(authenticatedPlatformUser(user))` would restore signed-in
// surfaces (and re-persist the departing user's snapshot and consent) from a
// response obtained while the credentials still existed. So each refresh
// snapshots this counter on entry and re-checks it before every authenticated
// write, abandoning the write when a logout has moved it. Bumping at both ends
// makes the invariant "no logout began or ended while I was running", which
// covers a refresh that started midway through the logout too.
//
// Nothing resets it, and nothing can wedge on it: the snapshot is taken on
// entry, so a refresh (or a connect action, or the loopback page's
// `initSession`) that starts after a logout captures the current value and
// commits normally. A fresh sign-in always works.
let logoutGeneration = 0;

/**
 * Stamp a new auth epoch and hand back the patch unchanged, so every write that
 * enters an authenticated session supersedes a session-ending write that is
 * still mid-await in {@link endSession}.
 */
function enteringAuthenticatedSession(
  patch: Partial<AuthState>,
): Partial<AuthState> {
  authEpoch += 1;
  return patch;
}

/**
 * Named state transitions — the store declares *which session it is entering*
 * instead of re-listing the same field combinations at every call site. Each
 * returns the patch for `set()`, so the actions read as a state machine.
 *
 * `platformSession` is left untouched by transitions that don't know it yet
 * (a follow-up probe settles it); transitions that do know it set it inline.
 */
const authenticatedPlatformUser = (
  user: AuthUser | null,
): Partial<AuthState> => {
  // Entering this state is the one place a platform session is freshly
  // confirmed — persist the snapshot here so every confirmation path
  // (boot, refresh, connect, biometric retry) feeds the offline restore
  // (LUM-2412) without each call site remembering to.
  persistUserSnapshot(user);
  return enteringAuthenticatedSession({
    sessionStatus: "authenticated",
    user,
    platformSession: "present",
    // Confirmed by a live probe; `restoreOfflineSession` overrides this to true.
    platformSessionRestoredOffline: false,
  });
};

const authenticatedLocalUser = (): Partial<AuthState> =>
  enteringAuthenticatedSession({
    sessionStatus: "authenticated",
    user: GATEWAY_LOCAL_USER,
  });

const sessionEnded = (): Partial<AuthState> => ({
  sessionStatus: "unauthenticated",
  user: null,
  platformSession: "absent",
});

/**
 * Apply the {@link sessionEnded} transition. Every path that ends a session
 * goes through here, not through a bare `set(sessionEnded())`, because a
 * session ends far more often without an explicit `logout()` than with one:
 * a revoked or expired session settles through `refreshSession`'s 401 branch,
 * and a boot that finds no session settles through `initSession`.
 *
 * The one thing that has to happen off-store is dropping the iOS widget
 * snapshot. A Home Screen widget is readable without unlocking the device, so
 * the previous account's conversation titles must not outlive the session that
 * produced them, whichever way it ended. No-op off Capacitor iOS.
 *
 * Awaited BEFORE the state write: the write is what flips signed-in surfaces
 * to the login screen, and on the logout path that can end in a hard
 * navigation that tears the page down before a detached bridge call would
 * reach the shell.
 *
 * Awaited, but not gated on: a sign-out the bridge could refuse to complete
 * would be worse than a snapshot that outlives it by one launch. It is not
 * fire-and-forget either, because a clear that does not land persists the
 * obligation and the next use of the module finishes it, so the drop is
 * at-least-once rather than best-effort. That is why nothing here reads the
 * reported outcome.
 *
 * That await is bounded but not instant (2s on an unanswering iOS bridge), so
 * the write is guarded by {@link authEpoch}: an authentication that lands while
 * the clear is outstanding supersedes this transition, and the resumed call
 * skips its write instead of reverting the newer session. The clear itself
 * still stands, being idempotent, and the fresh session's next sync rewrites
 * the snapshot.
 *
 * `authoritative` opts out of that guard, for the callers whose session end is
 * a decision rather than an observation: an explicit `logout()` has already
 * dropped the credentials, the selection, the organization and the user-scoped
 * storage by the time it gets here, so a refresh that authenticated inside the
 * clear's window is describing a session that no longer exists. Letting the
 * guard skip the write there would leave the user on signed-in surfaces after
 * pressing Log Out. Every passive path (a boot probe, a refresh 401, an
 * exhausted gateway prime) keeps the guard, because those are reports about a
 * session that a newer report is entitled to supersede.
 *
 * The decision runs the other way too: an observation already in flight when
 * the decision is made describes a session that no longer exists, so it must
 * not land either. That half lives in {@link logoutGeneration}, which
 * `refreshSession` re-checks before each of its authenticated writes.
 *
 * `keepPlatformSession` omits the `platformSession: "absent"` half of the
 * transition for the one caller that ends the session with a platform probe
 * still in flight. Writing `"absent"` there would settle
 * {@link isPlatformSessionSettled} on a value the probe is about to replace,
 * and consumers that gate on the settle (the billing tab rewrite,
 * `usePlatformGate`) would act on it. The snapshot drop is unconditional.
 */
async function endSession(
  set: AuthSet,
  options?: { keepPlatformSession?: boolean; authoritative?: boolean },
): Promise<void> {
  const epoch = authEpoch;
  await clearWidgetSnapshot();
  if (!options?.authoritative && epoch !== authEpoch) {
    return;
  }
  set(
    options?.keepPlatformSession
      ? { sessionStatus: "unauthenticated", user: null }
      : sessionEnded(),
  );
}

/**
 * A `getSession()` outcome that says nothing about the session itself —
 * the request threw (fetch rejection), never completed, or failed for a
 * non-auth reason (429 rate limiting, 5xx outages, the Electron proxy's
 * offline 502). Distinct from a settled "no session" answer (2xx without
 * user, or an explicit 401/403/410 rejection), which is the only thing
 * allowed to end the session. Callers handle the 2xx cases themselves;
 * by the time they consult this, an ok result was already judged unusable
 * (user missing, or platform-rejected evidence), a settled negative.
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
 * Restores through the full `authenticatedPlatformUser` transition —
 * including `platformSession: "present"` — rather than leaving the
 * tri-state `"unknown"`: the snapshot is only ever written when a
 * platform session was confirmed, and no probe runs offline to settle
 * an `"unknown"`, so consumers gated on it (the auth middleware's
 * no-assistant wait, the onboarding fork) would stall against their
 * timeouts. "Present" is the believed state; the app-resume/online
 * refresh revalidates once the network returns, and a settled "no
 * session" answer there ends the session (and drops the snapshot)
 * through the normal path.
 */
async function restoreOfflineSession(set: AuthSet): Promise<boolean> {
  if (!getElectronSessionToken()) {
    return false;
  }
  const cached = readUserSnapshot();
  if (!cached) {
    return false;
  }
  // Consent/org sync falls back to device-cached keys when the server
  // fetch fails (it will, offline) — same continuity as an online boot.
  await syncUserScopedState(cached.id);
  set({
    ...authenticatedPlatformUser(cached),
    platformSessionRestoredOffline: true,
  });
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

/**
 * Payload for the fire-and-forget server backfill of device-attested consent.
 * The legal axes and diagnostics contribute their current version stamp only
 * when the device ack attests it (device ack keys are version-stamped, so a
 * true key proves acceptance of the CURRENT version). Share boolean values
 * ride along only when `shareValues` is passed AND the value is an explicit
 * choice (`null` = never asked = nothing to backfill) — appropriate for a
 * truly empty server record, where the API default would otherwise overwrite
 * a device opt-out on the next fetch. A real server record's share booleans
 * are authoritative and must not be patched from the device. Analytics has no
 * device ack; an explicit device value carries its version stamp directly (a
 * device value only exists from an explicit choice, and a value without a
 * stamp would read as stale and bounce the user to review-terms).
 */
function buildDeviceConsentBackfill(axes: {
  tos: boolean;
  privacy: boolean;
  diagnostics: boolean;
  shareValues?: { analytics: boolean | null; diagnostics: boolean | null };
}): ConsentPatch {
  // Legal and diagnostics stamps come from the adopted required versions
  // (server-supplied when the preceding resolveServerConsent saw them, frozen
  // constants otherwise) — their device acks were validated against those
  // requirements, so a server-side version bump is never backfilled with a
  // stale stamp. Analytics is the deliberate exception below.
  const required = getRequiredConsentVersions();
  return {
    ...(axes.tos ? { tos_accepted_version: required.tos } : {}),
    ...(axes.privacy
      ? {
          privacy_policy_accepted_version: required.privacyPolicy,
          ai_data_sharing_accepted_version: required.aiDataSharing,
        }
      : {}),
    ...(axes.shareValues && axes.shareValues.analytics !== null
      ? {
          share_analytics: axes.shareValues.analytics,
          // The frozen build constant, NOT the adopted required version:
          // analytics has no versioned device ack, so a device value proves
          // only a choice made under some build's disclosure — stamping a
          // server-bumped version would attest a disclosure the user never
          // saw. The constant bounds the stamp to what this build could have
          // shown; an under-stamp at worst re-reviews.
          share_analytics_accepted_version: ANALYTICS_CONSENT_VERSION,
        }
      : {}),
    ...(axes.diagnostics
      ? {
          share_diagnostics_accepted_version: required.shareDiagnostics,
          ...(axes.shareValues && axes.shareValues.diagnostics !== null
            ? { share_diagnostics: axes.shareValues.diagnostics }
            : {}),
        }
      : {}),
  };
}

// The account the consent flags were last synced for. `undefined` = no sync
// yet this page load (the store boots clean, so there is nothing to reset).
let lastConsentSyncUserId: string | null | undefined;

/** Test-only: forget the last-synced account between tests. */
export function __resetConsentSyncUserForTesting(): void {
  lastConsentSyncUserId = undefined;
}

async function syncUserScopedState(nextUserId: string | null): Promise<void> {
  if (
    lastConsentSyncUserId !== undefined &&
    lastConsentSyncUserId !== nextUserId
  ) {
    // The pending opt-in and adopted server verdicts belong to the previous
    // account's session — a different account (or a signed-out state) must
    // never inherit them: a stale pending opt-in could otherwise override
    // the new account's server-effective opt-out.
    const store = useOnboardingStore.getState();
    store.setPendingAnalyticsOptIn(false);
    store.setServerAnalyticsEffective(null);
    store.setServerDiagnosticsEffective(null);
  }
  lastConsentSyncUserId = nextUserId;
  if (nextUserId) {
    try {
      const consent = await fetchConsent();
      const resolved = resolveServerConsent(consent);
      const store = useOnboardingStore.getState();
      // Local explicit share choices, captured before server adoption below —
      // the truly-empty-record backfill must send what the user chose on this
      // device, not the just-adopted server value.
      const localShareAnalytics = store.shareAnalytics;
      const localShareDiagnostics = store.shareDiagnostics;
      // Adopt the platform-computed effective verdicts for the data-capture
      // gates UNCONDITIONALLY: the platform computes a verdict for every
      // response, including no-row responses (never-asked → enabled), so
      // there is no client-side judgment about record-ness on this path —
      // that heuristic (hasServerRecord) guards only legal-consent fallback,
      // backfill, and chosen-ness adoption. The pending opt-in clears only
      // once the fetched record REFLECTS it — a sync racing the opt-in's
      // in-flight PATCH must not flip uploads back off on the stale record.
      // (An explicit server false is adopted into the store above, where the
      // gate's explicit-false rule closes uploads regardless of pending.)
      if (resolved.shareAnalytics === true) {
        store.setPendingAnalyticsOptIn(false);
      }
      store.setServerAnalyticsEffective(resolved.analyticsEffective);
      store.setServerDiagnosticsEffective(resolved.diagnosticsEffective);
      // Adopt the server's tri-state share-analytics verbatim: an explicit
      // choice is authoritative even when its legal consent versions are stale
      // (the nav layer routes to review-terms), and null (never asked)
      // propagates so the store reflects chosen-ness. Two exceptions:
      // a no-record response adopts nothing — its values are API defaults
      // (older shapes materialize `true` there), and adopting one would
      // clobber the device opt-out the backfill below is about to seed the
      // server with. And a stale server value never overwrites a PENDING
      // local edit in either direction: null must not clear an explicit
      // local opt-out whose write may be in flight, and a stale false must
      // not clobber a pending opt-in (the gate's explicit-false rule would
      // silently flip the user's just-made choice back off).
      if (
        resolved.hasServerRecord &&
        (resolved.shareAnalytics !== null || localShareAnalytics !== false) &&
        !(
          resolved.shareAnalytics === false &&
          useOnboardingStore.getState().pendingAnalyticsOptIn
        )
      ) {
        store.setShareAnalytics(resolved.shareAnalytics);
      }

      // Diagnostics routes through the single direction-asymmetric
      // chokepoint: only an explicit revoke closes the reporting gate
      // (opt-out), and an unknown grant leaves the saved preference untouched.
      applyResolvedDiagnosticsConsent(
        {
          shareDiagnostics: resolved.shareDiagnostics,
          diagnosticsEffective: resolved.diagnosticsEffective,
          hasServerRecord: resolved.hasServerRecord,
        },
        store.setShareDiagnostics,
      );

      // Resolve the FINAL consent values before persisting or mutating the
      // store. The endpoint always returns an object, so empty/stale versions
      // (not a null record) are the "never accepted" signal; when the server
      // has nothing on record the device ack keys are authoritative. Persisting
      // first would overwrite those keys with the empty server values before the
      // fallback below reads them.
      let tos = resolved.tos;
      let privacy = resolved.privacy;
      let analyticsCurrent = resolved.analyticsCurrent;
      let diagnosticsCurrent = resolved.diagnosticsCurrent;
      // "Has this user ever consented", independent of version currency —
      // consent surfaces need it to tell a never-consented user from one whose
      // acceptances merely went stale (both legal flags read false in EITHER
      // case once both required versions are bumped). Device acks below can
      // upgrade it, mirroring how they upgrade `tos`/`privacy`.
      let hasConsentRecord = resolved.hasServerRecord;
      // Genuine "confirmed under the current version" attestation, distinct
      // from the `*Current` flags, which also read never-asked (a null server
      // value) as "nothing to re-review". Only a genuine ack may be
      // device-persisted or backfill a server version stamp, so the ack keys
      // off the raw version currency. Analytics has no device ack — its
      // version stamps are written server-side at choice time.
      let diagnosticsAck =
        resolved.shareDiagnostics !== null &&
        resolved.diagnosticsVersionCurrent;

      // Fall back to device keys for a TRULY empty record: the device ack
      // keys are the only consent evidence, so they drive the legal axes and
      // seed the server via the backfill.
      if (!resolved.hasServerRecord) {
        const deviceConsent = restoreConsentForUser(nextUserId);
        // No server record means no explicit share-toggle consent exists —
        // never-asked, so nothing to re-review regardless of the device acks.
        analyticsCurrent = true;
        diagnosticsCurrent = true;
        diagnosticsAck = deviceConsent.diagnosticsCurrent;
        if (deviceConsent.tos && deviceConsent.privacy) {
          tos = true;
          privacy = true;
          // Device acks are consent evidence: this user consented before, so
          // they are not a first-consent user even with an empty server row.
          hasConsentRecord = true;
          // Backfill the server from the device evidence: stamp the
          // diagnostics version when its device ack is current, and send any
          // explicit device share choice so the next fetch can't overwrite a
          // device opt-out with the API default.
          void patchConsent(
            buildDeviceConsentBackfill({
              tos: true,
              privacy: true,
              diagnostics: diagnosticsAck,
              shareValues: {
                analytics: localShareAnalytics,
                diagnostics: localShareDiagnostics,
              },
            }),
          ).catch(() => {});
        }
      } else if (!tos || !privacy || !diagnosticsCurrent) {
        // A real record with stale/false version-derived flags. The device ack
        // keys are version-stamped, so a true key attests acceptance of the
        // CURRENT version — a stale server version alongside a current device
        // ack means only the fire-and-forget backfill write hasn't landed.
        // Prefer the device attestation for those axes and re-send the
        // backfill, so an established user isn't bounced into onboarding by a
        // record their own acceptance is still in flight to. Axes the server
        // records as current stay server-authoritative, as do the share
        // boolean values (adopted above). Analytics has no device ack, so a
        // stale explicit analytics choice always re-reviews.
        const deviceConsent = restoreConsentForUser(nextUserId);
        const tosFromDevice = !tos && deviceConsent.tos;
        const privacyFromDevice = !privacy && deviceConsent.privacy;
        const diagnosticsFromDevice =
          !diagnosticsCurrent && deviceConsent.diagnosticsCurrent;
        if (tosFromDevice) {
          tos = true;
        }
        if (privacyFromDevice) {
          privacy = true;
        }
        if (diagnosticsFromDevice) {
          diagnosticsCurrent = true;
          diagnosticsAck = true;
        }
        if (tosFromDevice || privacyFromDevice || diagnosticsFromDevice) {
          void patchConsent(
            buildDeviceConsentBackfill({
              tos: tosFromDevice,
              privacy: privacyFromDevice,
              diagnostics: diagnosticsFromDevice,
            }),
          ).catch(() => {});
        }
      }

      store.setTosAccepted(tos);
      store.setPrivacyConsent(privacy);
      store.setAnalyticsConsentCurrent(analyticsCurrent);
      store.setDiagnosticsConsentCurrent(diagnosticsCurrent);
      store.setHasConsentRecord(hasConsentRecord);
      persistConsentForUser(nextUserId, tos, privacy);
      // A false toggle ack is never written: absent ≡ false for every
      // reader, and writing false would erase a genuine device attestation
      // whose backfill patch simply hasn't landed on the server yet.
      if (diagnosticsAck) {
        persistDiagnosticsAck(nextUserId);
      }
      syncOrganizationState(nextUserId);
      store.setConsentHydrated(true);
      return;
    } catch {
      // Server fetch failed — fall through to device keys
    }
  }

  const consent = restoreConsentForUser(nextUserId);
  const store = useOnboardingStore.getState();
  // Consent fetch failed for a platform user: a device that has never
  // resolved a diagnostics gate fails closed until a successful sync can
  // reveal a server-side explicit opt-out. A failed fetch keeps the last
  // adopted server verdicts; a signed-out sync clears them — they belong to
  // the departed user's record.
  if (nextUserId) {
    failCloseDiagnosticsGateUntilFirstSync();
  } else {
    store.setPendingAnalyticsOptIn(false);
    store.setServerAnalyticsEffective(null);
    store.setServerDiagnosticsEffective(null);
  }
  store.setTosAccepted(consent.tos);
  store.setPrivacyConsent(consent.privacy);
  // An absent device ack here can't be told apart from never-asked, and only
  // the server can attest an explicit stale consent — never bounce to
  // review-terms on device evidence alone. A genuinely stale consent
  // re-bounces on the next successful sync.
  store.setAnalyticsConsentCurrent(true);
  store.setDiagnosticsConsentCurrent(true);
  // Device acks are the only evidence available here. Both present means this
  // user consented before, so consent surfaces must not use first-time
  // framing; absent evidence is indistinguishable from never-consented, and
  // the next successful sync corrects it either way.
  store.setHasConsentRecord(consent.tos && consent.privacy);
  syncOrganizationState(nextUserId);
  store.setConsentHydrated(true);
}

/**
 * Reconcile the lockfile's managed-assistant mirror and report whether the
 * platform API conclusively rejected the session (a settled 401/403/410 from
 * the org or assistants call). Only that settled evidence may end a platform
 * session; transport failures and other errors prove nothing (LUM-2412) and
 * leave cached lockfile data standing. Cloud mode loads assistants via
 * `reloadPlatformAssistants` (platform-assistants-sync), which has no
 * lockfile and stays outside this evidence rule.
 */
async function reconcilePlatformAssistants(
  syncIsCurrent?: () => boolean,
  sessionIsCurrent?: () => boolean,
): Promise<boolean> {
  try {
    // `sessionIsCurrent` is the looser gate: it stays true past the probe's
    // race timeout as long as no newer probe superseded this one, letting a
    // slow-but-successful org fetch for the still-active session commit
    // instead of stranding readiness. Destructive writes stay on the strict
    // `syncIsCurrent`.
    const orgOutcome = await useOrganizationStore
      .getState()
      .fetchOrganizations(syncIsCurrent, sessionIsCurrent);
    if (!orgOutcome.ok && orgOutcome.kind === "rejected") {
      return true;
    }
    const apiAssistants = await listAssistants();
    if (isSettledSessionRejection(apiAssistants)) {
      // The org fetch self-clears on its own rejection; an assistants-only
      // rejection must clear the org state too, or the request interceptor
      // keeps stamping the rejected account's Vellum-Organization-Id. The
      // currency guard matches the sync below: a timed-out or superseded
      // probe settled "present" from cached data, and its dangling call must
      // not strip the org header out from under that session.
      if (syncIsCurrent?.() ?? true) {
        useOrganizationStore.getState().clearOrganization();
      }
      return true;
    }
    if ((syncIsCurrent?.() ?? true) && apiAssistants.ok) {
      await syncPlatformAssistantsToLockfile(
        apiAssistants.data,
        useOrganizationStore.getState().currentOrganizationId ?? undefined,
        syncIsCurrent,
      );
    }
  } catch {
    // A throw is non-settled evidence: continue with cached lockfile data.
  }
  return false;
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
      if (isStale()) {
        return;
      }
      if (result.ok && result.data.user) {
        const probedUser = toAuthUser(result.data.user);
        // Sync platform assistants to the lockfile BEFORE setting
        // platformSession to "present". The auth middleware unblocks on
        // `platformSession !== "unknown"`, and hasAssistants() must
        // already reflect synced platform assistants at that point.
        // The whole sequence (org fetch, list, host replace) is bounded
        // to 3s so a hanging call can't block the probe from settling;
        // the middleware's 5s timeout would loop indefinitely otherwise.
        // The race does not cancel the inner branch, so the guard also
        // checks `timedOut`: once the probe settles without the sync, a
        // late commit must not land after routing decisions were made on
        // the un-synced lockfile. `!isStale()` likewise keeps a
        // superseded probe from committing an out-of-date lockfile.
        let sessionRejected = false;
        if (isLocalClient()) {
          let timedOut = false;
          const syncIsCurrent = (): boolean => !timedOut && !isStale();
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              (async () => {
                sessionRejected = await reconcilePlatformAssistants(
                  syncIsCurrent,
                  () => !isStale(),
                );
              })(),
              new Promise<never>((_, reject) => {
                timeoutHandle = setTimeout(() => {
                  timedOut = true;
                  reject(new Error("sync timeout"));
                }, 3_000);
              }),
            ]);
          } catch {
            // Sync failed or timed out; continue with cached lockfile data
          } finally {
            clearTimeout(timeoutHandle);
          }
        }
        if (isStale()) {
          return;
        }
        if (sessionRejected) {
          // The platform API conclusively rejected the allauth-confirmed
          // credential: settle absent, install no user, and drop the snapshot
          // so `restoreOfflineSession` cannot resurrect the account. Transport
          // failures and the race timeout never reach here (LUM-2412).
          clearUserSnapshot();
          const demotion = isAuthenticated(
            useAuthStore.getState().sessionStatus,
          )
            ? authenticatedLocalUser()
            : {};
          set({
            ...demotion,
            platformSession: "absent",
            platformSessionRestoredOffline: false,
          });
          return;
        }
        const userUpdate = options.setUserOnSuccess ? { user: probedUser } : {};
        // Adopting the probed user confirms a platform session outside the
        // `authenticatedPlatformUser` transition, so persist here too to feed
        // the local-mode offline restore (LUM-2412).
        if (options.setUserOnSuccess) {
          persistUserSnapshot(probedUser);
        }
        set({
          platformSession: "present",
          platformSessionRestoredOffline: false,
          ...userUpdate,
        });
        bootstrapLocalAssistantPlatformIdentity();
      } else if (options.clearOnFailure) {
        set({ platformSession: "absent" });
      }
    })
    .catch(() => {
      if (isStale()) {
        return;
      }
      if (options.clearOnFailure) {
        set({ platformSession: "absent" });
      }
    })
    .finally(() => {
      if (isStale()) {
        return;
      }
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
  if (
    !isLocalClient() ||
    isGatewayAuthEnabled() ||
    getPlatformAssistants().length > 0
  ) {
    probePlatformSession(set, options);
  } else {
    set({ platformSession: "absent" });
  }
}

/**
 * Shared tail of the interactive connect actions, run after the target's
 * gateway connection is primed: select the assistant, mark the session logged
 * in, and drive `checkAssistant()` so the active id republishes even when the
 * selection is unchanged (the selection subscription only fires on a change).
 */
async function establishLocalUserSession(
  set: AuthSet,
  assistantId: string,
): Promise<void> {
  await setSelectedAssistant(assistantId);
  set(authenticatedLocalUser());
  await lifecycleService.checkAssistant();
}

async function hasRemoteGatewaySessionAfterRefresh(): Promise<boolean> {
  try {
    if (await refreshRemoteGatewaySession()) {
      return true;
    }
  } catch {
    // A network failure says nothing about an already-valid in-memory token.
  }
  return getGatewayToken() !== null;
}

const useAuthStoreBase = create<AuthStore>()((set, get) => ({
  sessionStatus: "initializing",
  user: null,
  platformSession: "unknown",
  platformSessionRestoredOffline: false,

  // Deliberately not guarded by `logoutGeneration`, unlike `refreshSession`.
  // Its two callers can't overlap a logout: the boot path runs before any
  // signed-in surface exists to press Log Out on, and the platform loopback
  // page runs it from the logged-out login flow as the commit step of a
  // deliberate sign-in: a decision, which the guard exists to protect, rather
  // than an observation the guard should be able to discard.
  initSession: async () => {
    if (isRemoteGatewayMode()) {
      if (await hasRemoteGatewaySessionAfterRefresh()) {
        set({ ...authenticatedLocalUser(), platformSession: "absent" });
      } else {
        await endSession(set);
      }
      return;
    }

    if (isGatewayAuthEnabled()) {
      try {
        // Ride out the gateway's startup window: on reboot the gateway restarts
        // concurrently with the app and answers the mint with a transient
        // "starting" 503 for a few seconds. A single prime there would drop the
        // session to unauthenticated and surface the recovery controls for an
        // assistant that reconnects on its own moments later. Still no `wake` —
        // app launch must not spawn daemon processes.
        await primeLocalGatewayConnectionWithStartupRetry();
        set(authenticatedLocalUser());
      } catch {
        // Gateway prime failed: settle to unauthenticated but leave
        // `platformSession` for the follow-up probe to resolve.
        await endSession(set, { keepPlatformSession: true });
      }
      probePlatformSessionIfReachable(set);
      return;
    }

    if (isLocalClient() && !isGatewayAuthEnabled()) {
      const hasPlatformAssistants = getPlatformAssistants().length > 0;
      if (hasPlatformAssistants) {
        // Platform assistants require a valid session — await the check
        // so the auth middleware can redirect to login if it fails.
        let result: Awaited<ReturnType<typeof getSession>> | null = null;
        try {
          result = await getSession();
          if (result.ok && result.data.user) {
            const user = toAuthUser(result.data.user);
            // Re-sync platform assistants to remove stale lockfile entries.
            // The rejection evidence gates the user-scoped sync: a rejected
            // account's consent and org state must not be (re)installed.
            const sessionRejected = await reconcilePlatformAssistants();
            if (!sessionRejected) {
              await syncUserScopedState(user?.id ?? null);
              set(authenticatedPlatformUser(user));
              return;
            }
            // A settled org/assistants rejection falls through to the
            // settled-answer handling (login), never the offline restore.
          }
        } catch {
          // Thrown fetch — classified as a transport failure below.
        }
        // Offline boot with a still-valid local credential must not bounce
        // to the login screen (LUM-2412); only a settled "no session"
        // answer ends the session (and invalidates the snapshot).
        if (isInconclusiveProbe(result)) {
          if (await restoreOfflineSession(set)) {
            return;
          }
        } else {
          clearUserSnapshot();
        }
        await endSession(set);
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
        // The resolved assistants list is loaded by the platform-session
        // subscription (setupPlatformAssistantsSync), which fires when the
        // transition below flips `platformSession` to "present".
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
            // The resolved assistants list loads via the platform-session
            // subscription (setupPlatformAssistantsSync) when the transition
            // below flips `platformSession` to "present".
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
    if (!isInconclusiveProbe(result)) {
      clearUserSnapshot();
    }
    await endSession(set);
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
    await establishLocalUserSession(set, assistantId);
    if (
      isConfirmedPlatformSession(
        get().platformSession,
        get().platformSessionRestoredOffline,
      )
    ) {
      bootstrapLocalAssistantPlatformIdentity(assistantId);
    }
    probePlatformSessionIfReachable(set);
  },

  /**
   * Connect to a paired assistant: a remote machine's assistant imported via
   * `vellum connect import`. Primes the host-authorized proxy connection,
   * selects the assistant, and marks the session
   * logged in, mirroring {@link AuthActions.connectLocalAssistant} with two
   * deliberate differences: it primes through the plain
   * `primeLocalGatewayConnection` because `wake` cannot start or repair an
   * assistant on a remote machine, and it skips
   * `bootstrapLocalAssistantPlatformIdentity` because that registers a LOCAL
   * assistant with the platform while a paired entry is only a client-side
   * pairing record.
   */
  connectPairedAssistant: async (assistantId: string) => {
    const target = getLockfileAssistant(assistantId);
    if (!target || !isPairedAssistant(target)) {
      throw new Error("Not a paired assistant");
    }
    await primeLocalGatewayConnection(target);
    await establishLocalUserSession(set, assistantId);
    probePlatformSessionIfReachable(set);
  },

  connectPlatformAssistant: async (assistantId: string) => {
    const result = await getSession();
    if (!result.ok || !result.data.user) {
      throw new Error("Platform authentication required");
    }
    const user = toAuthUser(result.data.user);
    // Hydrate the organizations to avoid race conditions from lazy fetch; a
    // settled rejection fails the connect before the assistant selection and
    // user-scoped sync below, so a caller that catches the error keeps its
    // current selection and consent state rather than the rejected
    // account's.
    const orgOutcome = await useOrganizationStore
      .getState()
      .fetchOrganizations();
    if (!orgOutcome.ok && orgOutcome.kind === "rejected") {
      throw new Error("Platform authentication required");
    }
    await setSelectedAssistant(assistantId);
    await syncUserScopedState(user?.id ?? null);
    set(authenticatedPlatformUser(user));
  },

  refreshSession: async () => {
    // Captured before the first await. This action is an *observation* of the
    // session, and an explicit logout taken while it is suspended supersedes
    // it: the response it is carrying describes credentials that logout has
    // since dropped. Every authenticated write below re-checks the snapshot
    // and abandons itself on a mismatch; see `logoutGeneration`. Session-
    // ending writes need no check, because they agree with the logout.
    const generation = logoutGeneration;
    const supersededByLogout = (): boolean => logoutGeneration !== generation;
    // Report the session as the store now holds it rather than as this
    // superseded response describes it, mirroring the inconclusive-probe
    // branch below, so no caller reads an abandoned refresh as a verdict.
    const abandon = (): boolean => isAuthenticated(get().sessionStatus);

    if (isRemoteGatewayMode()) {
      if (await hasRemoteGatewaySessionAfterRefresh()) {
        if (supersededByLogout()) {
          return abandon();
        }
        set({ ...authenticatedLocalUser(), platformSession: "absent" });
        return true;
      }
      await endSession(set);
      return false;
    }

    if (isGatewayAuthMode()) {
      try {
        const selected = getSelectedAssistant();
        if (selected && isPairedAssistant(selected)) {
          // A paired selection uses its host-authorized proxy and has no
          // renderer gateway token. `getLocalTokenUrl()` is undefined for it,
          // so `ensureGatewayToken` would target the SPA origin's unrelated
          // `/auth/token` route.
          await primeLocalGatewayConnection(selected);
        } else {
          await ensureGatewayToken(getLocalTokenUrl());
        }
        if (supersededByLogout()) {
          // Abandon the platform probe below too: launching it would settle
          // `platformSession` from the session the logout just ended.
          return abandon();
        }
        set(enteringAuthenticatedSession({ sessionStatus: "authenticated" }));
      } catch {
        await endSession(set);
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
        // Reconcile the lockfile mirror on refresh too, not just cold
        // `initSession`: app resume, profile save, and the provider callback
        // all route through here, and the macOS tray and CLI would otherwise
        // keep a stale managed-assistant list until the next full boot.
        // Local-mode only (platform mode has no lockfile host). The rejection
        // evidence gates the user-scoped sync: a rejected account's consent
        // and org state must not be (re)installed before the demotion below.
        const sessionRejected = isLocalClient()
          ? await reconcilePlatformAssistants()
          : false;
        if (!sessionRejected) {
          // Checked on both sides of the sync: the first check keeps a logout
          // that landed during the reconcile from re-installing the departed
          // account's consent and organization state, and the second covers a
          // logout that landed during the sync itself, whose fetch is the
          // longest await on this path.
          if (supersededByLogout()) {
            return abandon();
          }
          await syncUserScopedState(user?.id ?? null);
          if (supersededByLogout()) {
            return abandon();
          }
          set(authenticatedPlatformUser(user));
          return true;
        }
        // A settled org/assistants rejection is a rejected session even
        // though allauth answered 200: fall through to the settled-rejection
        // handling below, same as a settled getSession 401.
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
    // A settled "no platform session" (401) ends the platform session, not the
    // local one. Demote an authenticated session to the local user and mark the
    // platform session absent, dropping the stale platform user and offline
    // snapshot so platform-gated surfaces stop treating it as signed in, while
    // keeping `sessionStatus` "authenticated": a 401 must not log a local-only
    // user out. (The successful probe above still adopts the platform user, so
    // provider sign-in keeps working.) An unauthenticated session, e.g. mid
    // cold-start hatch, is left for the gateway to settle once its token mints.
    //
    // Holding `sessionStatus` "authenticated" is load-bearing: in-app consumers
    // read `useIsAuthenticated()` directly to scope the QueryClient cache and
    // gate signed-in UI, so ending the session would drop them into the
    // anonymous cache scope and hide that UI.
    //
    // The predicate asks whether the local session can stand on its own,
    // mirroring how `initSession` branches: a local gateway answers for itself,
    // and so does a client with no platform assistant to reach. A local client
    // whose assistants are platform-hosted is excluded, since a managed
    // assistant is unreachable without a platform session and routing to login
    // beats stranding the user beside one that cannot answer. Remote-gateway
    // mode returns at the top of this action.
    //
    // The demotion needs no `supersededByLogout` check: it writes only when
    // the store still reads authenticated, which a completed logout has
    // already made false.
    const localSessionStandsAlone =
      isLocalClient() &&
      (isGatewayAuthEnabled() || getPlatformAssistants().length === 0);
    if (localSessionStandsAlone) {
      const wasAuthenticated = isAuthenticated(get().sessionStatus);
      if (wasAuthenticated) {
        clearUserSnapshot();
        set({ ...authenticatedLocalUser(), platformSession: "absent" });
      }
      return wasAuthenticated;
    }
    clearUserSnapshot();
    await syncUserScopedState(null);
    await endSession(set);
    return false;
  },

  logout: async () => {
    // Bumped before anything else: the steps below drop the credentials, the
    // selection, the organization and the user-scoped storage, and a refresh
    // that resumes partway through would otherwise re-persist the departing
    // user's snapshot and consent on its way to an authenticated write.
    logoutGeneration += 1;
    if (isGatewayAuthMode()) {
      // Clear lifecycle state BEFORE `sessionStatus` leaves `authenticated`
      // so the assistant sync hooks don't observe a stale assistant id in
      // their first re-render, and BEFORE the selection clear so the
      // lifecycle's selection subscription (guarded on `loading`) doesn't
      // resurrect an active state mid-logout. The `respondToInputs`
      // not-authenticated branch is the safety net for token-expiry-style
      // flips.
      lifecycleService.resetForLogout();
      setSelfHostedConnection(null);
      await setSelectedAssistant(null);
      clearGatewayToken();
      clearOrganization();
      clearUserScopedStorage();
      await endSession(set, { authoritative: true });
      // Bumped again now the session has ended: a refresh that entered partway
      // through this logout captured the first bump, and its response is just
      // as stale as one captured before it.
      logoutGeneration += 1;
      broadcastAuthChange();
      return;
    }

    suppressPlatformProbe = true;
    // Delete the APNs device token from the platform BEFORE clearing the
    // session — the platform delete is authenticated by the still-valid
    // session cookie. No-ops off native iOS. Best-effort: never blocks logout.
    await unregisterFromRemotePush();
    // Same window, same reason: a Live Activity registered for a voice session
    // outlives the session that owns it unless something retires it, and after
    // logout there is no authenticated request left that could.
    await unregisterLiveActivityPushToken();
    try {
      await allauthLogout();
    } finally {
      // Clean up session token in the main process.
      if (isElectron()) {
        await window.vellum?.auth?.signOut?.();
      }
      // Web loopback: drop the token the local server's proxy authenticates with.
      if (isLocalClient() && !isElectron()) {
        await clearLocalPlatformSession();
      }
      void deleteBiometricToken();
      clearOrganization();
      clearUserScopedStorage();
      lifecycleService.resetForLogout();
      // Clear the selection slice too — `clearUserScopedStorage` already
      // removed the persisted key, and a surviving slice would resolve the
      // previous user's assistant after re-login.
      await setSelectedAssistant(null);
      await endSession(set, { authoritative: true });
      // See the gateway branch: the second bump also supersedes a refresh that
      // entered partway through this logout.
      logoutGeneration += 1;
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
 * Reactive: the platform-session probe has settled (`platformSession` is no
 * longer `"unknown"`). Gate behavior that must not act on the pre-settle
 * window — where {@link useHasPlatformSession} still reads `false` for a
 * session that will resolve to `"present"` — on this rather than on
 * {@link useIsSessionInitializing}, which can clear first.
 */
export const useIsPlatformSessionSettled = (): boolean =>
  isPlatformSessionSettled(useAuthStore.use.platformSession());

/**
 * A platform session a live probe confirmed — excludes the believed offline
 * restore (LUM-2412). Telemetry consent gates on this, not the routing-oriented
 * {@link useHasPlatformSession}, so it never enables offline.
 */
export const useHasConfirmedPlatformSession = (): boolean =>
  isConfirmedPlatformSession(
    useAuthStore.use.platformSession(),
    useAuthStore.use.platformSessionRestoredOffline(),
  );

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
    if (isOAuthFlowInFlight()) {
      return;
    }
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
