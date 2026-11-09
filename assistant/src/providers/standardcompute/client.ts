import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface StandardComputeProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_STANDARD_COMPUTE_BASE_URL = "https://api.stdcmpt.com/v1";

/**
 * Standard Compute serves an OpenAI chat-completions API. The `StandardCompute`
 * model id is routed: the gateway picks from the models the account has
 * enabled, while vendor-prefixed ids pin a single model. Prior thinking is not
 * replayed because a routed conversation can switch models between turns.
 */
export class StandardComputeProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: StandardComputeProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_STANDARD_COMPUTE_BASE_URL,
      providerName: "standardcompute",
      providerLabel: "Standard Compute",
      streamTimeoutMs: options.streamTimeoutMs,
    });
  }
}
