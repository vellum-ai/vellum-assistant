/**
 * CES credential policy enforcement.
 *
 * Enforces credential-level policies (allowedTools, allowedDomains) that were
 * previously only checked by the pre-CES broker in the assistant daemon.
 * Without these checks, CES would materialise credentials that the broker
 * would have rejected — a security regression.
 *
 * Policy rules:
 * - **allowedDomains** — credentials with domain restrictions are scoped to
 *   browser use on those domains and cannot be used server-side by CES.
 * - **allowedTools** — if set (even if empty), only the listed tools may
 *   consume the credential. An empty array means deny-all. CES tool names
 *   ("make_authenticated_request", "run_authenticated_command") must be in
 *   the list.
 */

import type { StaticCredentialRecord } from "@vellumai/credential-storage";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface CredentialPolicyCheckResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Policy check
// ---------------------------------------------------------------------------

/**
 * Check credential-level policies before materialisation.
 *
 * Returns `{ ok: true }` if the credential may be materialised for the
 * given CES tool, or `{ ok: false, error }` with a human-readable
 * rejection message.
 *
 * @param metadata  Non-secret metadata record for a local static credential.
 * @param cesToolName  The CES tool requesting materialisation
 *   (e.g. "make_authenticated_request" or "run_authenticated_command").
 */
export function checkCredentialPolicy(
  metadata: StaticCredentialRecord,
  cesToolName: string,
): CredentialPolicyCheckResult {
  // -- allowedDomains -------------------------------------------------------
  // Credentials with domain restrictions are scoped to browser use on those
  // domains. They cannot be used for server-side operations through CES.
  if (metadata.allowedDomains && metadata.allowedDomains.length > 0) {
    return {
      ok: false,
      error:
        `Credential ${metadata.service}/${metadata.field} has domain restrictions ` +
        `(${metadata.allowedDomains.join(", ")}) and cannot be used for server-side ` +
        `operations through CES. Remove domain restrictions or use a separate credential.`,
    };
  }

  // -- allowedTools ---------------------------------------------------------
  // If set (even if empty), the CES tool must be in the allowed list.
  // An empty allowedTools array means no tools are permitted (deny-all).
  if (metadata.allowedTools) {
    if (!metadata.allowedTools.includes(cesToolName)) {
      return {
        ok: false,
        error:
          metadata.allowedTools.length === 0
            ? `Credential ${metadata.service}/${metadata.field} does not allow any tools.`
            : `Tool "${cesToolName}" is not allowed to use credential ` +
              `${metadata.service}/${metadata.field}. ` +
              `Allowed tools: ${metadata.allowedTools.join(", ")}.`,
      };
    }
  }

  return { ok: true };
}
