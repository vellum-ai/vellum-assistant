import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

export interface StandardComputeProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_STANDARD_COMPUTE_BASE_URL = "https://api.stdcmpt.com/v1";
const ROUTED_MODEL_ID = "StandardCompute";

/**
 * Standard Compute serves an OpenAI chat-completions API. The `StandardCompute`
 * model id is routed: the gateway picks from the models the account has
 * enabled, while vendor-prefixed ids pin a single model. Prior thinking is
 * replayed as `reasoning_content` for pinned models, which DeepSeek-style
 * reasoning models expect on follow-up tool turns. It is not replayed for the
 * routed id because a routed conversation can switch models between turns.
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
      assistantReasoningField:
        model === ROUTED_MODEL_ID ? undefined : "reasoning_content",
    });
  }
}
