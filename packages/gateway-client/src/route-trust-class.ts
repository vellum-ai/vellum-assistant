/**
 * Which trust classes a route admits, shared by the daemon's HTTP router and
 * the gateway's IPC proxy so both enforcement points apply one rule.
 *
 * A route policy's `allowedTrustClasses` reaches the gateway on the IPC route
 * schema as plain strings, and is absent from a null policy or a schema served
 * by a daemon that predates the field. Absent means guardian only.
 */

import { isTrustClass, type TrustClass } from "./trust-verdict-contract.js";

/**
 * Scope profiles whose holders are not trust-checked: the guardian's own
 * client, and service, local and single-route grants that route policy
 * already governs. Any profile not listed here is trust-checked, so an
 * unknown or newly added profile fails closed until it is judged exempt.
 */
export const TRUST_EXEMPT_SCOPE_PROFILES: readonly string[] = [
  "actor_client_v1",
  "gateway_ingress_v1",
  "gateway_service_v1",
  "local_v1",
  "oauth_proxy_v1",
  "speech_relay_v1",
  "ui_page_v1",
];

const TRUST_EXEMPT_SET: ReadonlySet<string> = new Set(
  TRUST_EXEMPT_SCOPE_PROFILES,
);

/**
 * True when a token of `profile` reaches a route only if the route admits
 * its holder's trust class.
 */
export function isTrustCheckedScopeProfile(profile: string): boolean {
  return !TRUST_EXEMPT_SET.has(profile);
}

/** Trust classes a route admits when its policy names none. */
export const DEFAULT_ROUTE_TRUST_CLASSES: readonly TrustClass[] = ["guardian"];

/**
 * Whether a route admitting `allowedTrustClasses` admits a caller of
 * `trustClass`. A value outside the vocabulary is refused, since a wire-sourced
 * class can carry anything.
 */
export function routeAdmitsTrustClass(
  allowedTrustClasses: readonly string[] | undefined,
  trustClass: string | undefined,
): boolean {
  if (typeof trustClass !== "string" || !isTrustClass(trustClass)) {
    return false;
  }
  return (allowedTrustClasses ?? DEFAULT_ROUTE_TRUST_CLASSES).includes(
    trustClass,
  );
}

/**
 * Whether a caller whose token carries `scopeProfile` may reach a route
 * admitting `allowedTrustClasses`.
 *
 * A trust-exempt profile stands for the guardian, so it reaches exactly the
 * routes that admit `guardian`, with no lookup. That is every route naming no
 * classes.
 *
 * A trust-checked token never speaks for the guardian, so a route admitting no
 * other class refuses it without calling `resolveTrustClass`. Otherwise the
 * resolved class must be one the route admits and must not be `guardian`. A
 * resolver that throws or resolves nothing refuses.
 */
export async function tokenMayReachRoute(
  scopeProfile: string,
  allowedTrustClasses: readonly string[] | undefined,
  resolveTrustClass: () => Promise<string | undefined>,
): Promise<boolean> {
  if (!isTrustCheckedScopeProfile(scopeProfile)) {
    return routeAdmitsTrustClass(allowedTrustClasses, "guardian");
  }
  const allowed = allowedTrustClasses ?? DEFAULT_ROUTE_TRUST_CLASSES;
  if (!allowed.some((trustClass) => trustClass !== "guardian")) {
    return false;
  }
  let trustClass: string | undefined;
  try {
    trustClass = await resolveTrustClass();
  } catch {
    return false;
  }
  return (
    trustClass !== "guardian" && routeAdmitsTrustClass(allowed, trustClass)
  );
}
