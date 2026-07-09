/**
 * Helper utilities for provider callsites that should stay decoupled from
 * provider SDK details. Includes provider resolution, timeout utilities,
 * and response extraction helpers.
 */

import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import type { LLMCallSite } from "../config/schemas/llm.js";
import { getDb } from "../persistence/db-connection.js";
import { getLogger } from "../util/logger.js";
import {
  describeSubscriptionModelIncompatibility,
  isConnectionCompatibleWithModel,
} from "./connection-model-compat.js";
import { tryResolveProviderForConnectionName } from "./connection-resolution.js";
import { listConnections } from "./inference/connections.js";
import { initializeProviders, listProviders } from "./registry.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolUseContent,
} from "./types.js";

const log = getLogger("provider-send-message");

export interface ConfiguredProviderResult {
  provider: Provider;
  configuredProviderName: string;
}

/**
 * Cached promise for the lazy initialization path inside
 * `resolveConfiguredProvider`. When multiple concurrent callers enter before
 * providers are initialized, they all await the same promise instead of
 * each triggering a redundant `initializeProviders` call.
 */
let lazyInitPromise: Promise<void> | null = null;

export class CallSiteConfiguredProvider implements Provider {
  public readonly name: string;
  public readonly tokenEstimationProvider?: string;
  // Forward native web-search capability so it survives the wrapper chain
  // (callers like the advisor consult gate on it). Fixed at construction.
  public readonly supportsNativeWebSearch?: boolean;

  constructor(
    private readonly inner: Provider,
    private readonly callSite: LLMCallSite,
    private readonly overrideProfile?: string,
    private readonly forceOverrideProfile?: boolean,
  ) {
    this.name = inner.name;
    this.tokenEstimationProvider = inner.tokenEstimationProvider;
    this.supportsNativeWebSearch = inner.supportsNativeWebSearch;
  }

  supportsNativeWebSearchFor(options?: SendMessageOptions): boolean {
    return this.inner.supportsNativeWebSearchFor
      ? this.inner.supportsNativeWebSearchFor(options)
      : this.inner.supportsNativeWebSearch === true;
  }

  sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    const config = options?.config;
    if (config?.callSite) {
      return this.inner.sendMessage(messages, options);
    }

    return this.inner.sendMessage(messages, {
      ...options,
      config: {
        ...config,
        callSite: this.callSite,
        ...(config?.overrideProfile === undefined &&
        this.overrideProfile !== undefined
          ? { overrideProfile: this.overrideProfile }
          : {}),
        ...(config?.forceOverrideProfile === undefined &&
        this.forceOverrideProfile !== undefined
          ? { forceOverrideProfile: this.forceOverrideProfile }
          : {}),
      },
    });
  }
}

/**
 * Resolve the configured provider with full selection metadata.
 * If providers haven't been initialized yet (e.g. non-daemon code paths),
 * performs a one-shot `initializeProviders(getConfig())`.
 *
 * The provider name is sourced from
 * `resolveCallSiteConfig(callSite, config.llm, opts).provider` — i.e. the
 * unified `llm` block drives selection. The `callSite` argument is required
 * so the resolver can layer per-call-site overrides; pass the closest
 * matching call-site identifier from `LLMCallSiteEnum` when adding a new
 * caller. Pass `opts.overrideProfile` to apply a per-call ad-hoc profile
 * override (e.g. a per-conversation pinned profile) on top of any workspace
 * `activeProfile`. Pass `opts.forceOverrideProfile` to float that override
 * above the call-site layers (named site profile + call-site override) for
 * non-main-agent call sites — see `ResolveCallSiteOpts.forceOverrideProfile`.
 *
 * Returns `null` when no providers are available at all.
 */
