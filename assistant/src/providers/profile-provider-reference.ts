import { VALID_CONNECTION_PROVIDERS } from "./inference/auth.js";

const CONNECTION_REFERENCE_PREFIX = "connection:";

/**
 * Encode an exact connection selection in the profile `provider` field when
 * its raw name would be ambiguous with a provider id or the reference syntax.
 * Ordinary entry names stay readable (`anthropic-work`); reserved names are
 * namespaced (`connection:anthropic`).
 */
export function profileProviderForConnection(connectionName: string): string {
  if (
    VALID_CONNECTION_PROVIDERS.includes(connectionName) ||
    connectionName.startsWith(CONNECTION_REFERENCE_PREFIX)
  ) {
    return `${CONNECTION_REFERENCE_PREFIX}${encodeURIComponent(connectionName)}`;
  }
  return connectionName;
}

/**
 * Decode an explicitly namespaced connection reference. Returns null for a
 * conventional provider value or an ordinary entry name.
 */
export function connectionNameFromProfileProviderReference(
  provider: string | undefined,
): string | null {
  if (!provider?.startsWith(CONNECTION_REFERENCE_PREFIX)) {
    return null;
  }
  const encoded = provider.slice(CONNECTION_REFERENCE_PREFIX.length);
  if (encoded.length === 0) {
    return null;
  }
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}
