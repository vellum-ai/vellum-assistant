import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import {
  resolveUsageAttribution,
  sanitizeUsageMetadataValue,
} from "../usage/attribution.js";
import { ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  computeRetryDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  isRetryableNetworkError,
  sleep,
} from "../util/retry.js";
import {
  isThinkingConfigDisabled,
  normalizeThinkingConfigForWire,
} from "./thinking-config.js";
import {
  isContextOverflowError,
  type Message,
  type Provider,
  type ProviderResponse,
  type SendMessageOptions,
  type ToolDefinition,
} from "./types.js";

const log = getLogger("retry");

const USAGE_ATTRIBUTION_HEADER_NAMES = {
  callSite: "X-Vellum-LLM-Call-Site",
  inferenceProfile: "X-Vellum-Inference-Profile",
  inferenceProfileSource: "X-Vellum-Inference-Profile-Source",
  resolvedProvider: "X-Vellum-Resolved-Provider",
  resolvedModel: "X-Vellum-Resolved-Model",
} as const;

/** Providers that support the `effort` config (extended thinking / reasoning). */
const EFFORT_SUPPORTED_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "fireworks",
]);

/**
 * Providers that consume the `thinking` config. Anthropic uses it directly on
 * the wire; OpenRouter either forwards it to its Anthropic-compatible path or
 * translates it into the unified `reasoning` parameter on OpenAI-compat calls.
 */
const THINKING_AWARE_PROVIDERS = new Set(["anthropic", "openrouter"]);

/**
 * Providers that consume the `verbosity` config. Currently OpenAI (mapped to
 * `text.verbosity` on the Responses API — a GPT-5-series parameter).
 */
const VERBOSITY_SUPPORTED_PROVIDERS = new Set(["openai"]);

/** Patterns that indicate a transient streaming corruption from the SDK. */
const RETRYABLE_STREAM_PATTERNS = [
  "Unexpected event order",
  "stream ended without producing",
  "request ended without sending any chunks",
  "stream has ended, this shouldn't happen",
];

/**
 * Patterns that indicate a transient provider error even when no HTTP status
 * code is available (e.g. overloaded errors delivered as SSE events mid-stream
 * where the initial HTTP response was 200).
 */
const RETRYABLE_PROVIDER_MESSAGE_PATTERNS = [/overloaded/i];

function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.statusCode !== undefined) return false; // has a real HTTP status — not a stream error
  return RETRYABLE_STREAM_PATTERNS.some((p) => error.message.includes(p));
}

function isRetryableProviderMessage(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.statusCode !== undefined) return false; // has a real HTTP status — handled by status check
  return RETRYABLE_PROVIDER_MESSAGE_PATTERNS.some((p) => p.test(error.message));
}

function isRetryableError(error: unknown): boolean {
  // Context overflow is deterministic — retrying the same oversized prompt
  // will never succeed. Short-circuit before the generic 429/5xx check so
  // ContextOverflowError (which extends ProviderError and may carry a 429
  // statusCode on Gemini/Vertex) never triggers exponential backoff.
  if (isContextOverflowError(error)) return false;
  // Daemon/user-initiated aborts are never retryable. The catch-site tags
  // these with `abortReason` exactly when `signal.aborted` was true at the
  // time of failure, so this short-circuits before any message-based pattern
  // matches — which matters because transport-level aborts (retryable) and
  // caller-cancels both surface as "Request was aborted" from the SDK.
  if (error instanceof ProviderError && error.abortReason !== undefined) {
    return false;
  }
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    if (error.statusCode === 429 || error.statusCode >= 500) return true;
  }
  if (isRetryableProviderMessage(error)) return true;
  if (isRetryableStreamError(error)) return true;
  return isRetryableNetworkError(error);
}

/**
 * Normalize per-call options before handing them to the wrapped provider.
 *
 * When `config.callSite` is set, resolves model/maxTokens/effort/speed/
 * verbosity/temperature/thinking via `resolveCallSiteConfig` and writes them
 * into `nextConfig` using the wire-format names that downstream provider
 * clients consume (`max_tokens` snake-case for the token cap; camelCase for
 * the rest, which matches the resolver's shape). Per-call explicit overrides
 * on the original `config` object win over the resolved values, so callers can
 * pin a model or other parameter for a single request. `contextWindow` and
 * `provider` are intentionally excluded from the written fields — they are
 * server-side routing/overflow concerns, not provider request parameters,
 * and forwarding them would leak unknown fields into provider request bodies
 * (strict-schema clients like Anthropic reject the request).
 *
 * Whether or not `callSite` is set, this function applies per-provider
 * stripping (`thinking`/`effort`/`speed`/`verbosity`) based on the wrapped
 * provider's name — agent-loop callers that pre-resolve provider/model still
 * need this stripping so they don't accidentally send Anthropic-only knobs to
 * OpenAI etc.
 */
