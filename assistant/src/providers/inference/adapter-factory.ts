/**
 * Provider adapter construction.
 *
 * One catalog-keyed factory table feeds two construction paths:
 *
 *   - `buildProviderAdapter` returns a raw `Provider` instance for a given
 *     provider id + options. The caller wraps with `RetryProvider` /
 *     `UsageTrackingProvider` to match the boot-time vs per-connection
 *     wrapping conventions in `registry.ts`.
 *   - `createAdapterFromConnection` is the per-call dispatcher entry point.
 *     It resolves a `ResolvedAuth` into `AdapterCreateOpts`, validates
 *     keyless/keyed compatibility, and returns a fully-wrapped
 *     `Provider | null`.
 *
 * Adding a new provider:
 *   1. Add an entry to `PROVIDER_CATALOG` in `model-catalog.ts`.
 *   2. Implement the client in `src/providers/<id>/client.ts`.
 *   3. Register the client in `ADAPTER_FACTORIES` below.
 */

import { resolveDefaultProfileForProvider } from "../../config/default-profile-catalog.js";
import {
  FALLBACK_PROFILE_BY_KEY,
  isDefaultProfileKey,
} from "../../config/default-profile-names.js";
import {
  resolveCallSiteConfigWithProfile,
  selectWinningProfile,
} from "../../config/llm-resolver.js";
import { getConfig } from "../../config/loader.js";
import { normalizeCredentialRef } from "../../security/credential-key.js";
import { getLogger } from "../../util/logger.js";
import { AnthropicProvider } from "../anthropic/client.js";
import { AtlasCloudProvider } from "../atlascloud/client.js";
import { BasetenProvider } from "../baseten/client.js";
import { FireworksProvider } from "../fireworks/client.js";
import { GeminiProvider } from "../gemini/client.js";
import { MinimaxProvider } from "../minimax/client.js";
import { PROVIDER_CATALOG } from "../model-catalog.js";
import { OllamaProvider } from "../ollama/client.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import { OpenAIResponsesProvider } from "../openai/responses-provider.js";
import { OpenCodeProvider } from "../opencode/client.js";
import { OpenRouterProvider } from "../openrouter/client.js";
import { PoolsideProvider } from "../poolside/client.js";
import { dispatchProviderResolvable } from "../provider-resolvability.js";
import { RetryProvider } from "../retry.js";
import { TogetherProvider } from "../together/client.js";
import type { Provider, SendMessageOptions } from "../types.js";
import { UsageTrackingProvider } from "../usage-tracking.js";
import { VellumProvider } from "../vellum/client.js";
import {
  getManagedUpstream,
  isVellumManagedConnection,
  MANAGED_ROUTABLE_PROVIDERS,
  VELLUM_MANAGED_PROVIDER,
} from "../vellum-model-routing.js";
import { VercelAIGatewayProvider } from "../vercel-ai-gateway/client.js";
import type { ResolvedAuth } from "./auth.js";
import type { ProviderConnection } from "./auth.js";
import { effectiveConnectionAuth } from "./auth.js";
import { MissingCredentialGuardProvider } from "./missing-credential-guard.js";
import { resolveAuth } from "./resolve-auth.js";

/** Unified construction opts. Adapters ignore fields they don't consume. */
export interface AdapterCreateOpts {
  apiKey: string;
  model: string;
  streamTimeoutMs: number;
  /** Set when an explicit base URL override or managed proxy is in play. */
  baseURL?: string;
  /** Forwarded to providers that wire native provider-side web search. */
  useNativeWebSearch: boolean;
  /** When true, the OpenAI adapter targets the Codex subscription endpoint. */
  codexSubscription?: boolean;
}

type AdapterFactory = (opts: AdapterCreateOpts) => Provider;

const log = getLogger("adapter-factory");

/** The backup route `RetryProvider` escalates to; see {@link makeFallbackRouteResolver}. */
interface FallbackRoute {
  provider: Provider;
  overrideProfile: string;
  forwardUsageAttributionHeaders: boolean;
}

/**
 * Catalog-keyed factory table. Each entry takes a unified
 * `AdapterCreateOpts` and constructs the underlying provider client. The
 * `id` field must match the corresponding `ProviderCatalogEntry.id` in
 * `PROVIDER_CATALOG` — `PROVIDER_CATALOG_FACTORY_PARITY` enforces this at
 * module-load time.
 */
