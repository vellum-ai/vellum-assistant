/**
 * Single source of truth for credential key format in the secure store.
 *
 * Keys follow the pattern: credential/{service}/{field}
 *
 * Previously, keys used colons as delimiters (credential:service:field),
 * which was ambiguous when service names contained colons (e.g.
 * "integration:gmail"). The slash-delimited format avoids this.
 */

import { listCredentialMetadata } from "../tools/credentials/metadata-store.js";
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
 * The old colon-delimited format is ambiguous when either the service
 * or field name contains colons — for `credential:A:B:C:D`, you can't
 * tell where the service ends and the field begins without external
 * context.
 *
 * To resolve this, the function first consults the credential metadata
 * store to find which (service, field) pair matches a valid split.
 * If no metadata match is found, it falls back to splitting on the
 * **first** colon after the prefix — this handles the common case
 * where service names are simple (e.g. "doordash.com") and field
 * names may contain colons (e.g. "session:cookies").
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

  // Build a set of known (service, field) pairs from credential metadata
  // to disambiguate colon-delimited keys.
  const knownPairs = new Set<string>();
  try {
    for (const meta of listCredentialMetadata()) {
      knownPairs.add(`${meta.service}\0${meta.field}`);
    }
  } catch {
    // If metadata is unavailable, we'll rely on the first-colon fallback.
  }

  for (const oldKey of colonKeys) {
    // Strip the "credential:" prefix — `rest` is "service:field" with
    // potential colons in either part.
    const rest = oldKey.slice("credential:".length);

    const parsed = parseServiceField(rest, knownPairs);
    if (parsed === undefined) {
      log.warn({ key: oldKey }, "Skipping malformed credential key");
      continue;
    }

    const { service, field } = parsed;
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

/**
 * Parse a "service:field" string, using known metadata pairs to
 * disambiguate when colons appear in either part.
 *
 * Strategy:
 * 1. Try every possible split position and check against metadata.
 * 2. If no metadata match, fall back to splitting on the first colon
 *    (field names with colons are more common than service names with colons).
 *
 * Returns undefined for malformed keys that have no colon.
 */
function parseServiceField(
  rest: string,
  knownPairs: Set<string>,
): { service: string; field: string } | undefined {
  const firstColon = rest.indexOf(":");
  if (firstColon <= 0) return undefined;

  // Try each possible split position against metadata
  if (knownPairs.size > 0) {
    for (let i = firstColon; i < rest.length; i++) {
      if (rest[i] !== ":") continue;
      const service = rest.slice(0, i);
      const field = rest.slice(i + 1);
      if (field.length > 0 && knownPairs.has(`${service}\0${field}`)) {
        return { service, field };
      }
    }
  }

  // Fallback: split on first colon — handles simple services with
  // compound field names (e.g. "doordash.com:session:cookies").
  return {
    service: rest.slice(0, firstColon),
    field: rest.slice(firstColon + 1),
  };
}

/** @internal Test-only: reset the migration guard so migrateKeys() runs again. */
export function _resetMigrationFlag(): void {
  migrated = false;
}
