import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { type LLMConfig } from "../config/schemas/llm.js";
import { getProviderKeyAsync } from "../security/secure-keys.js";
import { ProviderNotConfiguredError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  buildProviderAdapter,
  createAdapterFromConnection,
} from "./inference/adapter-factory.js";
// ---------------------------------------------------------------------------
// Per-connection provider cache (mix-and-match support)
// ---------------------------------------------------------------------------
import type { ProviderConnection } from "./inference/auth.js";
import { resolveAuth } from "./inference/resolve-auth.js";
import { isModelInCatalog, PROVIDER_CATALOG } from "./model-catalog.js";
import { getProviderDefaultModel } from "./model-intents.js";
import {
  buildManagedBaseUrl,
  resolveManagedProxyContext,
} from "./platform-proxy/context.js";
import { RetryProvider } from "./retry.js";
import type { Provider } from "./types.js";
import { UsageTrackingProvider } from "./usage-tracking.js";

const log = getLogger("provider-registry");

const providers = new Map<string, Provider>();
const routingSources = new Map<string, "user-key" | "managed-proxy">();

/** Per-connection provider cache, keyed by connection name. */
const connectionProviders = new Map<string, Provider>();

function registerProvider(name: string, provider: Provider): void {
  providers.set(name, new UsageTrackingProvider(provider));
}

export function getProvider(name: string): Provider {
  const provider = providers.get(name);
  if (!provider) {
    throw new ProviderNotConfiguredError(name, listProviders());
  }
  return provider;
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}

export function getProviderRoutingSource(
  name: string,
): "user-key" | "managed-proxy" | undefined {
  return routingSources.get(name);
}

export interface ProvidersConfig {
  services: {
    inference: Record<string, never>;
    "image-generation": {
      mode: "managed" | "your-own";
      provider: string;
      model: string;
    };
    "web-search": {
      mode: "managed" | "your-own";
      provider: string;
    };
  };
  llm: LLMConfig;
  timeouts?: { providerStreamTimeoutSec?: number };
}

function resolveModel(config: ProvidersConfig, providerName: string): string {
  const resolved = resolveCallSiteConfig("mainAgent", config.llm);
  const inferenceProvider = resolved.provider;
  const inferenceModel = resolved.model;
  if (inferenceProvider === providerName) {
    if (
      providerName !== "anthropic" &&
      isModelInCatalog("anthropic", inferenceModel)
    ) {
      return getProviderDefaultModel(providerName);
    }
    return inferenceModel;
  }
  return getProviderDefaultModel(providerName);
}

/**
 * Resolve provider credentials. User key takes precedence; managed proxy is
 * used as a fallback when platform prerequisites are available.
 *
 * The routing decision is now derived from credential availability rather than
 * the removed `services.inference.mode` config field.
 */
async function resolveProviderCredentials(providerName: string): Promise<{
  apiKey: string;
  baseURL?: string;
  source: "user-key" | "managed-proxy";
} | null> {
  const userKey = await getProviderKeyAsync(providerName);
  if (userKey) {
    return { apiKey: userKey, source: "user-key" };
  }
  const managedBaseUrl = await buildManagedBaseUrl(providerName);
  if (managedBaseUrl) {
    const ctx = await resolveManagedProxyContext();
    return {
      apiKey: ctx.assistantApiKey,
      baseURL: managedBaseUrl,
      source: "managed-proxy",
    };
  }
  return null;
}

