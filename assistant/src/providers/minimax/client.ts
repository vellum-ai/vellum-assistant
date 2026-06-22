import OpenAI from "openai";

import { getLogger } from "../../util/logger.js";
import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

const log = getLogger("minimax-client");

/** Validation-specific timeout (10s) so a stalled network doesn't block key submission. */
const VALIDATION_TIMEOUT_MS = 10_000;

export interface MinimaxProviderOptions {
  apiKey?: string;
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/v1";
const FALLBACK_MINIMAX_BASE_URL = "https://api.minimaxi.com/v1";

/**
 * Validate a MiniMax API key by testing against the default URL first,
 * then the fallback URL if the default fails. Both URLs must fail with
 * definitive errors (401/403) for the key to be rejected. Transient errors
 * (429, 5xx, network) allow the key to be stored.
 */
export async function validateMinimaxApiKey(
  apiKey: string,
): Promise<{ valid: true } | { valid: false; reason: string }> {
  // Try default URL first
  const defaultResult = await tryValidate(apiKey, DEFAULT_MINIMAX_BASE_URL);
  if (defaultResult.valid && !defaultResult.transient) {
    return { valid: true };
  }

  // Default failed or was transient — try fallback URL
  const fallbackResult = await tryValidate(apiKey, FALLBACK_MINIMAX_BASE_URL);
  if (fallbackResult.valid) {
    return { valid: true };
  }

  // Both URLs failed definitively — reject the key
  return { valid: false, reason: fallbackResult.reason };
}

async function tryValidate(
  apiKey: string,
  baseURL: string,
): Promise<
  | { valid: true; transient: false }
  | { valid: true; transient: true }
  | { valid: false; reason: string }
> {
  try {
    const client = new OpenAI({
      apiKey,
      baseURL,
      timeout: VALIDATION_TIMEOUT_MS,
      maxRetries: 0,
    });
    await client.models.list();
    return { valid: true, transient: false };
  } catch (error) {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401) {
        return { valid: false, reason: "API key is invalid or expired." };
      }
      if (error.status === 403) {
        return {
          valid: false,
          reason: `MiniMax API error (${error.status}): ${error.message}`,
        };
      }
      // Transient errors (429, 5xx, etc.) — try the other URL
      log.warn(
        { status: error.status, baseURL },
        "MiniMax API returned a transient error during key validation — trying fallback",
      );
      return { valid: true, transient: true };
    }
    // Network errors — try the other URL
    log.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        baseURL,
      },
      "Network error during MiniMax key validation — trying fallback",
    );
    return { valid: true, transient: true };
  }
}

export class MinimaxProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: MinimaxProviderOptions = {},
  ) {
    const baseURL = options.baseURL?.trim() || DEFAULT_MINIMAX_BASE_URL;
    super(apiKey, model, {
      baseURL,
      providerName: "minimax",
      providerLabel: "MiniMax",
      streamTimeoutMs: options.streamTimeoutMs,
      // Without reasoning_split, MiniMax embeds reasoning in `content`
      // wrapped in <think>...</think> tags (and also mirrors it into
      // reasoning deltas), so raw tags leak into user-visible text. With it,
      // reasoning arrives only via `reasoning_content`/`reasoning_details`,
      // which the base provider already parses into thinking blocks.
      extraCreateParams: { reasoning_split: true },
      // MiniMax models reason between tool calls (interleaved thinking) and
      // expect prior-turn reasoning replayed on multi-turn requests.
      assistantReasoningField: "reasoning_content",
    });
  }
}
