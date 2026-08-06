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
 * Normalize a credential reference to the vault-key form.
 *
 * The secrets API names credentials `{service}:{field}` on the wire (e.g.
 * `openrouter:api_key`), while the vault stores them as
 * `credential/{service}/{field}`. Callers routinely reuse the wire name where
 * a vault key is expected, producing references that never resolve. Map the
 * wire name to the vault key (same lastIndexOf split the secrets routes use);
 * leave anything else untouched.
 */
export function normalizeCredentialRef(ref: string): string {
  if (ref.startsWith("credential/")) {
    return ref;
  }
  const colonIdx = ref.lastIndexOf(":");
  if (colonIdx < 1 || colonIdx === ref.length - 1) {
    return ref;
  }
  return credentialKey(ref.slice(0, colonIdx), ref.slice(colonIdx + 1));
}
