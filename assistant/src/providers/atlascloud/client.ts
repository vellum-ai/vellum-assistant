import OpenAI from "openai";

import { getLogger } from "../../util/logger.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

const log = getLogger("atlascloud-client");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

export interface AtlasCloudProviderOptions {
  apiKey?: string;
  streamTimeoutMs?: number;
}

/**
 * Atlas Cloud exposes a single OpenAI-compatible endpoint. Unlike MiniMax it
 * has no regional fallback host, so validation targets this URL only.
 */
const DEFAULT_ATLASCLOUD_BASE_URL = "https://api.atlascloud.ai/v1";

/**
 * Validate an Atlas Cloud API key by listing models against the OpenAI-compatible
 * endpoint. Definitive auth failures (401/403) reject the key; transient errors
 * (429, 5xx, network) allow the key to be stored so a flaky network doesn't
 * block setup.
 */
export async function validateAtlasCloudApiKey(
  apiKey: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  try {
    const client = new OpenAI({
      apiKey,
      baseURL: DEFAULT_ATLASCLOUD_BASE_URL,
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
          reason: `Atlas Cloud API error (${error.status}): ${error.message}`,
        };
      }
      // Transient errors (429, 5xx, etc.) — allow the key to be stored.
      log.warn(
        { status: error.status },
        "Atlas Cloud API returned a transient error during key validation — allowing key",
      );
      return { valid: true };
    }
    // Network errors — allow the key to be stored.
    log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Network error during Atlas Cloud key validation — allowing key",
    );
    return { valid: true };
  }
}

export class AtlasCloudProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: AtlasCloudProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: DEFAULT_ATLASCLOUD_BASE_URL,
      providerName: "atlascloud",
      providerLabel: "Atlas Cloud",
      streamTimeoutMs: options.streamTimeoutMs,
      // Atlas Cloud hosts reasoning models (e.g. DeepSeek) that emit chain of
      // thought via `reasoning_content` rather than inline `<think>` tags. The
      // base provider parses this field into thinking blocks and replays it on
      // multi-turn requests.
      assistantReasoningField: "reasoning_content",
    });
  }
}
