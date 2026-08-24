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

import { getIsPlatform } from "../config/env-registry.js";
import {
  resolveCallSiteConfig,
  selectWinningProfile,
} from "../config/llm-resolver.js";
import { unknownLlmProviderIssue } from "../config/schemas/llm.js";
import { getDb } from "../persistence/db-connection.js";
import { credentialKey } from "../security/credential-key.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  describeSubscriptionModelIncompatibility,
  isConnectionCompatibleWithModel,
} from "./connection-model-compat.js";
import {
  ROUTING_IDENTITY_PROVIDERS,
  VALID_CONNECTION_PROVIDERS,
} from "./inference/auth.js";
import {
  canonicalVellumConnection,
  getConnection,
  listConnections,
} from "./inference/connections.js";
import { resolveManagedProxyContext } from "./platform-proxy/context.js";
import { checkCredentialPresence } from "./provider-availability.js";
import type { ProvidersConfig } from "./registry.js";
import { resolveProviderFromConnection } from "./registry.js";
import {
  ConnectionResolutionError,
  resolveRoutingIdentity,
} from "./routing-identity.js";
import type { Provider } from "./types.js";
import {
  getManagedUpstream,
  isVellumManagedConnection,
  MANAGED_ROUTABLE_PROVIDERS,
  VELLUM_MANAGED_CONNECTION_NAME,
} from "./vellum-model-routing.js";

export { ConnectionResolutionError, resolveRoutingIdentity };

const log = getLogger("providers/connection-resolution");

/**
 * Resolve a provider label that names a connection row (an entry) to that
 * row's name. Returns null for catalog providers and routing identities
 * (those translate through their own rules) and for labels naming no row.
 *
 * The write surfaces reject entry-name providers until the entries model
 * enables them, so a config carrying one reaches dispatch only through a
 * hand edit today and through the collapse migration later; translating
 * here makes both route explainably instead of failing as an unknown
 * provider.
 */
export function resolveEntryConnectionName(
  provider: string | undefined,
): string | null {
  if (!provider || VALID_CONNECTION_PROVIDERS.includes(provider)) {
    return null;
  }
  try {
    return getConnection(getDb(), provider) ? provider : null;
  } catch {
    return null;
  }
}

/**
 * Write-surface membership for a PROFILE provider value: the known vendor
 * and identity set, plus existing connection entry rows. Fail-closed on DB
 * unavailability (an unverifiable entry name is rejected; the write is
 * retryable), unlike the selection-time predicate below, which is
 * fail-open so a DB blip never heals away a valid profile. Call-site
 * fragments keep vendor-only membership: overrides become model-only with
 * the entries demolition, so entries must not leak into them meanwhile.
 */
export function writableProfileProviderIssue(provider: string): string | null {
  const issue = unknownLlmProviderIssue(provider);
  if (issue === null) {
    return null;
  }
  try {
    if (getConnection(getDb(), provider) != null) {
      return null;
    }
  } catch {
    // Unverifiable: fall through to the rejection.
  }
  return `Invalid provider "${provider}". Use a known provider or the name of an existing connection.`;
}

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

/**
 * The vendor a resolved provider value expects its connection row to serve:
 * catalog ids and routing identities pass through, and an entry-name label
 * resolves to its row's dispatchable kind, so a config carrying both an
 * entry label and a `provider_connection` is held to the label's kind by
 * the row-equality check (a conflicting row mismatches explainably or
 * auto-recovers to a matching one). A label naming no row yields undefined.
 */
export function expectedVendorProvider(
  provider: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!provider) {
    return undefined;
  }
  if (VALID_CONNECTION_PROVIDERS.includes(provider)) {
    return provider;
  }
  return resolveEntryProviderKind(provider, model) ?? undefined;
}

/**
 * The dispatchable provider kind behind a connection row, or null when the
 * row is missing or its kind cannot be derived. Identity-kind rows derive
 * their upstream the way the identities themselves do. Sync and
 * best-effort so capability probes can share dispatch's translation
 * without replaying its async resolution.
 */
