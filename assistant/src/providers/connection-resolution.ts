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

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
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
 * null on any miss (lookup error, row not found, auth resolution failure) so
 * callers can fall back to the legacy `getProvider(name)` path.
 */
export async function tryResolveProviderForConnectionName(
  connectionName: string,
  config: ProvidersConfig,
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
  return resolveProviderFromConnection(connection, config);
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

/**
 * Resolve a provider for an arbitrary callsite, with connection-awareness
 * applied to the resolved profile. Used by `CallSiteRoutingProvider` when a
 * per-call `callSite` (or `overrideProfile`) names a profile distinct from
 * the default.
 *
 * Returns null if neither the connection path nor the legacy registry can
 * produce a Provider — caller falls back to the default provider in that
 * case.
 */
export async function resolveProviderForCallSite(
  callSite: LLMCallSite,
  config: ProvidersConfig,
  opts: { overrideProfile?: string } = {},
): Promise<Provider | null> {
  // resolveCallSiteConfig works on the full LLM config, not the narrow
  // `ProvidersConfig.llm` view used elsewhere in the registry. Cast through
  // to keep ProvidersConfig as the public shape; schema-level alignment
  // happens in `schemas/llm.ts` (provider_connection field added there).
  const resolved = resolveCallSiteConfig(
    callSite,
    config.llm as Parameters<typeof resolveCallSiteConfig>[1],
    opts,
  );
  if (resolved.provider_connection) {
    const connectionProvider = await tryResolveProviderForConnectionName(
      resolved.provider_connection,
      config,
    );
    if (connectionProvider) return connectionProvider;
  }
  try {
    return getProvider(resolved.provider);
  } catch {
    return null;
  }
}
