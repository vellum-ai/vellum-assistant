/**
 * Which provider connections dispatch through a given credential.
 *
 * Deleting a credential silently breaks every connection that resolves its
 * auth through it, so the delete surfaces ask this before removing anything.
 */

import { getDb } from "../../persistence/db-connection.js";
import { normalizeCredentialRef } from "../../security/credential-key.js";
import { listConnections } from "./connections.js";

/**
 * Names of the provider connections whose auth resolves to
 * `credentialAccount`, sorted for a stable message.
 *
 * Both sides are run through `normalizeCredentialRef` so a row storing the
 * short `openrouter:api_key` form matches the canonical
 * `credential/openrouter/api_key` account. Auth variants without a credential
 * (`platform`, `none`) reference no account and never match.
 *
 * Read failures propagate: a caller that cannot enumerate the dependants must
 * refuse the delete rather than treat the credential as unused, which is the
 * exact silent breakage this check exists to prevent.
 */
export function findConnectionsUsingCredential(
  credentialAccount: string,
): string[] {
  const account = normalizeCredentialRef(credentialAccount);
  return listConnections(getDb())
    .filter(
      (connection) =>
        "credential" in connection.auth &&
        normalizeCredentialRef(connection.auth.credential) === account,
    )
    .map((connection) => connection.name)
    .sort();
}