export function connectionProviderKind(
  connectionName: string,
  model: string | undefined,
): string | null {
  try {
    const row = getConnection(getDb(), connectionName);
    if (!row) {
      return null;
    }
    if (isVellumManagedConnection(row)) {
      return model ? getManagedUpstream(model) : null;
    }
    if (row.provider === "chatgpt") {
      return "openai";
    }
    return row.provider;
  } catch {
    return null;
  }
}

/**
 * The dispatchable provider kind behind an entry-name label, or null when
 * the label is not an entry.
 */
export function resolveEntryProviderKind(
  provider: string | undefined,
  model: string | undefined,
): string | null {
  const entryName = resolveEntryConnectionName(provider);
  return entryName ? connectionProviderKind(entryName, model) : null;
}

/**
 * The catalog provider whose model limits judge a profile's (provider,
 * model) pair: routing identities translate to their concrete upstream
 * (chatgpt serves the OpenAI catalog; a vellum profile's bare native model
 * names its managed owner), and an entry-name label resolves to its row's
 * dispatchable kind. Null when no upstream is derivable (the pair stays
 * unjudged). Shared by the profile-route budget validation and profile
 * materialization so the two cannot drift.
 */
export function catalogProviderForProfile(
  provider: string,
  model: string,
): string | null {
  if (ROUTING_IDENTITY_PROVIDERS.has(provider)) {
    return provider === "chatgpt" ? "openai" : getManagedUpstream(model);
  }
  return resolveEntryProviderKind(provider, model) ?? provider;
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
  // Routing identities carry no upstream of their own: translate to the
  // identity's canonical connection row and derived upstream before any
  // lookup. The stored connectionName is overridden — an identity has
  // exactly one authoritative row.
  const declaredProvider = expectedProvider;
  const identity = resolveRoutingIdentity(expectedProvider, model);
  if (identity) {
    connectionName = identity.connectionName;
    expectedProvider = identity.expectedProvider;
  }
  let connection;
  try {
    connection = getConnection(getDb(), connectionName);
  } catch (err) {
    throw new ConnectionResolutionError(
      connectionName,
      "lookup_failed",
      `provider_connection lookup failed for "${connectionName}"`,
      { cause: err },
    );
  }
  if (!connection) {
    throw new ConnectionResolutionError(
      connectionName,
      "not_found",
      `provider_connection "${connectionName}" not found in DB — check your config or run the boot-time backfill`,
    );
  }
  // Any route through the canonical connection name is platform-billed, so it
  // resolves on platform auth and ignores a user-owned row claiming that name
  // (boot seeding refuses to overwrite such a row, so these installs have no
  // canonical row at all). Keyed on the name rather than the declared
  // provider: a call-site tweak pinning a concrete upstream over a managed
  // profile keeps the managed connection while replacing the provider
  // (`llm-resolver.ts`), and that route is platform-billed just the same.
  if (
    connectionName === VELLUM_MANAGED_CONNECTION_NAME &&
    !isVellumManagedConnection(connection)
  ) {
    const provider = await resolveThroughPlatform(
      config,
      expectedProvider ?? declaredProvider,
      model,
    );
    return attachProviderRoute(provider, canonicalVellumConnection());
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
    // An entry-name route carries no declared provider (the label is the
    // row's name, not a vendor); a vellum-kind row derives its upstream
    // from the model, same as the vellum identity itself.
    expectedProvider = model
      ? (getManagedUpstream(model) ?? undefined)
      : undefined;
    if (!expectedProvider) {
      throw new ConnectionResolutionError(
        connectionName,
        "provider_mismatch",
        `provider_connection "${connectionName}" is the provider-agnostic Vellum-managed connection but the resolving profile declared no provider — set the profile's provider so the upstream can be selected`,
      );
    }
  }
  const isVellumRoute =
    isVellum &&
    !!expectedProvider &&
    MANAGED_ROUTABLE_PROVIDERS.has(expectedProvider);
  // The ChatGPT-subscription row stores the "chatgpt" routing identity in
  // its provider column, so the equality never holds for its openai
  // upstream. The identity dispatches with the upstream threaded as
  // `providerOverride`, mirroring the vellum sentinel; the upstream is
  // always openai (`resolveRoutingIdentity`). Any other declared provider
  // on a chatgpt row is a genuine mismatch and falls through below.
  const isChatgptRoute =
    connection.provider === "chatgpt" &&
    (expectedProvider === undefined || expectedProvider === "openai");
  if (
    !isVellumRoute &&
    !isChatgptRoute &&
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
          { model },
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
    const provider = await resolveProviderFromConnection(connection, config, {
      model,
      providerOverride: isVellumRoute
        ? expectedProvider
        : isChatgptRoute
          ? "openai"
          : undefined,
    });
    return attachProviderRoute(provider, connection);
  } catch (err) {
    log.warn(
      { err, connectionName },
      "provider_connection auth resolution failed transiently — returning null",
    );
    return null;
  }
}

