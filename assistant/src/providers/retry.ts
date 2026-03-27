import { ProviderError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  computeRetryDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  isRetryableNetworkError,
  sleep,
} from "../util/retry.js";
import { isModelIntent, resolveModelIntent } from "./model-intents.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "./types.js";

const log = getLogger("retry");

/** Providers that support the `effort` config (extended thinking / reasoning). */
const EFFORT_SUPPORTED_PROVIDERS = new Set(["anthropic", "openai"]);

/** Patterns that indicate a transient streaming corruption from the SDK. */
const RETRYABLE_STREAM_PATTERNS = [
  "Unexpected event order",
  "stream ended without producing",
  "request ended without sending any chunks",
  "stream has ended, this shouldn't happen",
];

function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.statusCode !== undefined) return false; // has a real HTTP status — not a stream error
  return RETRYABLE_STREAM_PATTERNS.some((p) => error.message.includes(p));
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof ProviderError && error.statusCode !== undefined) {
    if (error.statusCode === 429 || error.statusCode >= 500) return true;
  }
  if (isRetryableStreamError(error)) return true;
  return isRetryableNetworkError(error);
}

function normalizeSendMessageOptions(
  providerName: string,
  options?: SendMessageOptions,
): SendMessageOptions | undefined {
  const config = options?.config;
  if (!config) return options;

  const explicitModel =
    typeof config.model === "string" && config.model.trim().length > 0
      ? config.model.trim()
      : undefined;
  const intent = isModelIntent(config.modelIntent)
    ? config.modelIntent
    : undefined;
  const hasIntent = config.modelIntent !== undefined;

  const needsThinkingStrip =
    providerName !== "anthropic" && config.thinking !== undefined;
  const needsEffortStrip =
    !EFFORT_SUPPORTED_PROVIDERS.has(providerName) && config.effort !== undefined;

  if (
    !hasIntent &&
    explicitModel === config.model &&
    !needsThinkingStrip &&
    !needsEffortStrip
  ) {
    return options;
  }

  const nextConfig: Record<string, unknown> = { ...config };
  delete nextConfig.modelIntent;

  // thinking is Anthropic-specific; strip it for other providers
  if (providerName !== "anthropic" && nextConfig.thinking !== undefined) {
    delete nextConfig.thinking;
  }

  // effort is supported by Anthropic and OpenAI; strip it for other providers
  if (
    !EFFORT_SUPPORTED_PROVIDERS.has(providerName) &&
    nextConfig.effort !== undefined
  ) {
    delete nextConfig.effort;
  }

  if (explicitModel) {
    nextConfig.model = explicitModel;
  } else if (intent) {
    nextConfig.model = resolveModelIntent(providerName, intent);
  } else {
    delete nextConfig.model;
  }

  return {
    ...options,
    config: nextConfig,
  };
}

export class RetryProvider implements Provider {
  public readonly name: string;

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
