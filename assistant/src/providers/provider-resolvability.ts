import { getDb } from "../persistence/db-connection.js";
import { VALID_CONNECTION_PROVIDERS } from "./inference/auth.js";
import { getConnection } from "./inference/connections.js";

/**
 * Selection-time predicate for `ResolveCallSiteOpts.isResolvableProvider`:
 * a provider value dispatches when it is a known vendor/identity or names a
 * connection entry row. Permissive on DB unavailability so a transient blip
 * never heals away a valid entry profile; dispatch soft-fails on its own.
 */
export function dispatchProviderResolvable(provider: string): boolean {
  if (VALID_CONNECTION_PROVIDERS.includes(provider)) {
    return true;
  }
  try {
    return getConnection(getDb(), provider) != null;
  } catch {
    return true;
  }
}
