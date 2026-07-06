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
 *   1. The profile MUST name a `provider_connection`. The boot-time
 *      backfill ensures every profile has one; a missing connection name
 *      is a configuration bug.
 *   2. Hard config errors (DB lookup throws, row not found, provider
 *      mismatch with the resolving profile) throw so misconfigurations
 *      surface immediately rather than silently rerouting.
 *   3. Soft credential issues (`resolveProviderFromConnection` returns
 *      null because the credential isn't set in the vault, or the
 *      auth bundle yields no usable adapter) return null. Callers are
 *      free to treat null as "no provider available" and fall back to
 *      a graceful no-op (e.g. rollup producer skips, satellite throw
 *      with their own actionable message).
 *   4. Transient failures inside the resolver (managed-proxy context
 *      lookup, credential read I/O) are caught and treated like a soft
 *      credential issue (return null). A transient blip should not take
 *      a conversation offline.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getDb } from "../persistence/db-connection.js";
import { getLogger } from "../util/logger.js";
import {
  describeSubscriptionModelIncompatibility,
  isConnectionCompatibleWithModel,
} from "./connection-model-compat.js";
import { getConnection, listConnections } from "./inference/connections.js";
import type { ProvidersConfig } from "./registry.js";
import { resolveProviderFromConnection } from "./registry.js";
import type { Provider } from "./types.js";
import {
  isVellumManagedConnection,
  MANAGED_ROUTABLE_PROVIDERS,
} from "./vellum-model-routing.js";

const log = getLogger("providers/connection-resolution");

/**
 * Error raised when a `provider_connection` reference cannot be resolved
 * because the configuration is broken (DB lookup throws, no such row, or
 * the connection's provider does not match the resolving profile's
 * declared provider). These are deterministic configuration bugs that
 * should fail loudly rather than silently rerouting.
 */
export class ConnectionResolutionError extends Error {
  constructor(
    public readonly connectionName: string,
    public readonly reason:
      | "lookup_failed"
      | "not_found"
      | "provider_mismatch"
      | "missing_connection"
      | "model_incompatible",
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ConnectionResolutionError";
  }
}

/**
 * Resolve a Provider through a named `provider_connection`.
 *
 * Throws `ConnectionResolutionError` on hard config errors:
 *   - DB lookup throws (`lookup_failed`)
 *   - No connection row with this name (`not_found`)
 *   - Connection row's provider does not match `expectedProvider`
 *     (`provider_mismatch`) — protects against silent misroutes when a
 *     profile names provider X with a connection bound to provider Y.
 *
 * Returns null on soft credential issues:
 *   - `resolveProviderFromConnection` returned null (credential missing
 *     from vault, platform auth unavailable, adapter creation failure).
 *   - The resolver threw a transient failure (caught and downgraded to
 *     null). Callers handle null as "no provider available right now".
 *
 * `expectedProvider` is the provider name the resolving profile declared.
 * Pass `undefined` to skip the mismatch check (callers that don't yet
 * know the expected provider).
 *
 * `model` is the resolved call-site model. It gates the `provider_mismatch`
 * auto-recovery below so a non-Codex model is never rerouted onto an
 * `oauth_subscription` (ChatGPT Codex) connection.
 */
