import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";
import {
  isThinkingConfigDisabled,
  isThinkingConfigEnabled,
} from "../thinking-config.js";
import type { SendMessageOptions } from "../types.js";

export interface DeepSeekProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
}

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export class DeepSeekProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: DeepSeekProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_DEEPSEEK_BASE_URL,
      providerName: "deepseek",
      providerLabel: "DeepSeek",
      streamTimeoutMs: options.streamTimeoutMs,
    });
  }

  protected override buildExtraCreateParams(
    options?: SendMessageOptions,
  ): Record<string, unknown> {
    const config = options?.config as Record<string, unknown> | undefined;
    const thinking = config?.thinking;

    if (thinking === undefined) return {};

    if (isThinkingConfigDisabled(thinking)) {
      return { thinking: { type: "disabled" } };
    }
    if (isThinkingConfigEnabled(thinking)) {
      return { thinking: { type: "enabled" } };
    }

    return {};
  }
}
