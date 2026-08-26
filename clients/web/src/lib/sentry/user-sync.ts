/**
 * Mirrors the signed-in user into the Sentry scope so issues report how
 * many distinct users they hit, the primary ranking signal for triage.
 *
 * Only a stable, non-PII identifier is sent: the platform account id for
 * platform sessions, and the per-install device id for local gateway
 * sessions (every local session shares the synthetic `gateway-local`
 * account id, which would otherwise collapse all local users into one).
 * Name and email stay out of the scope; Sentry's server-side scrubbing
 * and the consent gate are unaffected.
 *
 * Consent is enforced by the client lifecycle, not here: `sentry-control`
 * initializes a client only under the composed diagnostics gate, and a
 * scope user without a client transmits nothing. Setting the scope before
 * or after the client exists both work, so this module only has to track
 * the auth store.
 *
 * Reference: https://docs.sentry.io/platforms/javascript/enriching-events/identify-user/
 */
import { selectSentryFlavor } from "@/lib/sentry/flavor";
import { getDeviceId } from "@/runtime/device-id";
import { type AuthUser, useAuthStore } from "@/stores/auth-store";

function toSentryUser(user: AuthUser | null): { id: string } | null {
  if (!user) {
    return null;
  }
  if (user.kind === "local") {
    const deviceId = getDeviceId();
    const id = deviceId ?? user.id;
    return id ? { id } : null;
  }
  // `resolveUserId` in the auth store falls back `id ?? email ?? username`
  // when the session payload omits the account id. An identifier equal to
  // either of those is PII whatever its provenance, so the session goes
  // unidentified rather than identified by an email address.
  const { id } = user;
  if (!id || id === user.email || id === user.username) {
    return null;
  }
  return { id };
}

/**
 * Stamp the current user and follow the auth store. Returns a cleanup
 * function that stops following (the scope keeps its last value; sign-out
 * itself flows through the subscription as `user: null`).
 */
export function installSentryUserSync(): () => void {
  const apply = (user: AuthUser | null): void => {
    selectSentryFlavor().setUser(toSentryUser(user));
  };
  apply(useAuthStore.getState().user);
  return useAuthStore.subscribe((state, prevState) => {
    if (state.user !== prevState.user) {
      apply(state.user);
    }
  });
}