function attachProviderRoute(
  provider: Provider | null,
  connection: { name: string; provider: string; auth: { type: string } },
): Provider | null {
  if (provider) {
    provider.routeAttribution = {
      connectionName: connection.name,
      isManagedRoute: isVellumManagedConnection(connection),
    };
  }
  return provider;
}

/**
 * Whether a route through this connection name is Vellum-managed
 * (platform-billed), for callers that hold only the name. Returns undefined
 * when the row can't be read, so the caller can fall back rather than assert
 * a BYOK route it never confirmed.
 *
 * The canonical name is always managed: a user-owned row claiming it is
 * ignored and the route resolves through platform auth regardless (see
 * `tryResolveProviderForConnectionName`).
 */
export function isManagedConnectionRoute(
  connectionName: string,
): boolean | undefined {
  if (connectionName === VELLUM_MANAGED_CONNECTION_NAME) {
    return true;
  }
  let connection;
  try {
    connection = getConnection(getDb(), connectionName);
  } catch {
    return undefined;
  }
  return connection ? isVellumManagedConnection(connection) : undefined;
}

/**
 * Resolve a managed route through platform auth without reading a connection
 * row. Used when the canonical `vellum` row is claimed by a user-owned
 * connection, so the row boot seeding would have written does not exist.
 */
async function resolveThroughPlatform(
  config: ProvidersConfig,
  upstream: string | undefined,
  model: string | undefined,
): Promise<Provider | null> {
  if (!upstream || !MANAGED_ROUTABLE_PROVIDERS.has(upstream)) {
    return null;
  }
  log.info(
    { upstream, model },
    "Vellum-managed route resolved through platform auth: a user-owned connection claims the canonical connection name",
  );
  try {
    return await resolveProviderFromConnection(
      canonicalVellumConnection(),
      config,
      { model, providerOverride: upstream },
    );
  } catch (err) {
    log.warn({ err }, "Platform fallback auth resolution failed transiently");
    return null;
  }
}

/**
 * Resolve the connection-aware default provider for the satellite
 * construction-time path (subagent manager, conversation store,
 * approval/guardian generators, rollup producer).
 *
 * Resolves the mainAgent call-site config and reads its
 * `{provider, provider_connection}`.
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
  const resolved = resolveCallSiteConfig("mainAgent", config.llm, {
    isResolvableProvider: dispatchProviderResolvable,
  });
  let connectionName = resolved.provider_connection;
  // A routing-identity provider names its own connection row; the
  // provider-keyed auto-resolve scan below cannot find it ("chatgpt" rows
  // store provider "openai"), so short-circuit to the canonical name.
  if (!connectionName) {
    connectionName = resolveRoutingIdentity(
      resolved.provider,
      resolved.model,
    )?.connectionName;
  }
  // An entry-name provider IS the connection name: the label points at a
  // row, and the row's own provider drives dispatch.
  const entryName = connectionName
    ? null
    : resolveEntryConnectionName(resolved.provider);
  if (entryName) {
    return tryResolveProviderForConnectionName(
      entryName,
      config,
      undefined,
      resolved.model,
    );
  }
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
          "<default>",
          "model_incompatible",
          incompatMsg,
          { model: resolved.model },
        );
      }
      throw new ConnectionResolutionError(
        "<default>",
        "missing_connection",
        `The resolved default config carries no provider_connection and no active connection exists for provider "${resolved.provider}". Connect a provider or point llm.defaultProvider at one with credentials.`,
      );
    }
  }
  return tryResolveProviderForConnectionName(
    connectionName,
    config,
    expectedVendorProvider(resolved.provider, resolved.model),
    resolved.model,
  );
}

/**
 * Statically verify a resolved config can dispatch, throwing a
 * reason-carrying `ConnectionResolutionError` that names the profile,
 * connection, and fix when it provably cannot:
 *
 *   - connection row missing (`not_found`)
 *   - connection bound to a different provider (`provider_mismatch`), with
 *     the provider-agnostic Vellum-managed exception for managed-routable
 *     providers
 *   - API-key/subscription credential absent from the vault
 *     (`missing_credential`)
 *   - platform auth without a platform login (`platform_unauthenticated`)
 *   - model not servable by the connection (`model_incompatible`)
 *
 * Returns silently when the config is healthy AND when it is indeterminate:
 * a credential store that is unreachable must never be reported as a missing
 * credential, so the caller falls through to its existing retryable
 * handling. Purely a read — never mutates, never auto-recovers.
 */