export async function initializeProviders(
  config: ProvidersConfig,
): Promise<void> {
  providers.clear();
  routingSources.clear();
  connectionProviders.clear();

  const streamTimeoutMs =
    (config.timeouts?.providerStreamTimeoutSec ?? 1800) * 1000;
  const useNativeWebSearch =
    config.services["web-search"].provider === "inference-provider-native";
  const mainAgentProvider = resolveCallSiteConfig(
    "mainAgent",
    config.llm,
  ).provider;

  for (const entry of PROVIDER_CATALOG) {
    const isKeyless = entry.setupMode === "keyless";

    // Credential resolution: user key first, managed proxy second. Keyless
    // providers (e.g. ollama) skip both — they only need to be configured as
    // the mainAgent provider, or have a key present (rare keyed-mode), to
    // boot. Boot order matches catalog order; routingSources tracks which
    // credential surface served each provider.
    let apiKey = "";
    let baseURL: string | undefined;
    let source: "user-key" | "managed-proxy" = "user-key";
    if (isKeyless) {
      const key = await getProviderKeyAsync(entry.id);
      const isConfiguredMainAgent = mainAgentProvider === entry.id;
      if (!key && !isConfiguredMainAgent) continue;
      apiKey = key ?? "";
    } else {
      const creds = await resolveProviderCredentials(entry.id);
      if (!creds) continue;
      apiKey = creds.apiKey;
      baseURL = creds.baseURL;
      source = creds.source;
    }

    const model = resolveModel(config, entry.id);
    const adapter = buildProviderAdapter(entry.id, {
      apiKey,
      model,
      streamTimeoutMs,
      baseURL,
      useNativeWebSearch,
    });
    if (!adapter) {
      // Catalog declares a provider with no factory entry. The parity guard
      // in adapter-factory.ts catches this at module load, so reaching here
      // means a future refactor regressed the invariant.
      log.error(
        { providerId: entry.id },
        "Catalog entry has no adapter factory — skipping",
      );
      continue;
    }

    registerProvider(
      entry.id,
      new RetryProvider(adapter, {
        forwardUsageAttributionHeaders: source === "managed-proxy",
      }),
    );
    routingSources.set(entry.id, source);
  }
}

// ---------------------------------------------------------------------------
// Per-connection provider resolution (mix-and-match support)
// ---------------------------------------------------------------------------

/**
 * Resolve a provider instance for a named `provider_connection`.
 *
 * Results are cached in `connectionProviders` for the lifetime of the
 * current `initializeProviders` invocation (cleared on next boot). This
 * prevents redundant vault reads for repeated calls to the same connection.
 *
 * Returns null when:
 *   - The connection doesn't exist in the DB
 *   - Auth resolution fails (missing credential, platform unavailable, v2 type)
 *   - The provider/auth combination yields no usable adapter
 */
export async function resolveProviderFromConnection(
  connection: ProviderConnection,
  config: ProvidersConfig,
): Promise<Provider | null> {
  const cached = connectionProviders.get(connection.name);
  if (cached) return cached;

  const authResult = await resolveAuth(connection.auth, connection.provider);
  if (!authResult.ok) {
    const err = authResult.error;
    if (err.code === "not_implemented") {
      log.warn(
        { connectionName: connection.name, authType: err.authType },
        `Auth type '${err.authType}' is not yet implemented (v2). ` +
          "Update the connection to use 'api_key', 'platform', or 'none'.",
      );
    } else if (err.code === "credential_not_found") {
      log.warn(
        { connectionName: connection.name, credential: err.credential },
        `Credential '${err.credential}' not found in vault for connection '${connection.name}'.`,
      );
    } else {
      log.warn(
        { connectionName: connection.name },
        `Platform auth unavailable for connection '${connection.name}'.`,
      );
    }
    return null;
  }

  const streamTimeoutMs =
    (config.timeouts?.providerStreamTimeoutSec ?? 1800) * 1000;
  const useNativeWebSearch =
    config.services["web-search"].provider === "inference-provider-native";
  const model = resolveModel(config, connection.provider);

  const provider = createAdapterFromConnection(
    connection,
    authResult.resolved,
    {
      model,
      streamTimeoutMs,
      useNativeWebSearch,
    },
  );

  if (provider) {
    connectionProviders.set(connection.name, provider);
  }

  return provider;
}

/** Clear per-connection provider cache (called by initializeProviders on boot). */
export function clearConnectionProviderCache(): void {
  connectionProviders.clear();
}
