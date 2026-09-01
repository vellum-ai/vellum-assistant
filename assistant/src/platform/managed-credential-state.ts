/**
 * Last known verdict on the Vellum-managed assistant API key.
 *
 * The assistant cannot mint this credential. The platform issues it and a
 * signed-in client writes it in, so when it stops authenticating the only
 * exit is for a client to rotate it. That makes the verdict a thing several
 * surfaces need to agree on: `platform status` and connection availability
 * report it, and the client bootstrap decides whether to rotate from it.
 *
 * Two writers, both settled observations rather than guesses:
 *   - the credential health check, which asks the platform directly;
 *   - managed inference, which learns it the hard way when a call is
 *     rejected mid-turn.
 *
 * The second is what keeps the verdict fresh between health checks: a key
 * that dies right after a check would otherwise read healthy until the next
 * one. Readers get the last settled answer with no network call of their own.
 *
 * Deliberately in-process and not persisted. The verdict is an observation
 * about a live credential, not a fact about the workspace, and a restart
 * re-derives it from the next check or the next call. Persisting it would
 * add a stale-on-restore failure mode (a rotated key still recorded as
 * rejected) in exchange for nothing a re-check does not supply.
 */

export type ManagedCredentialVerdict = "valid" | "rejected" | "unknown";

interface ManagedCredentialState {
  verdict: ManagedCredentialVerdict;
  observedAt: number;
}

let state: ManagedCredentialState = { verdict: "unknown", observedAt: 0 };

/**
 * Record a settled observation about the managed credential.
 *
 * Callers must pass `"rejected"` only for a conclusive rejection by the
 * platform (a 401/403 answer), never for a transport failure or a server
 * error. A rejection drives a key rotation, so an unsettled failure recorded
 * as one would replace a working credential for no reason. Pass `"unknown"`
 * for those instead, which reads as "not established" and drives nothing.
 */
export function recordManagedCredentialVerdict(
  verdict: ManagedCredentialVerdict,
): void {
  // `unknown` is a failed observation, not evidence that a rejected
  // credential recovered. Letting it overwrite a settled rejection would
  // report a dead credential as merely unestablished the first time the
  // platform is unreachable, and every surface reading this would stop
  // treating it as broken. A settled answer replaces anything; an unsettled
  // one only fills a slot nothing has answered yet.
  if (verdict === "unknown" && state.verdict !== "unknown") {
    return;
  }
  state = { verdict, observedAt: Date.now() };
}

/**
 * The last settled verdict, or `"unknown"` when nothing has observed the
 * credential yet (a fresh daemon that has not run a health check or served a
 * managed call). `observedAt` is 0 in that case.
 */
export function getManagedCredentialVerdict(): ManagedCredentialState {
  return state;
}

/**
 * Drop the recorded verdict.
 *
 * Called when the stored credential is replaced: the verdict described the
 * previous value, so keeping it would report a freshly written key as
 * rejected. The next check or call establishes the new one.
 */
export function clearManagedCredentialVerdict(): void {
  state = { verdict: "unknown", observedAt: 0 };
}
