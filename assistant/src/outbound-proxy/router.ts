/**
 * Hybrid proxy router -- decides per-CONNECT request whether to MITM-intercept
 * (for credential injection) or use a plain CONNECT tunnel (no rewrite needed).
 *
 * The router checks whether any credential injection template matches the
 * target hostname. Only when a credential rewrite is required does the proxy
 * pay the cost of TLS termination, cert issuance, and request rewriting.
 */

import type { CredentialInjectionTemplate } from "@vellumai/egress-proxy";

import { matchHostPattern } from "./host-pattern-match.js";

// ---- Public types ----------------------------------------------------------

/** Deterministic reason codes for auditing and testing. */
export type RouteReason =
  | "mitm:credential_injection"
  | "tunnel:no_rewrite"
  | "tunnel:no_credentials";

export interface RouteDecision {
  action: "mitm" | "tunnel";
  reason: RouteReason;
}

// ---- Router ----------------------------------------------------------------

/**
 * Decide whether a CONNECT target requires MITM interception.
 *
 * @param hostname       Target hostname (e.g. "api.fal.ai")
 * @param _port          Target port -- reserved for future port-level rules
 * @param credentialIds  Credential IDs the session is authorized to use
 * @param templates      Map from credentialId to injection templates
 */
export function routeConnection(
  hostname: string,
  _port: number,
  credentialIds: string[],
  templates: ReadonlyMap<string, readonly CredentialInjectionTemplate[]>,
): RouteDecision {
  // No credentials configured -- nothing to inject, tunnel through.
  if (credentialIds.length === 0) {
    return { action: "tunnel", reason: "tunnel:no_credentials" };
  }

  for (const id of credentialIds) {
    const tpls = templates.get(id);
    if (!tpls) continue;

    for (const tpl of tpls) {
      if (
        matchHostPattern(hostname, tpl.hostPattern, {
          includeApexForWildcard: true,
        }) !== "none"
      ) {
        return { action: "mitm", reason: "mitm:credential_injection" };
      }
    }
  }

  // Credentials exist but none match this host -- no rewrite needed.
  return { action: "tunnel", reason: "tunnel:no_rewrite" };
}
