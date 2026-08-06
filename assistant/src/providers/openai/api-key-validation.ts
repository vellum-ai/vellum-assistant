import OpenAI from "openai";

import { getLogger } from "../../util/logger.js";

const log = getLogger("provider-key-validation");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

export type ApiKeyValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

export interface OpenAICompatibleKeyValidation {
  apiKey: string;
  /** The provider's OpenAI-compatible endpoint to list models against. */
  baseURL: string;
  /** Human-readable provider name used in error messages and logs. */
  providerLabel: string;
}

/**
 * Validate an API key by listing models against an OpenAI-compatible
 * endpoint. Definitive auth failures (401/403) reject the key; transient
 * errors (429, 5xx, network) allow the key to be stored so a flaky network
 * doesn't block setup.
 */
export async function validateOpenAICompatibleApiKey({
  apiKey,
  baseURL,
  providerLabel,
}: OpenAICompatibleKeyValidation): Promise<ApiKeyValidationResult> {
  try {
    const client = new OpenAI({
      apiKey,
      baseURL,
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
          reason: `${providerLabel} API error (${error.status}): ${error.message}`,
        };
      }
      // Transient errors (429, 5xx, etc.) — allow the key to be stored.
      log.warn(
        { provider: providerLabel, status: error.status },
        "API returned a transient error during key validation — allowing key",
      );
      return { valid: true };
    }
    // Network errors — allow the key to be stored.
    log.warn(
      {
        provider: providerLabel,
        error: error instanceof Error ? error.message : String(error),
      },
      "Network error during key validation — allowing key",
    );
    return { valid: true };
  }
}
