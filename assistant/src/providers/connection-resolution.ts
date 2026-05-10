/**
 * Connection-aware provider resolution helpers.
 *
 * These wrap `resolveProviderFromConnection` (in `registry.ts`) with the
 * DB lookup and lifecycle of a `provider_connection` reference. The
 * canonical dispatch path (`provider-send-message.ts`) and each satellite
 * site (subagent manager, daemon conversation/approval/guardian generators,
 * rollup producer) use these helpers so that connection-awareness behaves
 * identically across the codebase.
 *
 * Resolution policy:
 *   1. If the profile names a `provider_connection`, look it up in the DB
 *      and resolve to a `Provider` with the connection's auth bound.
 *   2. On any miss (DB lookup throws, row not found, auth resolution fails)
 *      log a warning and return null so callers can fall back to legacy
 *      `getProvider(profile.provider)` dispatch.
 *
 * The legacy fallback is intentionally retained for one release window —
 * cycle-4 cleanup will remove it once we've shipped one release with
 * connection-awareness active.
 */

import { getDb } from "../memory/db-connection.js";
import { getLogger } from "../util/logger.js";
import { getConnection } from "./inference/connections.js";
import type { ProvidersConfig } from "./registry.js";
import {
  getProvider,
  resolveProviderFromConnection,
} from "./registry.js";
import type { Provider } from "./types.js";

const log = getLogger("providers/connection-resolution");

/**
 * Attempt to resolve a Provider through a named `provider_connection`. Returns
 * null on any miss (lookup error, row not found, provider mismatch with the
 * resolving profile, auth resolution failure) so callers can fall back to the
 * legacy `getProvider(name)` path.
 *
 * `expectedProvider` is the provider name the resolving profile declared. We
 * verify the connection row's `provider` field matches before binding — a
 * profile that names `provider: "openai"` together with a Anthropic-flavored
 * `provider_connection` is a misconfiguration and we fall through rather than
 * silently routing the request to the wrong backend. Pass `undefined` to skip
 * the check (callers that don't yet know the expected provider).
 */
export async function tryResolveProviderForConnectionName(
  connectionName: string,
  config: ProvidersConfig,
  expectedProvider?: string,
): Promise<Provider | null> {
  let connection;
  try {
    connection = getConnection(getDb(), connectionName);
  } catch (err) {
    log.warn(
      { err, connectionName },
      "provider_connection lookup failed — falling back to legacy registry dispatch",
    );
    return null;
  }
  if (!connection) {
    log.warn(
      { connectionName },
      "provider_connection not found — falling back to legacy registry dispatch",
    );
    return null;
  }
  if (expectedProvider && connection.provider !== expectedProvider) {
    log.warn(
      {
        connectionName,
        expectedProvider,
        connectionProvider: connection.provider,
      },
      "provider_connection provider does not match resolving profile's provider — falling back to legacy registry dispatch to avoid silent misroute",
    );
    return null;
  }
  // `resolveProviderFromConnection` reaches into auth resolution (credential
  // reads, managed-proxy context). A transient failure there must not hard-
  // fail the dispatcher — log and fall through so the legacy registry path
  // can still serve the request.
  try {
    return await resolveProviderFromConnection(connection, config);
  } catch (err) {
    log.warn(
      { err, connectionName },
      "provider_connection auth resolution failed — falling back to legacy registry dispatch",
    );
    return null;
  }
}

/**
 * Resolve the connection-aware default provider for the satellite
 * construction-time path (subagent manager, conversation store,
 * approval/guardian generators, rollup producer).
 *
 * Reads `config.llm.default.{provider, provider_connection}`. If the default
 * profile names a connection, tries connection-aware resolution; otherwise
 * (or on miss) falls through to the legacy registry. Returns null if the
 * default provider isn't initialised (so callers can early-out gracefully).
 */
export async function resolveDefaultProvider(
  config: ProvidersConfig,
): Promise<Provider | null> {
  const profile = config.llm.default;
  // `provider_connection` is read off the runtime config as added by
  // `profileConfigFragment`; the typed view in `ProvidersConfig.llm.default`
  // doesn't include it yet so cast through. The schema-level type is updated
  // in `schemas/llm.ts`; this cast keeps the public `ProvidersConfig` shape
  // stable for cycle-3 and is removed when the type alignment lands.
  const connectionName = (profile as { provider_connection?: string })
    .provider_connection;
  if (connectionName) {
    const connectionProvider = await tryResolveProviderForConnectionName(
      connectionName,
      config,
      profile.provider,
    );
    if (connectionProvider) return connectionProvider;
  }
  try {
    return getProvider(profile.provider);
  } catch (err) {
    log.warn(
      { err, providerName: profile.provider },
      "default provider not registered — caller should treat as null",
    );
    return null;
  }
}