export async function preflightResolvedConfig(
  resolved: {
    provider: string;
    provider_connection?: string;
    model: string;
  },
  attribution: { profileName?: string } = {},
): Promise<void> {
  // Routing identities preflight through their canonical row and derived
  // upstream; an unroutable vellum model throws here — it is statically
  // detectable, exactly what preflight exists to surface.
  const identity = resolveRoutingIdentity(resolved.provider, resolved.model);
  // An entry-name provider IS the connection name, and the row's kind is
  // what the checks below judge against (same translation dispatch uses).
  // Precedence matches dispatch exactly: an explicit provider_connection
  // wins over the entry name, so preflight judges the row the request
  // actually uses rather than a healthy entry the request ignores.
  const entryName = identity
    ? null
    : resolveEntryConnectionName(resolved.provider);
  const provider = identity
    ? identity.expectedProvider
    : entryName
      ? (connectionProviderKind(entryName, resolved.model) ?? resolved.provider)
      : resolved.provider;
  const connectionName =
    identity?.connectionName ?? resolved.provider_connection ?? entryName;
  if (!connectionName) {
    return;
  }
  const errorOptions = {
    model: resolved.model,
    ...(attribution.profileName != null
      ? { profileName: attribution.profileName }
      : {}),
  };

  let connection;
  try {
    connection = getConnection(getDb(), connectionName);
  } catch {
    // DB unavailable — indeterminate, not a config error.
    return;
  }
  if (!connection) {
    throw new ConnectionResolutionError(
      connectionName,
      "not_found",
      `provider_connection "${connectionName}" does not exist — add a connection for provider "${resolved.provider}" or pick a different default in Settings`,
      errorOptions,
    );
  }
  // Dispatch routes anything through the canonical name on platform auth, so
  // preflight judges the platform rather than a claiming row's credentials.
  if (
    connectionName === VELLUM_MANAGED_CONNECTION_NAME &&
    !isVellumManagedConnection(connection)
  ) {
    connection = canonicalVellumConnection();
  }

  if (isVellumManagedConnection(connection)) {
    if (!MANAGED_ROUTABLE_PROVIDERS.has(provider)) {
      throw new ConnectionResolutionError(
        connectionName,
        "provider_mismatch",
        `provider_connection "${connectionName}" is the Vellum-managed connection, which cannot serve provider "${provider}"`,
        errorOptions,
      );
    }
    const presence = await platformLoginPresence();
    if (presence === "ok") {
      return;
    }
    if (getIsPlatform()) {
      // A platform-managed assistant cannot present a login screen or switch
      // providers, so the login-or-switch wording never fits. An unreachable
      // store is transient and recovers on its own, so it reads as a retry. A
      // reachable but empty store can only be fixed by re-provisioning the
      // credential platform-side.
      if (presence === "indeterminate") {
        throw new ConnectionResolutionError(
          connectionName,
          "platform_unauthenticated",
          "The assistant's platform credentials are temporarily unavailable; retrying automatically.",
          errorOptions,
        );
      }
      log.error(
        {
          connectionName,
          model: resolved.model,
          profileName: attribution.profileName,
        },
        "Managed platform credential is missing and must be re-provisioned",
      );
      throw new ConnectionResolutionError(
        connectionName,
        "platform_unauthenticated",
        "This assistant's platform credential is missing and must be re-provisioned on the Vellum platform.",
        errorOptions,
      );
    }
    if (presence === "unauthenticated") {
      throw new ConnectionResolutionError(
        connectionName,
        "platform_unauthenticated",
        `provider_connection "${connectionName}" routes through the Vellum platform, but no platform login is available — log in or pick a different provider`,
        errorOptions,
      );
    }
    return;
  }
  // The ChatGPT-subscription row stores the "chatgpt" identity while its
  // upstream is openai; the credential-presence switch below is the right
  // preflight for it (the subscription token is its credential).
  const isChatgptRow =
    connection.provider === "chatgpt" && provider === "openai";
  if (!isChatgptRow && connection.provider !== provider) {
    throw new ConnectionResolutionError(
      connectionName,
      "provider_mismatch",
      `provider_connection "${connectionName}" has provider="${connection.provider}" but the resolved config declares provider="${provider}"`,
      errorOptions,
    );
  }

  switch (connection.auth.type) {
    case "api_key":
    case "oauth_subscription":
    case "service_account": {
      const presence = await checkCredentialPresence(
        connection.auth.credential,
      );
      if (presence !== "absent") {
        // `indeterminate` (credential store unreachable) must never be
        // claimed as a missing credential.
        return;
      }
      throw new ConnectionResolutionError(
        connectionName,
        "missing_credential",
        `provider_connection "${connectionName}" has no ${connection.auth.type === "api_key" ? "API key" : "credential"} stored — add one in Settings`,
        errorOptions,
      );
    }
    case "platform": {
      if ((await platformLoginPresence()) === "unauthenticated") {
        throw new ConnectionResolutionError(
          connectionName,
          "platform_unauthenticated",
          `provider_connection "${connectionName}" uses platform auth, but no platform login is available — log in to use it`,
          errorOptions,
        );
      }
      return;
    }
    default:
      return;
  }
}

