/**
 * Session state as discriminated unions, plus the pure predicates that answer
 * each session-state question in one place.
 *
 * This module is intentionally dependency-free at runtime: it imports no
 * runtime values, so any module — including ones the auth store itself depends
 * on (e.g. the assistant lifecycle service) — can read session meaning without
 * creating an import cycle through the store. The lone `import type` of
 * `AuthUser` is erased at compile time, so it introduces no runtime edge.
 *
 * Imperative readers (middleware, lifecycle, route resolvers) call these
 * predicates directly with a status value. Reactive components read the
 * matching hooks (`useIsAuthenticated`, `useHasPlatformSession`) from the auth
 * store, which compose these predicates over the store's atomic selectors.
 */
import type { AuthUser } from "@/stores/auth-store";

/**
 * Platform-session liveness as a single tri-state.
 *
 * - `"unknown"`: the probe has not settled yet. The local gateway path leaves
 *   `sessionStatus: "authenticated"` before `getSession()` returns, so there is
 *   a window where logged-in status is known but session liveness is not. Imperative
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

/**
 * Session lifecycle as a single discriminated state, not a pair of booleans.
 *
 * - `"initializing"`: the boot probe has not settled — logged-in status is not
 *   yet known. Reactive consumers should treat this as "not authenticated"
 *   without redirecting; imperative guards wait it out.
 * - `"authenticated"`: a user is signed in (platform or local gateway).
 * - `"unauthenticated"`: the probe settled with no session.
 *
 * Modeling this as one value makes the contradictory `(isLoggedIn: true,
 * isLoading: true)` state — "logged in but still loading" — unrepresentable,
 * the same illegal-state-elimination this store applies to `platformSession`.
 */
export type SessionStatus = "initializing" | "authenticated" | "unauthenticated";

/**
 * Read predicates — the single place each session-state question is answered.
 *
 * Consumers read meaning (`isAuthenticated(status)` / `hasLivePlatformSession`)
 * instead of re-encoding the enum literals (`=== "authenticated"`,
 * `=== "present"`) at every call site, so the encoding never leaks into readers.
 */
export const isAuthenticated = (status: SessionStatus): boolean =>
  status === "authenticated";

/** The boot probe has settled — `sessionStatus` left the `initializing` window. */
export const isSessionSettled = (status: SessionStatus): boolean =>
  status !== "initializing";

/** A live platform session has been confirmed by the probe. */
export const hasLivePlatformSession = (
  status: PlatformSessionStatus,
): boolean => status === "present";

/**
 * Is this a real platform account, not local gateway access? The local gateway
 * user is a synthetic, platform-shaped identity, so read the `kind` discriminator
 * rather than treating any non-null user as a platform account.
 */
export const isPlatformIdentity = (user: AuthUser | null): boolean =>
  user?.kind === "platform";

/**
 * The two orthogonal authorities behind app access: a real platform identity OR
 * the ability to reach the selected assistant. Either alone grants access — a
 * local-only user has no identity but is gateway-reachable; a platform user with
 * a live session has access regardless of the selected assistant.
 */
export interface AppAccessSignals {
  hasPlatformIdentity: boolean;
  canReachSelected: boolean;
}

/**
 * Does the user have access to the app? True with a real platform identity OR a
 * reachable selected assistant — the orthogonal "identity vs connection" gate,
 * so a platform-session loss can't lock out a local user who can still reach
 * their assistant.
 */
export const hasAppAccess = (s: AppAccessSignals): boolean =>
  s.hasPlatformIdentity || s.canReachSelected;

/**
 * A platform session a live probe confirmed — `"present"` AND not a believed
 * offline restore (LUM-2412). Stricter than {@link hasLivePlatformSession}:
 * telemetry consent gates on this so it never enables on a restored-offline
 * launch that no live probe has revalidated.
 */
export const isConfirmedPlatformSession = (
  status: PlatformSessionStatus,
  restoredOffline: boolean,
): boolean => status === "present" && !restoredOffline;

/**
 * Statuses where the server itself said "no session": allauth's 401 for
 * an unauthenticated probe, a 403, or 410 Gone (session invalidated).
 */
const SETTLED_SESSION_REJECTION_STATUSES = new Set([401, 403, 410]);

/**
 * A settled negative answer from a session check — the only failures
 * allowed to end the session. Everything else that isn't ok says nothing
 * about the session and must be treated as non-authoritative (LUM-2412):
 * a request that never completed (`status` undefined), rate limiting
 * (429), and gateway/outage 5xx including the Electron platform proxy's
 * synthesized offline 502 (`proxy_network_error` — see
 * `clients/macos/src/main/platform-forward.ts`). A session check that
 * throws outright (fetch rejection) is classified the same way by
 * callers.
 *
 * Structural parameter type (not `AllauthResult`) keeps this module
 * dependency-free per the header note.
 */
export const isSettledSessionRejection = (result: {
  ok: boolean;
  status?: number;
}): boolean =>
  !result.ok &&
  result.status !== undefined &&
  SETTLED_SESSION_REJECTION_STATUSES.has(result.status);
