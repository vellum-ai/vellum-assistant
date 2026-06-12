/**
 * Session state as discriminated unions, plus the pure predicates that answer
 * each session-state question in one place.
 *
 * This module is intentionally dependency-free: it imports nothing, so any
 * module — including ones the auth store itself depends on (e.g. the assistant
 * lifecycle service) — can read session meaning without creating an import
 * cycle through the store. `import type` could not break that cycle because
 * the predicates are runtime values, not just types.
 *
 * Imperative readers (middleware, lifecycle, route resolvers) call these
 * predicates directly with a status value. Reactive components read the
 * matching hooks (`useIsAuthenticated`, `useHasPlatformSession`) from the auth
 * store, which compose these predicates over the store's atomic selectors.
 */

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
 * `apps/macos/src/main/platform-forward.ts`). A session check that
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
