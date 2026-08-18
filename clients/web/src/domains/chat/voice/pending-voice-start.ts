/**
 * One-shot handoff for a voice start requested from a route that mounts no
 * chat composer (Settings, Library, the app viewer).
 *
 * The composer owns the guarded entry flow, so the shortcut records the
 * request and navigates to the conversation surface; the composer drains the
 * request as it registers. Mirrors `composer-focus`'s pending-focus drain,
 * which solves the same problem: the consumer does not exist at the moment
 * the request is made.
 *
 * The request expires, so one that never reaches a composer (an assistant
 * without live voice, a navigation the user turns away from) cannot open a
 * session much later, when it would read as the app acting on its own.
 */
const REQUEST_TTL_MS = 10_000;

let requestedAt: number | null = null;

export function requestVoiceModeStart(): void {
  requestedAt = Date.now();
}

/** Returns and clears the pending request in one step. */
export function consumePendingVoiceModeStart(): boolean {
  if (requestedAt === null) {
    return false;
  }
  const fresh = Date.now() - requestedAt < REQUEST_TTL_MS;
  requestedAt = null;
  return fresh;
}

/** Drop any pending request. Exposed for tests and teardown. */
export function clearPendingVoiceModeStart(): void {
  requestedAt = null;
}