function normalizeSendMessageOptions(
  providerName: string,
  options?: SendMessageOptions,
  normalizeOptions: { forwardUsageAttributionHeaders?: boolean } = {},
): SendMessageOptions | undefined {
  const config = options?.config;
  if (!config) return options;

  const nextConfig: Record<string, unknown> = { ...config };

  // Internal metadata must be derived here, not accepted from callers, and it
  // must never leak into provider JSON request bodies.
  delete nextConfig.usageAttributionHeaders;
  delete nextConfig.usageTracking;

  // `overrideProfile` is a routing/resolution-time concern (consumed by the
  // resolver below and `CallSiteRoutingProvider`'s provider selection); it is
  // not a wire-format field. Strip unconditionally so it never leaks into
  // provider request bodies even when callers set it without a `callSite`.
  delete nextConfig.overrideProfile;

  if (config.callSite !== undefined) {
    const resolved = resolveCallSiteConfig(config.callSite, getConfig().llm, {
      overrideProfile: config.overrideProfile,
    });
    const attribution = resolveUsageAttribution({
      callSite: config.callSite,
      overrideProfile: config.overrideProfile,
    });

    const explicitModel =
      typeof config.model === "string" && config.model.trim().length > 0
        ? config.model.trim()
        : undefined;

    // Routing key is consumed by the resolver above and must not leak
    // downstream as a wire-format field.
    delete nextConfig.callSite;
    if (normalizeOptions.forwardUsageAttributionHeaders === true) {
      const usageAttributionHeaders = buildUsageAttributionHeaders({
        callSite: attribution.callSite,
        appliedProfile: attribution.appliedProfile,
        profileSource: attribution.profileSource,
        resolvedProvider: attribution.resolvedProvider,
        resolvedModel: attribution.resolvedModel,
      });
      if (Object.keys(usageAttributionHeaders).length > 0) {
        nextConfig.usageAttributionHeaders = usageAttributionHeaders;
      }
    }

    // Apply resolved values, letting per-call explicit fields win where set.
    nextConfig.model = explicitModel ?? resolved.model;
    if (nextConfig.max_tokens === undefined) {
      nextConfig.max_tokens = resolved.maxTokens;
    }
    if (nextConfig.effort === undefined) {
      nextConfig.effort = resolved.effort;
    }
    if (nextConfig.speed === undefined) {
      nextConfig.speed = resolved.speed;
    }
    if (nextConfig.verbosity === undefined) {
      nextConfig.verbosity = resolved.verbosity;
    }
    // `temperature` defaults to `null` in the LLM schema (meaning "no opinion
    // — let the provider pick its own default"). Only forward when the
    // resolved value is an actual number; passing `temperature: null` to
    // provider clients would either be a wire error or silently override
    // sensible provider defaults. Mirrors the legacy non-callSite path which
    // never set `temperature` on `providerConfig`.
    if (
      nextConfig.temperature === undefined &&
      resolved.temperature !== null &&
      resolved.temperature !== undefined
    ) {
      nextConfig.temperature = resolved.temperature;
    }
    if (nextConfig.thinking === undefined) {
      // Convert the schema-shape `{ enabled, streamThinking }` into Anthropic's
      // discriminated wire-format (`{ type: "adaptive" | "disabled" }`).
      // Without this conversion, `thinking` arrives at `AnthropicProvider`
      // with a shape the SDK doesn't accept (`ThinkingConfigParam` requires
      // a `type` discriminator).
      const thinking = normalizeThinkingConfigForWire(resolved.thinking);
      if (thinking !== undefined) {
        nextConfig.thinking = thinking;
      }
    }
    // Forward OpenRouter-only routing preferences so `OpenRouterProvider` can
    // translate `openrouter.only` into the wire-format `provider: { only: [...] }`
    // body field on both the OpenAI-compat and Anthropic-compat endpoints.
    if (
      providerName === "openrouter" &&
      nextConfig.openrouter === undefined &&
      Array.isArray(resolved.openrouter?.only) &&
      resolved.openrouter.only.length > 0
    ) {
      nextConfig.openrouter = { only: resolved.openrouter.only };
    }
    // `contextWindow` and `provider` are server-side concerns, not provider
    // request parameters: effective context is resolved per call site/profile
    // by the agent/conversation path, while `provider` selection is handled by
    // `CallSiteRoutingProvider` upstream. Forwarding them as per-call config
    // leaks unknown fields into provider request bodies — Anthropic (and other
    // strict-schema clients) reject the request with
    // "Extra inputs are not permitted".
  }

  // thinking is Anthropic-specific on the wire; OpenRouter reads it as a
  // signal for its unified reasoning parameter. Strip it for other providers.
  if (
    !THINKING_AWARE_PROVIDERS.has(providerName) &&
    nextConfig.thinking !== undefined
  ) {
    delete nextConfig.thinking;
  }

  // Anthropic (and OpenRouter fronting Anthropic) rejects requests that
  // combine extended thinking with forced tool use (`tool_choice.type` of
  // `"tool"` or `"any"`).  Strip thinking when both are present so the
  // request doesn't fail with a 400 "Thinking may not be enabled when
  // tool_choice forces tool use."  `tool_choice: { type: "auto" }` is
  // compatible with thinking and left untouched.
  //
  // For OpenRouter, only strip when routing to an `anthropic/*` model —
  // non-Anthropic reasoning models (e.g. xAI Grok) translate `thinking`
  // into OpenRouter's `reasoning` parameter via `buildExtraCreateParams`
  // and may support reasoning with forced tool_choice.
  const isThinkingForcedToolConflict = (() => {
    if (nextConfig.thinking == null) return false;
    if (isThinkingConfigDisabled(nextConfig.thinking)) return false;
    const tc = nextConfig.tool_choice as Record<string, unknown> | undefined;
    if (tc == null || (tc.type !== "tool" && tc.type !== "any")) return false;
    if (providerName === "anthropic") return true;
    if (providerName === "openrouter") {
      const model =
        typeof nextConfig.model === "string" ? nextConfig.model : "";
      return model.startsWith("anthropic/");
    }
    return false;
  })();
  if (isThinkingForcedToolConflict) {
    delete nextConfig.thinking;
  }

  // Anthropic (and OpenRouter fronting Anthropic) rejects requests that
  // combine extended thinking with `temperature` ≠ 1. From the API:
  //   "`temperature` may only be set to 1 when thinking is enabled or in
  //   adaptive mode."
  //
  // Defense-in-depth: callers that hardcode a non-default temperature in
  // their per-call config are easy to miss when reviewing — we already had
  // this bug ship in three places (reply suggestions, recall agent
  // round, recall fallback finalize). Drop the offending temperature with
  // a warn log so the request goes through with Anthropic's default
  // (which is 1 in thinking mode anyway). We keep `thinking` rather than
  // `temperature` because thinking is the more deliberate, profile-level
  // choice — silently downgrading reasoning capacity for an unrelated
  // per-call hint would be the worse failure mode.
  //
  // Scope:
  // - Anthropic: always.
  // - OpenRouter fronting `anthropic/*`: same wire constraint applies.
  // - Other providers: not our problem here (e.g. OpenAI reasoning models
  //   strip `temperature` upstream; non-Anthropic OpenRouter reasoning
  //   models don't have this exact constraint).
  const isThinkingTemperatureConflict = (() => {
    if (nextConfig.thinking == null) return false;
    if (isThinkingConfigDisabled(nextConfig.thinking)) return false;
    const temp = nextConfig.temperature;
    if (typeof temp !== "number") return false;
    if (temp === 1) return false;
    if (providerName === "anthropic") return true;
    if (providerName === "openrouter") {
      const model =
        typeof nextConfig.model === "string" ? nextConfig.model : "";
      return model.startsWith("anthropic/");
    }
    return false;
  })();
  if (isThinkingTemperatureConflict) {
    log.warn(
      {
        providerName,
        callSite: config.callSite,
        droppedTemperature: nextConfig.temperature,
      },
      "Dropping `temperature` because thinking is enabled — Anthropic only " +
        "accepts `temperature: 1` (or unset) when thinking/adaptive mode is " +
        "on. Set `thinking: { type: 'disabled' }` on the call site if you " +
        "need a specific temperature.",
    );
    delete nextConfig.temperature;
  }

  // effort is supported by Anthropic, OpenAI, and OpenAI-compatible providers; strip for others
  if (
    !EFFORT_SUPPORTED_PROVIDERS.has(providerName) &&
    nextConfig.effort !== undefined
  ) {
    delete nextConfig.effort;
  }

  // speed (fast mode) is Anthropic-specific; strip for other providers
  if (providerName !== "anthropic" && nextConfig.speed !== undefined) {
    delete nextConfig.speed;
  }

  // verbosity maps to OpenAI's `text.verbosity` (Responses API); strip for
  // providers that don't accept it to avoid leaking unknown fields on the wire.
  if (
    !VERBOSITY_SUPPORTED_PROVIDERS.has(providerName) &&
    nextConfig.verbosity !== undefined
  ) {
    delete nextConfig.verbosity;
  }

  // `openrouter.only` is OpenRouter-specific routing; strip for other
  // providers so strict-schema clients don't see an unknown field.
  if (providerName !== "openrouter" && nextConfig.openrouter !== undefined) {
    delete nextConfig.openrouter;
  }

  return {
    ...options,
    config: nextConfig,
  };
}

