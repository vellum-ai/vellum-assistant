import type { Logger } from "pino";
import type { CredentialCache } from "./credential-cache.js";

/**
 * Resolve a credential from the cache, force-refreshing once when the
 * cached read comes back empty — the credential may have been written
 * after the TTL cache was last populated.
 */
export async function resolveCredentialWithRefresh(
  credentials: CredentialCache | undefined,
  key: string,
): Promise<string | undefined> {
  if (!credentials) {
    return undefined;
  }
  const value = await credentials.get(key);
  if (value) {
    return value;
  }
  return credentials.get(key, { force: true });
}

/**
 * Verify a webhook secret with a one-shot forced-refresh retry: verify
 * against the cached secret first, and when that fails re-fetch the
 * secret (bypassing the TTL cache) and retry once — the stored secret
 * may have rotated since the cache was last populated.
 *
 * `label` names the check in the refresh-success log line, e.g.
 * "Telegram webhook secret" logs "Telegram webhook secret verified
 * after forced credential refresh".
 */
export async function verifySecretWithRefresh(opts: {
  credentials: CredentialCache | undefined;
  key: string;
  verify: (secret: string) => boolean;
  log: Logger;
  label: string;
}): Promise<boolean> {
  const { credentials, key, verify, log, label } = opts;
  if (!credentials) {
    return false;
  }

  const secret = await credentials.get(key);
  if (secret && verify(secret)) {
    return true;
  }

  const fresh = await credentials.get(key, { force: true });
  if (!fresh) {
    return false;
  }
  const valid = verify(fresh);
  if (valid) {
    log.info(`${label} verified after forced credential refresh`);
  }
  return valid;
}
