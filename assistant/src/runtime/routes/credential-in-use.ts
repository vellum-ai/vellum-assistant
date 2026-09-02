/**
 * Shared in-use guard for the credential-delete surfaces
 * (`POST /v1/credentials/delete` and `DELETE /v1/secrets`).
 *
 * A credential removed while an LLM connection resolves its auth through it
 * takes that connection offline, so such a delete is refused until the caller
 * confirms it with `force`. Both surfaces run the same guard, so a protection on
 * only one of them is one a client can route around.
 */

import { findConnectionsUsingCredential } from "../../providers/inference/credential-usage.js";
import { clearConnectionProviderCache } from "../../providers/registry.js";
import { getLogger } from "../../util/logger.js";
import { RouteError } from "./errors.js";

const log = getLogger("runtime/routes/credential-in-use");

/**
 * A credential is still referenced by at least one provider connection.
 *
 * Carries the dependent connection names in both the message and
 * `details.connections`, so a client can name them in its confirmation
 * prompt, and a distinct `code` so it can tell this refusal apart from an
 * ordinary bad request and offer the forced retry.
 */
export class CredentialInUseError extends RouteError {
  constructor(
    readonly connections: string[],
    message: string,
  ) {
    super(message, "CREDENTIAL_IN_USE", 400, { connections });
    this.name = "CredentialInUseError";
  }
}

/**
 * Refuse to delete `credentialAccount` while provider connections resolve
 * their auth through it, unless `force` is set. Returns the affected
 * connection names so the caller can invalidate what depended on them.
 *
 * The credential itself is never logged beyond its `credential/{service}/
 * {field}` account name, which holds no secret material.
 */
export function assertCredentialNotInUse(
  credentialAccount: string,
  force: boolean,
): string[] {
  const connections = findConnectionsUsingCredential(credentialAccount);
  if (connections.length === 0) {
    return connections;
  }
  if (!force) {
    const list = connections.map((name) => `"${name}"`).join(", ");
    throw new CredentialInUseError(
      connections,
      `Credential ${credentialAccount} is in use by ${
        connections.length === 1 ? "connection" : "connections"
      } ${list}. ${
        connections.length === 1 ? "It" : "They"
      } will stop working without it. Delete it anyway to continue.`,
    );
  }
  log.warn(
    { credential: credentialAccount, connections },
    "Force-deleting a credential that provider connections depend on. Those connections can no longer dispatch until a new credential is added",
  );
  return connections;
}

/**
 * Drop cached adapters built around a deleted credential so the next dispatch
 * re-resolves auth and reports the missing credential instead of replaying a
 * cached adapter holding the removed key.
 */
export function invalidateConnectionsAfterCredentialDelete(
  affectedConnections: string[],
): void {
  if (affectedConnections.length === 0) {
    return;
  }
  // The cache is keyed by connection + model + provider, so entries for one
  // connection are not addressable individually; clearing it costs the next
  // dispatch per connection one credential re-read.
  clearConnectionProviderCache();
}