/**
 * Platform-login state with the credential-store-outage case kept distinct:
 * `resolveManagedProxyContext` collapses an unreachable key read into
 * "no key", which must not be reported as a logout. A missing platform base
 * URL is definitively unauthenticated (it is config, not a credential read).
 */
async function platformLoginPresence(): Promise<
  "ok" | "unauthenticated" | "indeterminate"
> {
  const ctx = await resolveManagedProxyContext();
  if (ctx.enabled) {
    return "ok";
  }
  if (!ctx.platformBaseUrl) {
    return "unauthenticated";
  }
  const presence = await checkCredentialPresence(
    credentialKey("vellum", "assistant_api_key"),
  );
  if (presence === "present") {
    return "ok";
  }
  return presence === "indeterminate" ? "indeterminate" : "unauthenticated";
}

/**
 * Shared guard for the call sites that must fail loudly when the default
 * provider resolves to no usable adapter: the flag-gated preflight throws a
 * reason-carrying error when it can statically pinpoint the breakage;
 * otherwise the returned generic retryable error is for the caller to
 * throw (returned rather than thrown so `throw await …` keeps TypeScript's
 * reachability narrowing at the call site).
 */
export async function mainAgentResolutionError(
  llm: Parameters<typeof resolveCallSiteConfig>[1],
  registeredProviders: string[],
): Promise<ProviderNotConfiguredError> {
  const resolved = resolveCallSiteConfig("mainAgent", llm);
  await preflightResolvedConfig(resolved, {
    profileName:
      selectWinningProfile("mainAgent", llm, {}).profileName ?? undefined,
  });
  return new ProviderNotConfiguredError(
    resolved.provider,
    registeredProviders,
    {
      connectionName: resolved.provider_connection,
    },
  );
}
