/**
 * Daemon-side reader for the guardian contact id(s), sourced from the gateway
 * DB (source of truth) via the `get_guardian_contact` IPC.
 *
 * Lets contact-serve paths determine the guardian without any local role
 * state (the local contact shape carries none). Result is cached with a
 * short TTL.
 *
 * FAIL-SOFT: a cache miss or IPC error returns an empty set and logs a warning;
 * this never throws (it runs on contact-serve paths).
 */

import { GetGuardianContactIpcResponseSchema } from "@vellumai/gateway-client/gateway-ipc-contracts";

import { ipcCallPersistent } from "../ipc/gateway-client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("guardian-contact-reader");

const CACHE_TTL_MS = 30_000;

let cache: { ids: Set<string>; expiresAt: number } | null = null;

/**
 * Guardian contact ids from the gateway DB. Cached for {@link CACHE_TTL_MS};
 * returns an empty set on IPC error (never throws).
 */
export async function getGuardianContactIds(): Promise<Set<string>> {
  if (cache && cache.expiresAt > Date.now()) return cache.ids;

  try {
    const result = await ipcCallPersistent("get_guardian_contact", {});
    const { guardianIds } = GetGuardianContactIpcResponseSchema.parse(result);
    const ids = new Set(guardianIds);
    cache = { ids, expiresAt: Date.now() + CACHE_TTL_MS };
    return ids;
  } catch (err) {
    log.warn(
      { err },
      "get_guardian_contact IPC failed; returning empty guardian set",
    );
    return new Set();
  }
}

/**
 * Drop the cached guardian set so contact mutations (rebind/revoke/upsert)
 * refetch on the next read. Called by {@link notifyContactsChanged} after a
 * contact write.
 */
export function invalidateGuardianContactCache(): void {
  cache = null;
}