export async function tryResolveProviderForConnectionName(
  connectionName: string,
  config: ProvidersConfig,
  expectedProvider?: string,
  model?: string,
): Promise<Provider | null> {
  let connection;
  try {
    connection = getConnection(getDb(), connectionName);
  } catch (err) {
    throw new ConnectionResolutionError(
      connectionName,
      "lookup_failed",
      `provider_connection lookup failed for "${connectionName}"`,
      err,
    );
  }
  if (!connection) {
    throw new ConnectionResolutionError(
      connectionName,
      "not_found",
      `provider_connection "${connectionName}" not found in DB — check your config or run the boot-time backfill`,
    );
  }
  // The provider-agnostic Vellum-managed connection carries only the `vellum`
  // sentinel, so the usual `connection.provider === expectedProvider` equality
  // never holds. It routes by the resolving profile's declared provider
  // instead (threaded as `providerOverride` below), which must be present AND
  // one of the managed-routable upstreams — the platform proxy can only serve
  // those. A `vellum` connection paired with a non-managed provider
  // (openrouter/ollama/openai-compatible/…) is a genuine misconfiguration: it
  // falls through to the mismatch recovery/error path below rather than routing
  // as platform auth, which would otherwise fail as a soft miss and silently
  // fall back to the default provider.
  const isVellum = isVellumManagedConnection(connection);
  if (isVellum && !expectedProvider) {
    throw new ConnectionResolutionError(
      connectionName,
      "provider_mismatch",
      `provider_connection "${connectionName}" is the provider-agnostic Vellum-managed connection but the resolving profile declared no provider — set the profile's provider so the upstream can be selected`,
    );
  }
  const isVellumRoute =
    isVellum &&
    !!expectedProvider &&
    MANAGED_ROUTABLE_PROVIDERS.has(expectedProvider);
  if (
    !isVellumRoute &&
    expectedProvider &&
    connection.provider !== expectedProvider
  ) {
    // Mismatch usually means the config deep-merge inherited a stale
    // provider_connection from a lower layer (e.g. profile sets a BYOK
    // provider with "Any active" but the default layer's
    // "anthropic-managed" leaked through). Try to find an active connection
    // for the expected provider before giving up.
    let resolved = false;
    let mismatchCandidates:
      | import("./inference/auth.js").ProviderConnection[]
      | undefined;
    try {
      const db = getDb();
      mismatchCandidates = listConnections(db, { provider: expectedProvider });
      const active = mismatchCandidates.find((c) =>
        isConnectionCompatibleWithModel(c, model),
      );
      if (active) {
        log.info(
          {
            originalConnection: connectionName,
            resolvedConnection: active.name,
            expectedProvider,
          },
          "Auto-resolved stale provider_connection to matching connection",
        );
        connection = active;
        resolved = true;
      }
    } catch {
      // DB not available — fall through to the original error.
    }
    if (!resolved) {
      const incompatMsg = mismatchCandidates
        ? describeSubscriptionModelIncompatibility(mismatchCandidates, model)
        : null;
      if (incompatMsg) {
        throw new ConnectionResolutionError(
          connectionName,
          "model_incompatible",
          incompatMsg,
        );
      }
      throw new ConnectionResolutionError(
        connectionName,
        "provider_mismatch",
        `provider_connection "${connectionName}" has provider="${connection.provider}" but resolving profile declared provider="${expectedProvider}" — set the profile's provider_connection to a row matching its provider`,
      );
    }
  }
  // `resolveProviderFromConnection` reaches into auth resolution (credential
  // reads, managed-proxy context). A transient failure there is a soft
  // miss — log and return null so the caller can treat it the same as
  // "no usable credentials". Hard config errors are thrown above; this
  // catch is specifically for in-flight failures that should not take
  // dispatch offline.
  try {
    return await resolveProviderFromConnection(connection, config, {
      model,
      providerOverride: isVellumRoute ? expectedProvider : undefined,
    });
  } catch (err) {
    log.warn(
      { err, connectionName },
      "provider_connection auth resolution failed transiently — returning null",
    );
    return null;
  }
}

/**
 * Resolve the connection-aware default provider for the satellite
 * construction-time path (subagent manager, conversation store,
 * approval/guardian generators, rollup producer).
 *
 * Reads `config.llm.default.{provider, provider_connection}`.
 *
 *   - Throws `ConnectionResolutionError` if the default profile has no
 *     `provider_connection` (boot-time backfill should have set one;
 *     a missing connection name is a configuration bug).
 *   - Throws on hard connection errors (lookup_failed, not_found,
 *     provider_mismatch).
 *   - Returns null on soft credential issues so satellites can early-
 *     out gracefully (rollup producer skips, others throw with their
 *     own message).
 */
export async function resolveDefaultProvider(
  config: ProvidersConfig,
): Promise<Provider | null> {
  const resolved = resolveCallSiteConfig("mainAgent", config.llm);
  let connectionName = resolved.provider_connection;
  if (!connectionName) {
    // The merged config has no provider_connection — the profile likely set
    // provider without a connection ("Any active" selection), and the merge
    // cleared or failed to inherit one. Try to find an active connection
    // for the provider before giving up.
    let autoResolveCandidates:
      | import("./inference/auth.js").ProviderConnection[]
      | undefined;
    if (resolved.provider) {
      try {
        autoResolveCandidates = listConnections(getDb(), {
          provider: resolved.provider,
        });
        const active = autoResolveCandidates.find((c) =>
          isConnectionCompatibleWithModel(c, resolved.model),
        );
        if (active) {
          log.info(
            { provider: resolved.provider, resolvedConnection: active.name },
            "Auto-resolved missing provider_connection for default provider",
          );
          connectionName = active.name;
        }
      } catch {
        // DB not available — fall through to the original error.
      }
    }
    if (!connectionName) {
      const incompatMsg = autoResolveCandidates
        ? describeSubscriptionModelIncompatibility(
            autoResolveCandidates,
            resolved.model,
          )
        : null;
      if (incompatMsg) {
        throw new ConnectionResolutionError(
          "<llm.default>",
          "model_incompatible",
          incompatMsg,
        );
      }
      throw new ConnectionResolutionError(
        "<llm.default>",
        "missing_connection",
        `llm.default.provider_connection is unset — every profile must declare a provider_connection. The boot-time backfill in lifecycle.ts populates this field; if you see this error, the backfill did not run or the field was manually cleared.`,
      );
    }
  }
  return tryResolveProviderForConnectionName(
    connectionName,
    config,
    resolved.provider,
    resolved.model,
  );
}
