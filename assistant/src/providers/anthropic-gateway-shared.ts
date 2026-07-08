// Shared helpers for OpenAI-compat gateway providers (OpenRouter, Vercel AI
// Gateway) that delegate `anthropic/*` models to the gateway's
// Anthropic-compatible Messages API.

import { ProviderError } from "../util/errors.js";
import { ContextOverflowError, isContextOverflowError } from "./types.js";

// Models prefixed `anthropic/` are routed through the gateway's
// Anthropic-compatible Messages API at `<root>/v1/messages` so that
// Anthropic-native features — extended thinking, prompt caching, cache TTL,
// output_config — work without lossy translation through the OpenAI chat
// completions compatibility layer.
export function isAnthropicModel(model: string): boolean {
  return model.startsWith("anthropic/");
}

// Gateways that front Anthropic's Messages API for anthropic/* models.
const ANTHROPIC_DELEGATING_GATEWAYS = new Set([
  "openrouter",
  "vercel-ai-gateway",
]);

export function isAnthropicDelegatingGateway(provider: string): boolean {
  return ANTHROPIC_DELEGATING_GATEWAYS.has(provider);
}

// The Anthropic SDK appends `/v1/messages` to its configured baseURL, so we
// strip the trailing `/v1` segment from the OpenAI-compat base before handing
// it to the SDK.
export function toAnthropicMessagesBaseURL(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, "");
}

// Re-tag delegate-thrown errors so the outer provider name matches the
// configured provider. This keeps downstream error reporting and metrics
// attribution accurate, while preserving the actualTokens/maxTokens extracted
// by the delegate.
export function retagDelegateError(
  error: unknown,
  providerName: string,
): never {
  if (isContextOverflowError(error) && error.provider !== providerName) {
    throw new ContextOverflowError(error.message, providerName, {
      actualTokens: error.actualTokens,
      maxTokens: error.maxTokens,
      statusCode: error.statusCode,
      cause: error,
    });
  }
  if (error instanceof ProviderError && error.provider !== providerName) {
    throw new ProviderError(error.message, providerName, error.statusCode, {
      cause: error.cause ?? error,
      retryAfterMs: error.retryAfterMs,
      abortReason: error.abortReason,
    });
  }
  throw error;
}