function buildUsageAttributionHeaders(input: {
  callSite: string | null;
  appliedProfile: string | null;
  profileSource: string;
  resolvedProvider: string;
  resolvedModel: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.callSite,
    input.callSite,
  );
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.inferenceProfile,
    input.appliedProfile,
  );
  if (input.appliedProfile) {
    addSanitizedHeader(
      headers,
      USAGE_ATTRIBUTION_HEADER_NAMES.inferenceProfileSource,
      input.profileSource,
    );
  }
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.resolvedProvider,
    input.resolvedProvider,
  );
  addSanitizedHeader(
    headers,
    USAGE_ATTRIBUTION_HEADER_NAMES.resolvedModel,
    input.resolvedModel,
  );
  return headers;
}

function addSanitizedHeader(
  headers: Record<string, string>,
  name: string,
  value: unknown,
): void {
  const sanitized = sanitizeUsageMetadataValue(value);
  if (sanitized != null) {
    headers[name] = sanitized;
  }
}

/**
 * `RetryProvider` sets `retriesExhausted = true` on the final thrown error
 * when the retry loop burned through all attempts against a retryable error
 * (transient network, 5xx, provider-overloaded, mid-stream corruption).
 * Consumers can read it via `(err as { retriesExhausted?: boolean })` to
 * suppress Sentry captures for user-network-flap noise — the retry loop
 * already did its job, and no engineering action would change the outcome.
 */
