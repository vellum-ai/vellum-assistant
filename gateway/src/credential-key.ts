/**
 * Single source of truth for credential key format in the gateway's secure store access.
 *
 * Keys follow the pattern: credential/{service}/{field}
 *
 * This mirrors the helper in assistant/src/security/credential-key.ts.
 * The gateway is a separate package and cannot import from the assistant
 * directly, so we maintain a lightweight copy here.
 */

/**
 * Build a credential key for the secure store.
 *
 * @returns A key of the form `credential/{service}/{field}`
 */
export function credentialKey(service: string, field: string): string {
  return `credential/${service}/${field}`;
}
