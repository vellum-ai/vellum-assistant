/**
 * Single source of truth for credential key format in the secure store.
 *
 * Keys follow the pattern: credential/{service}/{field}
 *
 * This mirrors the assistant's credential-key.ts helper to ensure both
 * packages use the same key format when reading/writing credentials.
 */

/**
 * Build a credential key for the secure store.
 *
 * @returns A key of the form `credential/{service}/{field}`
 */
export function credentialKey(service: string, field: string): string {
  return `credential/${service}/${field}`;
}
