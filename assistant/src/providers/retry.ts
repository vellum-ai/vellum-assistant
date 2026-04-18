import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { getConfig } from "../config/loader.js";
import { ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  computeRetryDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  isRetryableNetworkError,
  sleep,
} from "../util/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
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

  return {
    ...options,
    config: nextConfig,
  };
}

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
          await sleep(delay);
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }
}
