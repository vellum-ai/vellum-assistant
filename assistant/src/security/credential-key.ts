/**
 * Single source of truth for credential key format in the secure store.
 *
 * Keys follow the pattern: credential/{service}/{field}
 *
 * Previously, keys used colons as delimiters (credential:service:field),
 * which was ambiguous when service names contained colons (e.g.
 * "integration:gmail"). The slash-delimited format avoids this.
 */

import { getLogger } from "../util/logger.js";
import {
  deleteSecureKey,
  getSecureKey,
  listSecureKeys,
  setSecureKey,
} from "./secure-keys.js";

const log = getLogger("credential-key");

/**
 * Build a credential key for the secure store.
 *
 * @returns A key of the form `credential/{service}/{field}`
 */
export function credentialKey(service: string, field: string): string {
  return `credential/${service}/${field}`;
}

// ---------------------------------------------------------------------------
// Migration from colon-delimited keys
// ---------------------------------------------------------------------------

let migrated = false;

/**
 * Migrate any legacy colon-delimited credential keys to the new
 * slash-delimited format. Idempotent: skips keys that already exist
 * under the new format, and only runs once per process (guarded by a
 * module-level flag).
 *
 * Legacy key format: `credential:<service>:<field>`
 * New key format:    `credential/<service>/<field>`
 *
 * Service names may contain colons (e.g. "integration:gmail"), so the
 * parsing splits on the first colon after "credential" and the last
 * colon to extract service and field.
 */
export function migrateKeys(): void {
  if (migrated) return;
  migrated = true;

  let allKeys: string[];
  try {
    allKeys = listSecureKeys();
  } catch (err) {
    log.warn({ err }, "Failed to list secure keys during migration");
    return;
  }

  const colonKeys = allKeys.filter(
    (k) => k.startsWith("credential:") && !k.startsWith("credential/"),
  );
  if (colonKeys.length === 0) return;

  log.info(
    { count: colonKeys.length },
    "Migrating colon-delimited credential keys to slash-delimited format",
  );

  for (const oldKey of colonKeys) {
    // Strip the "credential:" prefix
    const rest = oldKey.slice("credential:".length);

    // Split on the last colon to get field; everything before is the service.
    // This handles service names with colons (e.g. "integration:gmail").
    const lastColon = rest.lastIndexOf(":");
    if (lastColon <= 0) {
      log.warn({ key: oldKey }, "Skipping malformed credential key");
      continue;
    }

    const service = rest.slice(0, lastColon);
    const field = rest.slice(lastColon + 1);
    const newKey = credentialKey(service, field);

    // Skip if the new key already exists (idempotent)
    if (getSecureKey(newKey) !== undefined) {
      // Clean up old key
      deleteSecureKey(oldKey);
      continue;
    }

    const value = getSecureKey(oldKey);
    if (value === undefined) {
      continue;
    }

    const ok = setSecureKey(newKey, value);
    if (ok) {
      deleteSecureKey(oldKey);
    } else {
      log.warn(
        { oldKey, newKey },
        "Failed to write migrated key; keeping old key",
      );
    }
  }
}

/** @internal Test-only: reset the migration guard so migrateKeys() runs again. */
export function _resetMigrationFlag(): void {
  migrated = false;
}
