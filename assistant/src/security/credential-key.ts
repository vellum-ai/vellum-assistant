/**
 * Single source of truth for credential key format in the secure store.
 *
 * Keys follow the pattern: credential/{service}/{field}
 */

/**
 * Build a credential key for the secure store.
 *
 * @returns A key of the form `credential/{service}/{field}`
 */
export function credentialKey(service: string, field: string): string {
  return `credential/${service}/${field}`;
}

/**
 * Well-known key under which the daemon persists the bootstrapped actor
 * HTTP access token in the encrypted credential store.
 */
export const BOOTSTRAPPED_ACTOR_HTTP_TOKEN = credentialKey("bootstrapped_actor", "http_token");
