import OpenAI from "openai";

import { getLogger } from "../../util/logger.js";
import {
  OpenAIChatCompletionsProvider,
  type OpenAIChatCompletionsProviderOptions,
} from "./chat-completions-provider.js";

// Re-export the canonical names so callers that know about the new transport
// class can import directly from `openai/client.js`.
export {
  OpenAIChatCompletionsProvider,
  type OpenAIChatCompletionsProviderOptions,
};

// Backward-compatible aliases: existing code that references `OpenAIProvider`
// or `OpenAICompatibleProviderOptions` from this module keeps compiling
// without any import changes.
export {
  type OpenAIChatCompletionsProviderOptions as OpenAICompatibleProviderOptions,
  OpenAIChatCompletionsProvider as OpenAIProvider,
};

const log = getLogger("openai-client");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Validate an OpenAI API key by making a lightweight GET /v1/models call.
 * Returns `{ valid: true }` on success or `{ valid: false, reason: string }` on failure.
 */
export async function validateOpenAIApiKey(
  apiKey: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const client = new OpenAI({
      apiKey,
      timeout: VALIDATION_TIMEOUT_MS,
      maxRetries: 0,
    });
    await client.models.list();
    return { valid: true };
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401) {
        return { valid: false, reason: "API key is invalid or expired." };
      }
      if (error.status === 403) {
        return {
          valid: false,
          reason: `OpenAI API error (${error.status}): ${error.message}`,
        };
      }
      // Transient errors (429, 5xx, etc.) — validation is inconclusive,
      // allow the key to be stored rather than blocking the user.
      log.warn(
        { status: error.status },
        "OpenAI API returned a transient error during key validation — allowing key storage",
      );
      return { valid: true };
    }
    // Network errors — validation is inconclusive, allow key storage.
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Network error during OpenAI key validation — allowing key storage",
    );
    return { valid: true };
  }
}