export async function resolveConfiguredProvider(
  callSite: LLMCallSite,
  opts: { overrideProfile?: string; forceOverrideProfile?: boolean } = {},
): Promise<ConfiguredProviderResult | null> {
  const config = getConfig();

  if (listProviders().length === 0) {
    if (!lazyInitPromise) {
      lazyInitPromise = initializeProviders(config).finally(() => {
        lazyInitPromise = null;
      });
    }
    try {
      await lazyInitPromise;
    } catch {
      return null;
    }
  }

  const resolved = resolveCallSiteConfig(callSite, config.llm, opts);
  const inferenceProvider = resolved.provider;
  let connectionName = resolved.provider_connection;

  // Connection-aware path: every dispatch goes through `provider_connection`.
  // The boot-time backfill ensures every profile has one in production.
  // When unset (profile set provider without a connection, test envs that
  // skip backfill, freshly-installed configs not yet backfilled, or users
  // who manually cleared the field), try to auto-resolve from the provider
  // before falling back to null.
  if (!connectionName) {
    if (inferenceProvider) {
      try {
        const candidates = listConnections(getDb(), {
          provider: inferenceProvider,
        });
        const active = candidates.find((c) =>
          isConnectionCompatibleWithModel(c, resolved.model),
        );
        if (active) {
          connectionName = active.name;
        } else {
          const incompatMsg = describeSubscriptionModelIncompatibility(
            candidates,
            resolved.model,
          );
          if (incompatMsg) {
            log.warn(
              { callSite, inferenceProvider, model: resolved.model },
              incompatMsg,
            );
          }
        }
      } catch {
        // DB not available — fall through to the existing null-return path.
      }
    }
    if (!connectionName) {
      log.warn(
        {
          callSite,
          inferenceProvider,
          model: resolved.model,
          reason: "no_connection",
        },
        "resolveCallSiteConfig yielded no provider_connection — returning null so callsite can fall back",
      );
      return null;
    }
  }

  const connectionProvider = await tryResolveProviderForConnectionName(
    connectionName,
    config,
    inferenceProvider,
    resolved.model,
  );
  if (!connectionProvider) {
    // Soft credential failure — the connection resolved to no usable
    // adapter (credential missing, transient auth failure, etc.).
    // Callers handle null as "no provider available" rather than crash;
    // the structured warn keeps every silent degradation observable.
    log.warn(
      {
        callSite,
        connectionName,
        inferenceProvider,
        model: resolved.model,
        reason: "credential_unavailable",
      },
      "Connection resolved to no usable adapter — returning null so the call site can degrade",
    );
    return null;
  }
  return {
    provider: new CallSiteConfiguredProvider(
      connectionProvider,
      callSite,
      opts.overrideProfile,
      opts.forceOverrideProfile,
    ),
    configuredProviderName: inferenceProvider,
  };
}

/**
 * Resolve the configured provider through the registry.
 * Thin wrapper around `resolveConfiguredProvider()` for callsites
 * that only need the Provider instance.
 *
 * `callSite` is required — see `resolveConfiguredProvider`. Returns `null`
 * when no providers are available.
 */
export async function getConfiguredProvider(
  callSite: LLMCallSite,
  opts: { overrideProfile?: string; forceOverrideProfile?: boolean } = {},
): Promise<Provider | null> {
  const result = await resolveConfiguredProvider(callSite, opts);
  return result?.provider ?? null;
}

/**
 * Create an AbortSignal that fires after `ms` milliseconds.
 * Returns the signal and a cleanup function to clear the timer.
 */
export function createTimeout(ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

/**
 * Extract the first text block's text from a ProviderResponse.
 * Returns empty string if no text block is found.
 */
export function extractText(response: ProviderResponse): string {
  const block = response.content.find(
    (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
  );
  return block?.text?.trim() ?? "";
}

/**
 * Extract all text blocks from a ProviderResponse and join them.
 */
export function extractAllText(response: ProviderResponse): string {
  const parts = response.content
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text);
  // Join consecutive text blocks with a space, but skip the separator when
  // either side already has whitespace (avoids double-spacing).
  let result = parts[0] ?? "";
  for (let i = 1; i < parts.length; i++) {
    const prev = result[result.length - 1];
    const next = parts[i][0];
    if (
      prev &&
      next &&
      prev !== " " &&
      prev !== "\n" &&
      prev !== "\t" &&
      next !== " " &&
      next !== "\n" &&
      next !== "\t"
    ) {
      result += " ";
    }
    result += parts[i];
  }
  return result;
}

/**
 * Find the first tool_use block in a ProviderResponse.
 */
export function extractToolUse(
  response: ProviderResponse,
): ToolUseContent | undefined {
  return response.content.find(
    (b): b is ToolUseContent => b.type === "tool_use",
  );
}

/**
 * Build a single user message in the provider Message format.
 */
export function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}
