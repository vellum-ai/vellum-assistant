/**
 * Which trust classes a route admits, shared by the daemon's HTTP router and
 * the gateway's IPC proxy so both enforcement points apply one rule.
 *
 * A route policy's `allowedTrustClasses` reaches the gateway on the IPC route
 * schema as plain strings, and is absent from a null policy or a schema served
 * by a daemon that predates the field. Absent means guardian only.
 */

import { isTrustClass, type TrustClass } from "./trust-verdict-contract.js";

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
 * Whether a caller holding a contact-role token may reach a route admitting
 * `allowedTrustClasses`.
 *
 * A contact token never speaks for the guardian, so a route admitting no other
 * class refuses it without calling `resolveTrustClass`. Otherwise the resolved
 * class must be one the route admits and must not be `guardian`. A resolver
 * that throws or resolves nothing refuses.
 */
export async function contactTokenMayReachRoute(
  allowedTrustClasses: readonly string[] | undefined,
  resolveTrustClass: () => Promise<string | undefined>,
): Promise<boolean> {
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
