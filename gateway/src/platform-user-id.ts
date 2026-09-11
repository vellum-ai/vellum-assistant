/**
 * Bound platform owner id for managed-mode edge auth.
 *
 * The value is provisioned into the credential vault, but a vault outage
 * must not look like "no owner stored". Successful reads stick in memory
 * so health and feature-flag polls keep working while CES is down.
 */

import { credentialKey } from "./credential-key.js";
import { readCredentialResult } from "./credential-reader.js";
import { getLogger } from "./logger.js";

const log = getLogger("platform-user-id");

const PLATFORM_USER_ID_ACCOUNT = credentialKey("vellum", "platform_user_id");

let lastKnownPlatformUserId: string | undefined;

/** @internal Test-only: drop the sticky owner id. */
export function _resetLastKnownPlatformUserIdForTest(): void {
  lastKnownPlatformUserId = undefined;
}

export type StoredPlatformUserId = {
  userId: string | undefined;
  unreachable: boolean;
};

/**
 * Resolve the bound `platform_user_id`.
 *
 * `unreachable: true` only when the vault is down and no prior successful
 * read is cached. A cached owner is returned with `unreachable: false` so
 * callers keep treating the assistant as reachable.
 */
export async function readStoredPlatformUserId(): Promise<StoredPlatformUserId> {
  const result = await readCredentialResult(PLATFORM_USER_ID_ACCOUNT);
  if (result.unreachable) {
    if (lastKnownPlatformUserId) {
      log.warn("platform_user_id vault unreachable; using last known owner id");
      return { userId: lastKnownPlatformUserId, unreachable: false };
    }
    return { userId: undefined, unreachable: true };
  }

  lastKnownPlatformUserId = result.value;
  return { userId: result.value, unreachable: false };
}
