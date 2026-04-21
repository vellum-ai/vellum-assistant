import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  abortableSleep,
  computeRetryDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  isRetryableNetworkError,
} from "../util/retry.js";
import {
  isContextOverflowError,
  type Message,
  type Provider,
  type ProviderResponse,
  type SendMessageOptions,
  type ToolDefinition,
} from "./types.js";

const log = getLogger("retry");

/** Providers that support the `effort` config (extended thinking / reasoning). */
const EFFORT_SUPPORTED_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "fireworks",
]);

/**
 * Providers that consume the `thinking` config. Anthropic uses it directly on
 * the wire; OpenRouter translates it into its unified `reasoning` parameter so
 * users can control extended thinking on Anthropic models served via OpenRouter.
 */
const THINKING_AWARE_PROVIDERS = new Set(["anthropic", "openrouter"]);

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
 * temperature/thinking via `resolveCallSiteConfig` and writes them into
 * `nextConfig` using the wire-format names that downstream provider clients
 * consume (`max_tokens` snake-case for the token cap; camelCase for the rest,
 * which matches the resolver's shape). Per-call explicit overrides on the
 * original `config` object win over the resolved values, so callers can pin
 * a model or other parameter for a single request. `contextWindow` and
 * `provider` are intentionally excluded from the written fields — they are
 * server-side routing/overflow concerns, not provider request parameters,
 * and forwarding them would leak unknown fields into provider request bodies
 * (strict-schema clients like Anthropic reject the request).
 *
 * Whether or not `callSite` is set, this function applies per-provider
 * stripping (`thinking`/`effort`/`speed`) based on the wrapped provider's
 * name — agent-loop callers that pre-resolve provider/model still need this
 * stripping so they don't accidentally send Anthropic-only knobs to OpenAI
 * etc.
 */
function normalizeSendMessageOptions(
  providerName: string,
  options?: SendMessageOptions,
): SendMessageOptions | undefined {
  const config = options?.config;
  if (!config) return options;

  const nextConfig: Record<string, unknown> = { ...config };

  if (config.callSite !== undefined) {
    const resolved = resolveCallSiteConfig(config.callSite, getConfig().llm);

    const explicitModel =
      typeof config.model === "string" && config.model.trim().length > 0
        ? config.model.trim()
        : undefined;

    // Routing key is consumed by the RetryProvider layer and must not leak
    // downstream.
    delete nextConfig.callSite;

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
      // Convert the schema-shape `{ enabled, streamThinking }` into the
      // Anthropic wire-format `{ type: "adaptive" }` (or omit when disabled).
      // Mirrors the non-callSite path in `agent/loop.ts` which sets
      // `providerConfig.thinking = { type: "adaptive" }` only when enabled.
      // Without this conversion, `thinking` arrives at `AnthropicProvider`
      // with a shape the SDK doesn't accept (`ThinkingConfigParam` requires
      // a `type` discriminator), and OpenRouter's truthy check would treat
      // a disabled config as enabled.
      if (resolved.thinking?.enabled === true) {
        nextConfig.thinking = { type: "adaptive" };
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
    // request parameters: `contextWindow` is consumed by the agent loop's
    // overflow recovery and the conversation manager directly from
    // `config.llm.default.contextWindow.*`; `provider` selection is handled
    // by `CallSiteRoutingProvider` upstream. Forwarding them as per-call
    // config leaks unknown fields into provider request bodies — Anthropic
    // (and other strict-schema clients) reject the request with
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

  constructor(private readonly inner: Provider) {
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

    const normalizedOptions = normalizeSendMessageOptions(this.name, options);

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
          normalizedOptions?.onRetry?.({
            attempt: attempt + 1,
            maxRetries: DEFAULT_MAX_RETRIES,
            delayMs: delay,
            errorType,
          });
          didRetry = true;
          await abortableSleep(delay, normalizedOptions?.signal);
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