export class RetryProvider implements Provider {
  public readonly name: string;

  get tokenEstimationProvider(): string | undefined {
    return this.inner.tokenEstimationProvider;
  }

  constructor(
    private readonly inner: Provider,
    private readonly options: { forwardUsageAttributionHeaders?: boolean } = {},
  ) {
    this.name = inner.name;
  }

  async sendMessage(
    messages: Message[],
    tools?: ToolDefinition[],
    systemPrompt?: string,
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    let lastError: unknown;
    let didRetry = false;

    const normalizedOptions = normalizeSendMessageOptions(this.name, options, {
      forwardUsageAttributionHeaders:
        this.options.forwardUsageAttributionHeaders === true,
    });

    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        const result = await this.inner.sendMessage(
          messages,
          tools,
          systemPrompt,
          normalizedOptions,
        );
        return result;
      } catch (error) {
        lastError = error;

        if (attempt < DEFAULT_MAX_RETRIES && isRetryableError(error)) {
          // Prefer server-provided Retry-After; fall back to exponential backoff.
          const retryAfter =
            error instanceof ProviderError ? error.retryAfterMs : undefined;
          const MAX_RETRY_DELAY_MS = 60_000; // Cap server-suggested delays at 60s
          const delay = Math.min(
            retryAfter ?? computeRetryDelay(attempt, DEFAULT_BASE_DELAY_MS),
            MAX_RETRY_DELAY_MS,
          );
          const errorType =
            error instanceof ProviderError && error.statusCode === 429
              ? "rate_limit"
              : error instanceof ProviderError &&
                  error.statusCode !== undefined &&
                  error.statusCode >= 500
                ? `server_error_${error.statusCode}`
                : isRetryableProviderMessage(error)
                  ? "provider_overloaded"
                  : isRetryableStreamError(error)
                    ? "stream_corruption"
                    : "network_error";
          log.warn(
            {
              attempt: attempt + 1,
              maxRetries: DEFAULT_MAX_RETRIES,
              delay,
              retryAfterHeader: retryAfter !== undefined,
              errorType,
              provider: this.name,
            },
            "Retrying after transient error",
          );
          didRetry = true;
          await sleep(delay);
          continue;
        }

        // If we exhausted retries on a retryable error, tag the error so
        // downstream consumers (Sentry capture, etc.) can recognize that the
        // retry loop already tried its best. The catch-site logic above only
        // stops retrying when either (a) retries are exhausted, or (b) the
        // error isn't retryable — so we check the retryable predicate here to
        // distinguish the two cases.
        if (didRetry && isRetryableError(error) && error instanceof Error) {
          (error as Error & { retriesExhausted?: boolean }).retriesExhausted =
            true;
        }

        throw error;
      }
    }

    // Unreachable in practice — the loop body always either returns or throws —
    // but mark the last error in case execution somehow falls through.
    if (lastError instanceof Error && isRetryableError(lastError)) {
      (lastError as Error & { retriesExhausted?: boolean }).retriesExhausted =
        true;
    }
    throw lastError;
  }
}