const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  anthropic: ({
    apiKey,
    model,
    streamTimeoutMs,
    baseURL,
    useNativeWebSearch,
  }) =>
    new AnthropicProvider(apiKey, model, {
      useNativeWebSearch,
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  openai: ({
    apiKey,
    model,
    streamTimeoutMs,
    baseURL,
    useNativeWebSearch,
    codexSubscription,
  }) =>
    new OpenAIResponsesProvider(apiKey, model, {
      useNativeWebSearch,
      streamTimeoutMs,
      codexSubscription,
      ...(baseURL ? { baseURL } : {}),
    }),
  gemini: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new GeminiProvider(apiKey, model, {
      streamTimeoutMs,
      // Gemini routes managed proxies through `managedBaseUrl`, not `baseURL`.
      ...(baseURL ? { managedBaseUrl: baseURL } : {}),
    }),
  ollama: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new OllamaProvider(model, {
      // Empty string means keyless — Ollama's client treats undefined as
      // "no key provided" and defaults its internal placeholder.
      apiKey: apiKey || undefined,
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  fireworks: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new FireworksProvider(apiKey, model, {
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  openrouter: ({ apiKey, model, streamTimeoutMs, useNativeWebSearch }) =>
    new OpenRouterProvider(apiKey, model, {
      useNativeWebSearch,
      streamTimeoutMs,
    }),
  "vercel-ai-gateway": ({
    apiKey,
    model,
    streamTimeoutMs,
    baseURL,
    useNativeWebSearch,
  }) =>
    new VercelAIGatewayProvider(apiKey, model, {
      useNativeWebSearch,
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  litellm: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new OpenAIChatCompletionsProvider(apiKey, model, {
      providerName: "litellm",
      providerLabel: "LiteLLM",
      streamTimeoutMs,
      // Replay thinking as `reasoning_content` so DeepSeek-compatible
      // thinking-mode upstreams accept follow-up requests that include tools.
      assistantReasoningField: "reasoning_content",
      ...(baseURL ? { baseURL } : {}),
    }),
  opencode: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new OpenCodeProvider(apiKey, model, {
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  // Keyless openai-compatible endpoints (e.g. LM Studio) ignore the key; the
  // placeholder satisfies the OpenAI SDK, which requires a non-empty key.
  "openai-compatible": ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new OpenAIChatCompletionsProvider(apiKey || "not-needed", model, {
      providerName: "openai-compatible",
      providerLabel: "OpenAI-compatible",
      streamTimeoutMs,
      // Replay thinking as `reasoning_content` so DeepSeek-compatible
      // thinking-mode endpoints accept follow-up requests that include tools.
      assistantReasoningField: "reasoning_content",
      // Custom OpenAI-compatible endpoints may front strict reasoning
      // models (DeepSeek thinking) that 400 on any explicit tool_choice.
      omitToolChoiceWhenReasoning: true,
      ...(baseURL ? { baseURL } : {}),
    }),
  minimax: ({ apiKey, model, streamTimeoutMs }) =>
    new MinimaxProvider(apiKey, model, { streamTimeoutMs }),
  atlascloud: ({ apiKey, model, streamTimeoutMs }) =>
    new AtlasCloudProvider(apiKey, model, { streamTimeoutMs }),
  together: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new TogetherProvider(apiKey, model, {
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  baseten: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new BasetenProvider(apiKey, model, {
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  poolside: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new PoolsideProvider(apiKey, model, {
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
  vellum: ({ apiKey, model, streamTimeoutMs, baseURL }) =>
    new VellumProvider(apiKey, model, {
      streamTimeoutMs,
      ...(baseURL ? { baseURL } : {}),
    }),
};

/**
 * Module-load parity guard. Surfaces a clear startup error if someone adds
 * a catalog entry without a matching factory (or vice versa).
 */
const PROVIDER_CATALOG_FACTORY_PARITY = (() => {
  const catalogIds = new Set(PROVIDER_CATALOG.map((entry) => entry.id));
  const factoryIds = new Set(Object.keys(ADAPTER_FACTORIES));
  const missingFactories = [...catalogIds].filter((id) => !factoryIds.has(id));
  const orphanFactories = [...factoryIds].filter((id) => !catalogIds.has(id));
  if (missingFactories.length > 0 || orphanFactories.length > 0) {
    const parts: string[] = [];
    if (missingFactories.length > 0) {
      parts.push(`missing adapter factories: ${missingFactories.join(", ")}`);
    }
    if (orphanFactories.length > 0) {
      parts.push(`orphan adapter factories: ${orphanFactories.join(", ")}`);
    }
    throw new Error(
      `PROVIDER_CATALOG / ADAPTER_FACTORIES drift: ${parts.join("; ")}`,
    );
  }
  return true;
})();

// Reference the parity guard so unused-variable lint doesn't strip it.
void PROVIDER_CATALOG_FACTORY_PARITY;

/**
 * Build a raw `Provider` instance from a provider id and unified opts.
 *
 * Returns null when no factory exists for the given provider id. The
 * caller is responsible for wrapping (RetryProvider, UsageTrackingProvider).
 */
export function buildProviderAdapter(
  providerId: string,
  opts: AdapterCreateOpts,
): Provider | null {
  const factory = ADAPTER_FACTORIES[providerId];
  if (!factory) {
    return null;
  }
  return factory(opts);
}

/**
 * Build a Provider instance for a given connection + resolved auth.
 *
 * Returns null when the provider/auth combination is not usable
 * (e.g. `none` auth on a keyed provider). The caller decides whether to
 * log a warning or fall back to the global registry.
 */
export function createAdapterFromConnection(
  connection: ProviderConnection,
  resolvedAuth: ResolvedAuth,
  opts: {
    model: string;
    streamTimeoutMs?: number;
    useNativeWebSearch?: boolean;
    /**
     * Effective upstream provider to build the adapter for. Defaults to
     * `connection.provider`. The provider-agnostic Vellum-managed connection
     * passes the resolved profile's provider here, since its own row carries
     * only the `vellum` sentinel.
     */
    provider?: string;
  },
): Provider | null {
  const provider = opts.provider ?? connection.provider;
  const adapter = buildConnectionAdapter(connection, resolvedAuth, opts);
  if (!adapter) {
    return null;
  }

  /**
   * Re-read the managed credential after an auth rejection and rebuild the
   * adapter around it, so a key rotated out-of-band is picked up without a
   * restart. Returns `null` when the store hands back the same credential
   * that just failed — otherwise a proxy 401 from any other cause (platform
   * auth degraded, revoked account) would make every request pay a second
   * doomed upstream call forever.
   */
  function makeCredentialRefresher(): () => Promise<Provider | null> {
    let lastAuth = JSON.stringify(resolvedAuth);
    return async (): Promise<Provider | null> => {
      const refreshedAuth = await resolveAuth(
        effectiveConnectionAuth(connection),
        provider,
        { baseUrl: connection.baseUrl },
      );
      if (!refreshedAuth.ok) {
        return null;
      }
      const nextAuth = JSON.stringify(refreshedAuth.resolved);
      if (nextAuth === lastAuth) {
        return null;
      }
      lastAuth = nextAuth;
      return buildConnectionAdapter(connection, refreshedAuth.resolved, opts);
    };
  }

  /**
   * Resolve the backup-profile route for a request whose primary route just
   * failed with an outage-shaped error, so `RetryProvider` can serve it on a
   * different provider instead of surfacing the outage.
   *
   * The winning profile of the FAILED call is re-resolved from the same
   * inputs `normalizeSendMessageOptions` uses (call site plus the request's
   * own override/seed fields), and its `fallbackProfile` pointer names the
   * backup. The upstream comes from the backup's resolved provider; only the
   * `vellum` routing identity carries no upstream of its own, and there the
   * backup's model determines it.
   *
   * Returns a RAW adapter, exactly like `makeCredentialRefresher` above:
   * `RetryProvider` hands the backup route options it has ALREADY normalized
   * (call site consumed, wire params resolved from the backup profile, usage
   * attribution headers stamped). A second `RetryProvider` in between would
   * re-normalize that call-site-less config and strip those headers, leaving
   * degraded traffic unattributed on the platform's billing events.
   *
   * Never throws: a broken backup lookup must surface the original provider
   * error, not a new one.
   */
  function makeFallbackRouteResolver(): (
    failedOptions: SendMessageOptions | undefined,
  ) => Promise<FallbackRoute | null> {
    return async (failedOptions): Promise<FallbackRoute | null> => {
      const failedConfig = failedOptions?.config;
      const callSite = failedConfig?.callSite;
      if (callSite === undefined) {
        return null;
      }
      try {
        const { llm } = getConfig();
        const winner = selectWinningProfile(callSite, llm, {
          overrideProfile: failedConfig?.overrideProfile,
          forceOverrideProfile: failedConfig?.forceOverrideProfile,
          selectionSeed: failedConfig?.selectionSeed,
          isResolvableProvider: dispatchProviderResolvable,
        });
        const primaryProfile =
          winner.profileName ??
          (winner.source === "default" ? "balanced" : undefined);
        if (
          primaryProfile === undefined ||
          !isDefaultProfileKey(primaryProfile)
        ) {
          return null;
        }
        const expectedFallback = FALLBACK_PROFILE_BY_KEY[primaryProfile];
        if (
          winner.entry?.source !== "managed" ||
          winner.entry.fallbackProfile !== expectedFallback
        ) {
          return null;
        }
        const overrideProfile = expectedFallback;
        // Resolved the provider-aware way the runtime resolver resolves every
        // profile name: the backups are companions of the managed column and
        // must not materialize under a BYOK or ChatGPT default provider.
        const backup = resolveDefaultProfileForProvider(
          llm.profiles,
          overrideProfile,
          llm.defaultProvider ?? null,
        );
        if (backup?.model == null) {
          log.warn(
            { connectionName: connection.name, overrideProfile },
            "Backup profile does not resolve on this default provider; keeping the original error",
          );
          return null;
        }
        const { config: resolvedBackup, profileName: resolvedBackupProfile } =
          resolveCallSiteConfigWithProfile(callSite, llm, {
            overrideProfile,
            forceOverrideProfile: true,
            selectionSeed: failedConfig?.selectionSeed,
            isResolvableProvider: dispatchProviderResolvable,
          });
        if (resolvedBackupProfile !== overrideProfile) {
          log.warn(
            {
              connectionName: connection.name,
              overrideProfile,
              selectedProfile: resolvedBackupProfile,
            },
            "Backup profile is not dispatch-resolvable; keeping the original error",
          );
          return null;
        }
        // The model the adapter serves must be the model the fallback send
        // carries, so it comes from the same forced-profile resolution.
        // This callback authenticates the backup with the managed connection
        // it was built for, so it can only serve a backup that routes through
        // the managed column. Refusing any other route keeps managed billing
        // and credentials from being applied to user-owned traffic.
        // Keyed on the connection, not the provider: a call-site fragment that
        // pins a concrete upstream over a managed winner keeps the managed
        // routing and is stamped with this connection's name by the resolver
        // (see `llm-resolver.ts`), so a concrete `provider` here is still
        // managed traffic. Only a profile that names a different connection,
        // or a concrete provider carrying no managed connection at all (a BYOK
        // winner), routes somewhere this callback cannot authenticate.
        const backupConnection = resolvedBackup.provider_connection;
        const routesThroughThisConnection =
          backupConnection === undefined
            ? resolvedBackup.provider === VELLUM_MANAGED_PROVIDER
            : backupConnection === connection.name;
        if (!routesThroughThisConnection) {
          log.warn(
            {
              connectionName: connection.name,
              overrideProfile,
              backupProvider: resolvedBackup.provider,
              backupConnection,
            },
            "Backup profile routes outside the managed connection; keeping the original error",
          );
          return null;
        }
        // The upstream is the resolved provider, the same way normal dispatch
        // picks it for this connection: `connection-resolution.ts` threads the
        // resolved provider through as `providerOverride` for a `vellum`
        // connection and derives the upstream from the model only when the
        // provider is the routing-identity sentinel (`resolveRoutingIdentity`,
        // and the `isVellum && !expectedProvider` branch). Deriving it from the
        // model here regardless would send a provider-pinned call-site fragment
        // to a different upstream than a primary send of the same resolution,
        // and would refuse a managed model the catalog does not list yet even
        // though normal dispatch serves it. A provider the managed proxy cannot
        // front (a non-routable id, or another routing identity such as
        // `chatgpt`) is refused rather than routed.
        const declaredProvider = resolvedBackup.provider;
        const upstream =
          declaredProvider === VELLUM_MANAGED_PROVIDER
            ? getManagedUpstream(resolvedBackup.model)
            : MANAGED_ROUTABLE_PROVIDERS.has(declaredProvider)
              ? declaredProvider
              : null;
        if (upstream === null) {
          log.warn(
            {
              connectionName: connection.name,
              overrideProfile,
              backupProvider: declaredProvider,
              backupModel: resolvedBackup.model,
            },
            "Backup profile does not resolve to a managed upstream; keeping the original error",
          );
          return null;
        }
        // Re-resolve auth for the BACKUP upstream: the managed proxy's base URL
        // is per-upstream, so the primary's resolved auth cannot be reused.
        const backupAuth = await resolveAuth(
          effectiveConnectionAuth(connection),
          upstream,
          { baseUrl: connection.baseUrl },
        );
        if (!backupAuth.ok) {
          return null;
        }
        const backupAdapter = buildConnectionAdapter(
          connection,
          backupAuth.resolved,
          // `useNativeWebSearch` carries over from the primary: it is a
          // property of this request's web-search config, and every managed
          // backup pin either supports native search or ignores the flag.
          { ...opts, model: resolvedBackup.model, provider: upstream },
        );
        if (backupAdapter === null) {
          return null;
        }
        return {
          provider: backupAdapter,
          overrideProfile,
          // Always true: this callback is wired only on the managed proxy, so
          // the backup route runs through it too and its `X-Vellum-*` billing
          // metadata reaches our own backend, never a third party.
          forwardUsageAttributionHeaders: true,
        };
      } catch (err) {
        log.warn(
          { err, connectionName: connection.name, callSite },
          "Failed to resolve a backup profile route; keeping the original error",
        );
        return null;
      }
    };
  }

  // Usage-attribution headers (`X-Vellum-*`) are only meaningful when the
  // request is routed through the Vellum-managed proxy. They carry billing
  // metadata for our own backend. Forwarding them to a third-party endpoint
  // would leak internal Vellum metadata, so gate on the managed connection
  // identity, the only route that flows through our proxy.
  const isManagedProxy = isVellumManagedConnection(connection);
  const effectiveAuth = effectiveConnectionAuth(connection);
  const tracked = new UsageTrackingProvider(
    new RetryProvider(adapter, {
      forwardUsageAttributionHeaders: isManagedProxy,
      credentialSource: isManagedProxy
        ? "vellum-managed"
        : effectiveAuth.type === "api_key"
          ? "byok"
          : effectiveAuth.type === "oauth_subscription"
            ? "oauth-subscription"
            : effectiveAuth.type === "none"
              ? "no-auth"
              : undefined,
      connectionName: connection.name,
      // Both escalations are managed-route only. A BYOK, oauth-subscription,
      // or no-auth connection must never fall back: the install may hold no
      // credential for the backup profile's provider, and only the managed
      // column carries `fallbackProfile` pointers in the first place.
      ...(isManagedProxy
        ? {
            refreshCredentialProvider: makeCredentialRefresher(),
            resolveFallbackRoute: makeFallbackRouteResolver(),
          }
        : {}),
    }),
  );

  // A credential-backed connection can lose its key between construction and
  // dispatch. Some upstreams answer that with 200 + empty content rather than
  // a 401, which would otherwise land as a blank assistant turn.
  return "credential" in effectiveAuth
    ? new MissingCredentialGuardProvider(tracked, {
        name: connection.name,
        credentialAccount: normalizeCredentialRef(effectiveAuth.credential),
      })
    : tracked;
}

function buildConnectionAdapter(
  connection: ProviderConnection,
  resolvedAuth: ResolvedAuth,
  opts: {
    model: string;
    streamTimeoutMs?: number;
    useNativeWebSearch?: boolean;
    provider?: string;
  },
): Provider | null {
  const provider = opts.provider ?? connection.provider;
  // The connection's own `vellum` column is a routing sentinel. Dispatch
  // only when the caller names an upstream, including Vellum-hosted GPU
  // models whose catalog id is also `vellum`.
  if (
    connection.provider === VELLUM_MANAGED_PROVIDER &&
    opts.provider === undefined
  ) {
    return null;
  }
  const entry = PROVIDER_CATALOG.find((e) => e.id === provider);
  if (!entry) {
    return null;
  }
  const isKeyless = entry.setupMode === "keyless";
  // openai-compatible is dual-mode: local endpoints (LM Studio, vLLM) are
  // keyless, hosted ones keyed — none auth is valid for it.
  const isOpenAICompatible = provider === "openai-compatible";

  // Keyed providers can't operate without a credential.
  if (!isKeyless && !isOpenAICompatible && resolvedAuth.kind === "none") {
    return null;
  }

  const apiKey =
    resolvedAuth.kind === "header"
      ? (resolvedAuth.headers["Authorization"] ?? "").replace(/^Bearer /, "")
      : "";
  const baseURL =
    resolvedAuth.kind === "header" || resolvedAuth.kind === "none"
      ? resolvedAuth.baseUrl
      : undefined;

  const codexSubscription =
    effectiveConnectionAuth(connection).type === "oauth_subscription" &&
    provider === "openai";

  const adapter = buildProviderAdapter(provider, {
    apiKey,
    model: opts.model,
    streamTimeoutMs: opts.streamTimeoutMs ?? 1_800_000,
    baseURL,
    useNativeWebSearch: opts.useNativeWebSearch ?? false,
    codexSubscription,
  });
  if (!adapter) {
    return null;
  }
  return adapter;
}
